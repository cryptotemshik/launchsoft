/**
 * The reading half of the drop scanner.
 *
 * Two round trips do the discovery: one `eth_getLogs` for every public stage
 * configured in the window, and one Multicall3 batch to put names and supply
 * on the ones that survive the time filter. Measured against the live chain:
 * 72 hours of history is 7,958 events across 2,437 collections in a single
 * 2.7-second request, and 120 collections enrich in 1.1 seconds.
 *
 * The bundle this grew out of proxied the chain through Cloudflare Functions
 * with a keyed endpoint, because Cloudflare's egress gets rate-limited by every
 * free Robinhood endpoint. None of that applies here: this runs on the box next
 * to the sequencer, through the same fallback read client — the user's own
 * Alchemy key first, the public node behind it — that every other read uses.
 * So the proxy layer, its secret, and its explorer fallback are all dropped.
 */
import { parseAbiItem, type PublicClient } from "viem";
import { isRateLimit } from "../lib/rpcRead";
import {
  latestPerContract,
  PUBLIC_DROP_UPDATED,
  SEADROP,
  type ScannedDrop,
} from "../lib/dropScan";
import type { MintEvent } from "../lib/mintPulse";

const EVENT = parseAbiItem(PUBLIC_DROP_UPDATED);

/**
 * SeaDrop announces every mint, so one topic covers the whole chain.
 */
export const SEADROP_MINT =
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)" as const;

const MINT_EVENT = parseAbiItem(SEADROP_MINT);

/** Multicall3, at the same address on every chain that has it. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const COLLECTION_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Asked a second way, because not every collection here answers
  // totalSupply() at all — one was seen reverting on it with 426 of 3000
  // minted. getMintStats is part of the SeaDrop interface all of them
  // implement, so it answers where the other does not.
  {
    type: "function",
    name: "getMintStats",
    stateMutability: "view",
    inputs: [{ name: "minter", type: "address" }],
    outputs: [
      { name: "minterNumMinted", type: "uint256" },
      { name: "currentTotalSupply", type: "uint256" },
      { name: "maxSupply", type: "uint256" },
    ],
  },
  // Two more fields in the same batch, so the risk score costs no extra round
  // trip: where the art is served from, and whether it was committed to.
  { type: "function", name: "baseURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "provenanceHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  // Who launched it, so serial issuance from one wallet is visible.
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * The middle word of getMintStats — how many exist — for a collection whose
 * totalSupply reverted. Undefined when that call failed too, which keeps the
 * column honestly empty rather than claiming a zero nobody reported.
 */
function mintedFromStats(r: { status: string; result?: unknown } | undefined): number | undefined {
  if (r?.status !== "success") return undefined;
  const stats = r.result as readonly bigint[] | undefined;
  if (!stats || stats.length < 2) return undefined;
  const v = Number(stats[1]);
  return Number.isFinite(v) ? v : undefined;
}

/** How many calls each collection contributes to a multicall batch. */
const CALLS_PER_COLLECTION = 7;

/** Below this, splitting costs more round trips than it saves. */
const MIN_SPAN = 5_000n;
/** How many times one range may be waited out before giving up on it. */
const THROTTLE_RETRIES = 4;

/**
 * "Your range is too wide" — the only error splitting actually answers.
 *
 * Rate limiting is deliberately not in this list, and used to be. The two read
 * alike and need opposite responses: halving a throttled range turns one
 * request into two, and each of those gets throttled and halved again, so the
 * endpoint's request to slow down produces a burst four levels deep. That is
 * exactly what a 24-hour scan against the public RPC did — twenty-five
 * getLogs in one batch, every one of them a 429.
 */
