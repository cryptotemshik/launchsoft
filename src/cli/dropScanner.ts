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

const EVENT = parseAbiItem(PUBLIC_DROP_UPDATED);

/** Multicall3, at the same address on every chain that has it. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const COLLECTION_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Below this, splitting costs more round trips than it saves. */
const MIN_SPAN = 5_000n;

function looksSplittable(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("block range") ||
    msg.includes("range is too large") ||
    msg.includes("too many") ||
    msg.includes("exceeds") ||
    msg.includes("limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    isRateLimit(e)
  );
}

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
 * One request covers three days on a healthy endpoint. A provider that refuses
 * the width — or times out under load — gets the range halved and retried,
 * which is the only reason this isn't three lines.
 */
async function readLogs(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  onNote?: (s: string) => void,
): Promise<DropLog[]> {
  try {
    return (await client.getLogs({
      address: SEADROP,
      event: EVENT,
      fromBlock,
      toBlock,
    })) as unknown as DropLog[];
  } catch (e) {
    const span = toBlock - fromBlock;
    if (!looksSplittable(e) || span <= MIN_SPAN) throw e;
    onNote?.(`range of ${span} blocks refused — splitting`);
    const mid = fromBlock + span / 2n;
    const [a, b] = await Promise.all([
      readLogs(client, fromBlock, mid, onNote),
      readLogs(client, mid + 1n, toBlock, onNote),
    ]);
    return [...a, ...b];
  }
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
  const logs = await readLogs(client, opts.fromBlock, opts.toBlock, opts.onNote);
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
  batchSize = 150,
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
        ]) as never,
      })) as never;
    } catch {
      // A failed batch costs its names, not the scan: the rows still carry
      // everything the log told us, which is what the filters run on.
      out.push(...slice);
      continue;
    }

    slice.forEach((d, n) => {
      const at = (k: number) => results[n * 3 + k];
      const num = (k: number) => {
        const r = at(k);
        if (r?.status !== "success") return undefined;
        const v = Number(r.result as bigint);
        return Number.isFinite(v) ? v : undefined;
      };
      const nameRes = at(0);
      out.push({
        ...d,
        name: nameRes?.status === "success" ? String(nameRes.result).trim() || undefined : undefined,
        maxSupply: num(1),
        minted: num(2),
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