function tooWide(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("block range") ||
    msg.includes("range is too large") ||
    msg.includes("too many") ||
    msg.includes("exceeds") ||
    msg.includes("limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DropLog = {
  blockNumber: bigint;
  args: {
    nftContract?: `0x${string}`;
    publicDrop?: {
      mintPrice: bigint;
      startTime: number | bigint;
      endTime: number | bigint;
      maxTotalMintableByWallet: number;
      feeBps: number;
    };
  };
};

/**
 * Every public stage configured between two blocks.
 *
 * One request covers three days on a healthy endpoint. The rest of this is the
 * two ways an endpoint can say no, and they are not the same:
 *
 * - "too wide" → halve the range and read the halves **one after the other**.
 *   Reading them at once would double the requests in flight at exactly the
 *   moment the endpoint is struggling, and viem batches them into a single
 *   oversized HTTP body besides.
 * - "slow down" → wait and ask for the same range again. Splitting here is
 *   what turns a throttle into a stampede.
 */
async function readRange<T>(
  client: PublicClient,
  event: typeof EVENT | typeof MINT_EVENT,
  fromBlock: bigint,
  toBlock: bigint,
  onNote?: (s: string) => void,
  waited = 0,
): Promise<T[]> {
  try {
    const logs = (await client.getLogs({
      address: SEADROP,
      event,
      fromBlock,
      toBlock,
    })) as unknown as T[];
    noteAccepted(toBlock - fromBlock);
    return logs;
  } catch (e) {
    if (isRateLimit(e)) {
      if (waited >= THROTTLE_RETRIES) throw e;
      const pause = 600 * 2 ** waited;
      onNote?.(`throttled — waiting ${pause}ms before asking again`);
      await sleep(pause);
      return readRange<T>(client, event, fromBlock, toBlock, onNote, waited + 1);
    }
    const span = toBlock - fromBlock;
    if (!tooWide(e)) throw e;
    noteRefused(span);
    if (span <= MIN_SPAN) throw e;
    onNote?.(`range of ${span} blocks refused — splitting`);
    // Back through readLogs, not straight into readRange: the refusal just
    // recorded above, and whatever the first half goes on to prove acceptable,
    // both apply to the second half. Recursing into readRange instead made
    // each half rediscover the same ceiling from scratch — visible in the log
    // as the same block count being refused twice.
    const mid = fromBlock + span / 2n;
    const a = await readLogs<T>(client, event, fromBlock, mid, onNote);
    const b = await readLogs<T>(client, event, mid + 1n, toBlock, onNote);
    return [...a, ...b];
  }
}

/**
 * What this endpoint has already taught us about how much it will answer at
 * once, remembered for the life of the process.
 *
 * Without this, every seven-day scan started by asking for six million blocks,
 * got refused, and rediscovered the endpoint's limit by halving — eight
 * refusals deep before the first log came back, and the same eight again on
 * the next scan. The limit is a property of the endpoint, not of the request,
 * so it is worth remembering: once a span has been refused and a smaller one
 * answered, the range is walked in chunks that are known to fit.
 */
let acceptedSpan: bigint | null = null;
let refusedSpan: bigint | null = null;

/** Forget what the endpoint taught us — for tests, and for a config change. */
export function forgetSpanLimits(): void {
  acceptedSpan = null;
  refusedSpan = null;
}

function noteAccepted(span: bigint): void {
  if (span > 0n && (acceptedSpan === null || span > acceptedSpan)) acceptedSpan = span;
}

function noteRefused(span: bigint): void {
  if (refusedSpan === null || span < refusedSpan) refusedSpan = span;
  // Anything we thought was fine but is at least as wide as a refusal isn't.
  // Endpoints change under us — a fallback answering for a paid node has a
  // different ceiling — so an old success must not outrank a fresh refusal.
  if (acceptedSpan !== null && acceptedSpan >= span) acceptedSpan = null;
}

/**
 * How wide a single request may be, or null to just ask for the whole range.
 *
 * Nothing refused yet means nothing to be careful about: a healthy endpoint
 * answers three days in one round trip and chunking it would only make the
 * scan slower.
 */
function chunkSpan(): bigint | null {
  if (refusedSpan === null) return null;
  if (acceptedSpan !== null && acceptedSpan < refusedSpan) return acceptedSpan;
  const half = refusedSpan / 2n;
  return half > MIN_SPAN ? half : MIN_SPAN;
}

/**
 * Every log of one event between two blocks, in as few requests as the
 * endpoint allows.
 *
 * The chunks are read one after another rather than together: the point of
 * knowing the limit is to stop flooding an endpoint that has already said no.
 */
async function readLogs<T>(
  client: PublicClient,
  event: typeof EVENT | typeof MINT_EVENT,
  fromBlock: bigint,
  toBlock: bigint,
  onNote?: (s: string) => void,
): Promise<T[]> {
  const chunk = chunkSpan();
  const span = toBlock - fromBlock;
  if (chunk === null || span <= chunk) {
    return readRange<T>(client, event, fromBlock, toBlock, onNote);
  }

  onNote?.(`${span} blocks in chunks of ${chunk} — the endpoint won't take more`);
  const out: T[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk + 1n) {
    const end = start + chunk > toBlock ? toBlock : start + chunk;
    out.push(...(await readRange<T>(client, event, start, end, onNote)));
  }
  return out;
}

export interface ScanResult {
  drops: ScannedDrop[];
  fromBlock: number;
  toBlock: number;
  /** Events seen before collapsing to one row per collection. */
  events: number;
}

/** Discovery only: no per-collection reads happen here. */
export async function scanPublicDrops(
  client: PublicClient,
  opts: { fromBlock: bigint; toBlock: bigint; onNote?: (s: string) => void },
): Promise<ScanResult> {
  const logs = await readLogs<DropLog>(client, EVENT, opts.fromBlock, opts.toBlock, opts.onNote);
  const events = logs
    .filter((l) => l.args.nftContract && l.args.publicDrop)
    .map((l) => ({
      contract: l.args.nftContract!,
      priceWei: l.args.publicDrop!.mintPrice.toString(),
      startTime: Number(l.args.publicDrop!.startTime),
      endTime: Number(l.args.publicDrop!.endTime),
      maxPerWallet: Number(l.args.publicDrop!.maxTotalMintableByWallet),
      feeBps: Number(l.args.publicDrop!.feeBps),
      block: Number(l.blockNumber),
    }));

  return {
    drops: latestPerContract(events),
    fromBlock: Number(opts.fromBlock),
    toBlock: Number(opts.toBlock),
    events: logs.length,
  };
}

/**
 * Names and supply for a set of collections, three reads each through
 * Multicall3.
 *
 * `allowFailure` is on because a contract that doesn't implement `maxSupply`
 * must cost that one field, not the whole batch — the alternative is a scan
 * that dies on the first unusual collection it meets.
 */
export async function enrichDrops(
  client: PublicClient,
  drops: readonly ScannedDrop[],
  batchSize = 100,
): Promise<ScannedDrop[]> {
  if (drops.length === 0) return [];
  const out: ScannedDrop[] = [];

  for (let i = 0; i < drops.length; i += batchSize) {
    const slice = drops.slice(i, i + batchSize);
    let results: { status: string; result?: unknown }[];
    try {
      results = (await client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: true,
        contracts: slice.flatMap((d) => [
          { address: d.contract, abi: COLLECTION_ABI, functionName: "name" },
          { address: d.contract, abi: COLLECTION_ABI, functionName: "maxSupply" },
          { address: d.contract, abi: COLLECTION_ABI, functionName: "totalSupply" },
          { address: d.contract, abi: COLLECTION_ABI, functionName: "baseURI" },
          { address: d.contract, abi: COLLECTION_ABI, functionName: "provenanceHash" },
          { address: d.contract, abi: COLLECTION_ABI, functionName: "owner" },
          {
            address: d.contract,
            abi: COLLECTION_ABI,
            functionName: "getMintStats",
            args: ["0x0000000000000000000000000000000000000000"],
          },
        ]) as never,
      })) as never;
    } catch {
      // A failed batch costs its names, not the scan: the rows still carry
      // everything the log told us, which is what the filters run on.
      out.push(...slice);
      continue;
    }

    slice.forEach((d, n) => {
      const at = (k: number) => results[n * CALLS_PER_COLLECTION + k];
      const num = (k: number) => {
        const r = at(k);
        if (r?.status !== "success") return undefined;
        const v = Number(r.result as bigint);
        return Number.isFinite(v) ? v : undefined;
      };
      const str = (k: number) => {
        const r = at(k);
        return r?.status === "success" ? String(r.result).trim() || undefined : undefined;
      };
      out.push({
        ...d,
        name: str(0),
        maxSupply: num(1),
        minted: num(2) ?? mintedFromStats(at(6)),
        // An empty baseURI is a real answer — the drop has not revealed — so
        // it is kept as "" rather than folded into undefined with the misses.
        baseURI: at(3)?.status === "success" ? String(at(3).result) : undefined,
        provenanceHash: str(4),
        owner: str(5),
      });
    });
  }
  return out;
}

/**
 * Blocks per hour, measured rather than assumed.
 *
 * Chains change pace, and a hardcoded rate turns "last 24 hours" into a lie
 * the day it does. Two block headers settle it.
 */
export async function measureBlockRate(
  client: PublicClient,
  tip: bigint,
  sample = 200_000n,
): Promise<number> {
  const back = tip > sample ? tip - sample : 0n;
  const [now, then] = await Promise.all([
    client.getBlock({ blockNumber: tip }),
    client.getBlock({ blockNumber: back }),
  ]);
  const seconds = Number(now.timestamp - then.timestamp);
  const blocks = Number(tip - back);
  if (seconds <= 0 || blocks <= 0) return 3600; // one a second, as a floor
  return (blocks / seconds) * 3600;
}


/**
 * Every mint on the chain in a recent slice of blocks.
 *
 * SeaDrop announces each one, so a single log query covers every collection at
 * once — measured on Robinhood Chain, an hour is about 3,250 mints across 45
 * collections and reads in three quarters of a second. That is what makes
 * "is anyone actually minting this" affordable to answer for a whole table
 * instead of one row at a time.
 *
 * The block timestamp is not in the log, and fetching a header per mint would
 * undo the whole saving, so time is interpolated from the range. On a chain
 * producing ~35,600 blocks an hour that is accurate to a second or two, which
 * is far finer than the minute buckets anything here counts in.
 */
export async function readMints(
  client: PublicClient,
  opts: { fromBlock: bigint; toBlock: bigint; onNote?: (s: string) => void },
): Promise<MintEvent[]> {
  // Through the same reader the drop scan uses. This used to be a bare
  // getLogs, which meant an hour of mints — four and a half thousand events —
  // met a refusal or a rate limit with nothing but an exception, and the feed
  // above it reported "the chain is quiet".
  const [logs, head, tail] = await Promise.all([
    readLogs<{
      blockNumber: bigint;
      args: { nftContract?: `0x${string}`; minter?: `0x${string}`; quantityMinted?: bigint };
    }>(client, MINT_EVENT, opts.fromBlock, opts.toBlock, opts.onNote),
    client.getBlock({ blockNumber: opts.fromBlock }),
    client.getBlock({ blockNumber: opts.toBlock }),
  ]);

  const span = Number(opts.toBlock - opts.fromBlock) || 1;
  const t0 = Number(head.timestamp);
  const perBlock = (Number(tail.timestamp) - t0) / span;

  const out: MintEvent[] = [];
  for (const l of logs) {
    if (!l.args.nftContract || !l.args.minter) continue;
    const q = Number(l.args.quantityMinted ?? 0n);
    out.push({
      collection: l.args.nftContract,
      minter: l.args.minter,
      quantity: Number.isFinite(q) && q > 0 ? q : 1,
      t: Math.round(t0 + (Number(l.blockNumber) - Number(opts.fromBlock)) * perBlock),
    });
  }
  return out;
}
