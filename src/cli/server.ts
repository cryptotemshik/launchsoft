/**
 * Control server — a queue of drops, executed next to the sequencer.
 *
 * The important property: this does NOT put the browser in the firing path. A
 * request only *queues* or *starts* a run; the run itself holds and fires on
 * this machine's own clock (see runner.ts). So a browser-triggered snipe is
 * exactly as fast as one typed over SSH — what matters is that this process
 * sits next to the sequencer.
 *
 * Why the queue runs strictly one job at a time: every wallet's transactions
 * are pre-signed against a specific nonce. Two jobs armed at once for the same
 * wallets would sign the same nonce twice and the second would be rejected. So
 * the scheduler arms the next job only once the previous has settled, reading
 * fresh nonces at arm time — which still leaves the full pre-sign advantage,
 * since arming happens ARM_LEAD_MS before the stage opens.
 *
 * Security posture:
 *   - binds to 127.0.0.1 by default, so nothing is exposed until you publish
 *     it deliberately (Cloudflare Tunnel is the documented route — outbound
 *     only, no inbound port open on the box);
 *   - every route needs a bearer token, compared in constant time;
 *   - private keys never leave this process. The panel sees addresses and
 *     balances, never a key;
 *   - CORS is limited to the origins you list.
 *
 *   npm run snipe:server
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";
import { formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { collect, disperse } from "./funding";
import { scanChain } from "./holdings";
import { lookupCollections } from "./collectionLookup";
import { pulseByCollection, type MintPulse } from "../lib/mintPulse";
import { CreatorIndex } from "../lib/creatorIndex";
import { SEADROP } from "../lib/dropScan";
import { probeLogRange, PROBE_BLOCKS } from "../lib/logRangeProbe";

/** SeaDrop's view of a collection's public stage. Only ever the public one. */
const PUBLIC_DROP_ABI = [
  {
    type: "function",
    name: "getPublicDrop",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "mintPrice", type: "uint80" },
          { name: "startTime", type: "uint48" },
          { name: "endTime", type: "uint48" },
          { name: "maxTotalMintableByWallet", type: "uint16" },
          { name: "feeBps", type: "uint16" },
          { name: "restrictFeeRecipients", type: "bool" },
        ],
      },
    ],
  },
] as const;
import { costByCollection, loadMints, recordMint } from "./ledger";
import {
  blockTimes,
  clearProfitCaches,
  costByMintTx,
  priceTransfers,
  readMintTxs,
  summarise,
} from "./profit";
import { loadCollections, rememberCollection } from "./collections";
import { sweepNfts, type Holding } from "./nftSweep";
import { getChainInfo } from "../chains";
import { normalizePrivateKey } from "../lib/convert";
import {
  keysPath,
  loadConfig,
  loadKeyEntries,
  loadKeys,
  serialiseKeys,
  type KeyEntry,
  type SnipeConfig,
} from "./config";
import { readDrop, runSnipe, waveSize, type RunOptions, type RunResult } from "./runner";
import { formatMintReport, sendTelegram, type MintedWallet } from "../lib/telegram";
import { startTelegramBot } from "./telegramBot";
import { addUpcoming, loadUpcoming, recolorUpcoming, removeUpcoming } from "./upcomingStore";
import { loadJobs, restoreStatus, saveJobs, type StoredJob, type StoredStatus } from "./jobStore";
import { buildUpcoming, sortByDate } from "../lib/upcoming";
import { isPickable, PICKABLE } from "../lib/calendarColor";
import { DEFAULT_AFTER, DEFAULT_BEFORE, DEFAULT_STEP_MS, planFor } from "../lib/spread";
import { enrichDrops, measureBlockRate, readMints, scanPublicDrops } from "./dropScanner";
import { blocksForHours, classify, mergeScans, sortForScan, type ScannedDrop } from "../lib/dropScan";
import { API_VERSION } from "../lib/apiVersion";
import { mapWithLimit, readConcurrency } from "../lib/rpcRead";
import { makeReadClient } from "../lib/readClient";
import { currentTunnelUrl } from "./tunnelUrl";
import { envNumber } from "../lib/envNumber";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

const PORT = envNumber(process.env.SNIPE_PORT, 8787, 1);
const HOST = process.env.SNIPE_HOST ?? "127.0.0.1";
const TOKEN = process.env.SNIPE_TOKEN ?? "";
/** Comma-separated list; "*" allows any origin (only sane behind a tunnel + token). */
const ORIGINS = (process.env.SNIPE_ORIGINS ?? "*").split(",").map((s) => s.trim());
const CONFIG_PATH = process.env.SNIPE_CONFIG ?? "snipe.config.json";
/** How far ahead of a stage a job is armed (read nonces, pre-sign, warm). */
const ARM_LEAD_MS = envNumber(process.env.SNIPE_ARM_LEAD_MS, 120_000);
/** Set to 0 to stop the server pulling its own updates. */
/**
 * The endpoints this box reads through, set on the box.
 *
 * Until now the only way to give the server a paid endpoint was for a browser
 * to push one down to it, which meant the machine's own configuration
 * depended on which browser had last visited and whether it happened to open
 * a tab that pushes. A server that reads the chain for a living should not
 * learn where to read from a web page — so it can be told here, and what a
 * panel pushes is added behind it rather than instead of it.
 *
 * Comma or newline separated. Best first.
 */
const ENV_RPCS = splitRpcs(process.env.SNIPE_RPCS);

/**
 * The endpoints the *research* reads go through, when they are to be kept
 * apart from the ones a mint uses.
 *
 * A scan is the heaviest thing this server does — a week of history is
 * millions of blocks of `eth_getLogs` — and a provider's throughput limit is
 * per key. Sharing one key means a calendar refresh can be eating the
 * allowance at the exact second a stage opens, and the request that loses is
 * the one that cannot be retried: the mint. Point this at a second key and the
 * scanner can be as greedy as it likes without ever standing in a drop's way.
 *
 * Unset, it falls back to SNIPE_RPCS, so one key keeps working as before.
 */
const SCAN_ENV_RPCS = splitRpcs(process.env.SNIPE_SCAN_RPCS);

/**
 * The endpoints a queued mint uses, when that is to be kept clean too.
 *
 * The broadcast itself races every endpoint at once with the sequencer first,
 * so a key here is one racer among several and not the deciding factor. What
 * it does decide is the arming: a hundred wallets is a hundred balance reads
 * and a hundred nonce reads, fired two minutes before the stage opens. Those
 * go to a single endpoint — the first in this list — and if it is busy serving
 * a sweep or a wallet refresh at that moment, the arm is what suffers, with
 * nobody watching.
 *
 * Unset, a mint uses SNIPE_RPCS like everything else.
 */
const MINT_ENV_RPCS = splitRpcs(process.env.SNIPE_MINT_RPCS);

function splitRpcs(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

const AUTO_UPDATE = process.env.SNIPE_AUTO_UPDATE !== "0";
const AUTO_UPDATE_MS = envNumber(process.env.SNIPE_AUTO_UPDATE_MS, 3_600_000, 1);
/**
 * How close to a queued drop is too close to restart. A job arms ARM_LEAD_MS
 * before its stage; leaving only that would mean updating seconds before the
 * pre-signing starts, which is the one moment worth protecting.
 */
const UPDATE_BLACKOUT_MS = ARM_LEAD_MS + 600_000;

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    "SNIPE_TOKEN must be set to a secret of at least 16 characters — it is the only thing\n" +
      "standing between the internet and your wallets. Generate one with:\n" +
      "  openssl rand -hex 32",
  );
  process.exit(1);
}

// ── Queue ────────────────────────────────────────────────────────────────────
type JobStatus = "queued" | "armed" | "done" | "error" | "aborted";

/**
 * The drop as the contract described it at queue time.
 *
 * Read once, when the job is added, rather than at fire time: a queue you can
 * only understand after it has run is not much of a queue. Every number is a
 * string because these travel as JSON and a supply does not fit in a double.
 */
interface JobDrop {
  name: string;
  totalSupply: string;
  maxSupply: string;
  priceWei: string;
  /** Unix seconds; 0 when the stage has no start set yet. */
  startTime: number;
  endTime: number;
  perWallet: number;
  /** When this snapshot was taken. */
  readAt: number;
}

interface Job {
  id: string;
  label: string;
  addedAt: number;
  status: JobStatus;
  /** Everything runSnipe needs except the keys, which are read at arm time. */
  request: Omit<RunOptions, "keys">;
  /** Stage start, once known — filled in by a dry run or by the job itself. */
  startTime?: number;
  logs: string[];
  result?: RunResult;
  error?: string;
  abort?: AbortController;
  /**
   * Addresses this job may fire from (lowercase). Absent means every wallet on
   * the server — the restriction lives on the job, not on RunOptions, because
   * the server owns the keys and simply passes fewer of them.
   */
  wallets?: string[];
  /** Set when the post-run NFT sweep ran. */
  consolidated?: { to: string; moved: number; total: number };
  /** What the contract said about the drop when the job was queued. */
  drop?: JobDrop;
}

/** Where the box is reachable, once the tunnel log has been read. */
let tunnelUrl: string | null = null;

const jobs: Job[] = [];

/**
 * Write the pending queue to disk.
 *
 * Called after anything that changes what is still to run. Cheap — the queue
 * is a handful of small records — and the alternative is what this replaces: a
 * `pm2 restart` between drops silently throwing away a job someone set up
 * hours earlier.
 */
function persistJobs(): void {
  try {
    saveJobs(
      CONFIG_PATH,
      jobs
        .filter((j): j is Job & { status: StoredStatus } => j.status === "queued" || j.status === "armed")
        .map((j) => ({
          id: j.id,
          label: j.label,
          addedAt: j.addedAt,
          status: j.status,
          request: j.request,
          startTime: j.startTime,
          wallets: j.wallets,
        })),
    );
  } catch (e) {
    // Never let a disk problem take down a run that is otherwise fine.
    log(`queue: couldn't save (${e instanceof Error ? e.message : String(e)})`);
  }
}
/** At most one job may be armed/firing — see the nonce note in the header. */
let activeJobId: string | null = null;

function tokenOk(header: string | undefined): boolean {
  const given = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual throws on length mismatch, so equalise first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes("*") ? origin ?? "*" : ORIGINS.find((o) => o === origin);
  if (allow) res.setHeader("access-control-allow-origin", allow);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("vary", "origin");
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  // Every response carries the version, so a panel learns the server is behind
  // from whichever route it happens to call first rather than only from /ping.
  const payload =
    body && typeof body === "object" && !Array.isArray(body)
      ? { apiVersion: API_VERSION, ...(body as Record<string, unknown>) }
      : body;
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Public view of a job — logs and outcomes, never keys. */
/**
 * Read the drop, or give up quietly.
 *
 * A queue that refuses to accept a job because an RPC blinked would be worse
 * than one missing a price column, so every failure here is swallowed: the job
 * is queued either way and simply shows less.
 */
/** What the marketplace lookup has for one contract, if it has landed yet. */
function creatorsMeta(contract: string) {
  return lookupCollections("", [contract], 0).known[contract.toLowerCase()];
}

async function peekDrop(
  collection: `0x${string}`,
  extraRpcs: readonly string[],
): Promise<JobDrop | undefined> {
  try {
    const cfg = loadConfig(CONFIG_PATH);
    const info = getChainInfo(cfg.chainId);
    if (!info) return undefined;
    const client = makeReadClient(info.chain, withEnvRpcs([...extraRpcs, ...cfg.extraRpcs]));
    const d = await readDrop(client as never, info, collection);
    return {
      name: d.name,
      totalSupply: d.totalSupply.toString(),
      maxSupply: d.maxSupply.toString(),
      priceWei: d.price.toString(),
      startTime: d.startTime,
      endTime: d.endTime,
      perWallet: d.perWallet,
      readAt: Date.now(),
    };
  } catch (e) {
    log(`queue: couldn't read the drop (${e instanceof Error ? e.message : e}) — queueing anyway`);
    return undefined;
  }
}

function jobView(j: Job) {
  return {
    id: j.id,
    label: j.label,
    status: j.status,
    addedAt: j.addedAt,
    startTime: j.startTime,
    collection: j.request.collection,
    stage: j.request.stage,
    quantity: j.request.quantity,
    dryRun: j.request.dryRun,
    // The gas this job was queued with, not whatever the panel shows now.
    // Funding it means covering what it will actually spend, and the two drift
    // apart the moment someone edits the gas box for the next drop.
    gas: j.request.gas,
    // How many transactions per wallet this job will send, so the funding
    // panel asks for enough gas rather than for exactly one shot's worth.
    shots: planFor(
      j.request.style ?? "single",
      j.request.before ?? DEFAULT_BEFORE,
      j.request.after ?? DEFAULT_AFTER,
      j.request.stepMs ?? DEFAULT_STEP_MS,
    ).shots,
    wallets: j.wallets,
    logs: j.logs.slice(-60),
    plan: j.result?.plan,
    outcomes: j.result?.outcomes,
    consolidated: j.consolidated,
    drop: j.drop,
    error: j.error,
  };
}

/**
 * Build the profit report.
 *
 * Split out of the route because it no longer answers a request directly: it
 * takes hundreds of round trips and the tunnel in front of this server gives
 * up on a request after a hundred seconds. So the route starts this in the
 * background and hands back what it has, and the panel asks again in a moment.
 */
async function buildProfitReport(): Promise<Record<string, unknown>> {
  const cfg = loadConfig(CONFIG_PATH);
  const info = getChainInfo(cfg.chainId);
  if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);

  const started = Date.now();
  const addresses = loadKeyEntries(CONFIG_PATH, cfg.keysFile).map(
    (e) => privateKeyToAccount(e.key).address,
  );
  const costs = costByCollection(loadMints(CONFIG_PATH));
  const known = loadCollections(CONFIG_PATH);

  const client = makeReadClient(info.chain, scanRpcs(cfg));

  // One scan covers every collection these wallets have ever touched, so
  // a drop shows up here whether or not it was minted through this server
  // — the ledger only supplies what it cost.
  const scan = await scanChain(client as never, addresses);
  const [sales, mintTxs] = await Promise.all([
    priceTransfers(client as never, scan.sent, addresses),
    // What the mints cost, read from their own transactions. The ledger
    // only covers runs this server made, so on its own it left every
    // earlier drop showing no mints and no spend at all.
    readMintTxs(client as never, scan.minted),
  ]);
  const minted = costByMintTx(mintTxs);
  const salesByCollection = new Map<string, typeof sales>();
  for (const sale of sales) {
    const key = sale.collection.toLowerCase();
    salesByCollection.set(key, [...(salesByCollection.get(key) ?? []), sale]);
  }

  const seen = new Set<string>([
    ...scan.collections.map((c) => c.collection.toLowerCase()),
    ...costs.keys(),
    ...known.map((k) => k.address.toLowerCase()),
  ]);

  const reports = [...seen].map((key) => {
    const held = scan.collections.find((c) => c.collection.toLowerCase() === key);
    const cost = costs.get(key);
    const address = (held?.collection ??
      cost?.collection ??
      known.find((k) => k.address.toLowerCase() === key)!.address) as `0x${string}`;
    const mine = salesByCollection.get(key) ?? [];
    const chain = minted.get(key);
    // The chain is the better source where it has anything: it sees mints
    // this server never made. The ledger still supplies the one figure the
    // chain cannot — gas burnt by attempts that reverted and left no token
    // — and takes over entirely where the chain found no mints at all.
    const spend = chain
      ? {
          gasWei: chain.gasWei + (cost?.failedGasWei ?? 0n),
          priceWei: chain.priceWei,
          tokens: chain.tokens,
          wallets: chain.wallets,
        }
      : {
          gasWei: cost?.gasWei ?? 0n,
          priceWei: cost?.priceWei ?? 0n,
          tokens: cost?.tokens ?? 0,
          wallets: cost?.wallets ?? 0,
        };
    const report = summarise(
      address,
      spend,
      mine,
      held?.totalTokens ?? 0,
      held?.name ?? cost?.collectionName,
    );
    return {
      ...report,
      cost: {
        gasWei: report.cost.gasWei.toString(),
        priceWei: report.cost.priceWei.toString(),
        tokens: report.cost.tokens,
        wallets: report.cost.wallets,
      },
      revenueWei: report.revenueWei.toString(),
      netWei: report.netWei.toString(),
      sales: report.sales.map((x) => ({
        ...x,
        blockNumber: x.blockNumber.toString(),
        proceedsWei: x.proceedsWei.toString(),
      })),
      unpricedSales: report.unpricedSales,
      runs: cost?.runs ?? 0,
      lastAt: cost?.lastAt,
    };
  });
  // Biggest position first — that is the one worth reading.
  reports.sort((a, b) => b.heldTokens + b.soldTokens - (a.heldTokens + a.soldTokens));

  // Every spend and every receipt, stamped with when it happened, so the
  // dashboard can re-cut the same figures by time — last hour, last week —
  // and draw a profit line without asking the chain again.
  const times = await blockTimes(client as never, [
    ...mintTxs.map((t) => t.blockNumber),
    ...sales.map((s) => s.blockNumber),
  ]);
  const events = [
    ...mintTxs.map((t) => ({
      collection: t.collection.toLowerCase(),
      kind: "mint" as const,
      at: times.get(String(t.blockNumber)) ?? 0,
      block: t.blockNumber.toString(),
      // Signed: a mint takes money out, a sale puts it back.
      wei: (-(t.gasWei + t.priceWei)).toString(),
      tokens: t.tokens,
      wallet: t.wallet,
      txHash: t.txHash,
    })),
    ...sales.map((s) => ({
      collection: s.collection.toLowerCase(),
      kind: "sale" as const,
      at: times.get(String(s.blockNumber)) ?? 0,
      block: s.blockNumber.toString(),
      wei: s.proceedsWei.toString(),
      tokens: 1,
      wallet: s.wallet,
      txHash: s.txHash,
      tokenId: s.tokenId,
      priced: s.priced,
    })),
  ].sort((a, b) => a.at - b.at || Number(BigInt(a.block) - BigInt(b.block)));

  const body = {
    chain: info.label,
    explorerUrl: info.explorerUrl,
    openSeaSlug: info.openSeaSlug,
    wallets: addresses.length,
    collections: reports,
    events,
    now: Math.floor(Date.now() / 1000),
    tookMs: Date.now() - started,
  };
  return body;
}

/** Whether a report is being built right now, so two panels don't start two. */
let profitBuilding: Promise<Record<string, unknown>> | null = null;

/** Start one if none is running, and remember the result when it lands. */
function startProfitBuild(): Promise<Record<string, unknown>> {
  if (profitBuilding) return profitBuilding;
  const started = Date.now();
  profitBuilding = buildProfitReport()
    .then((body) => {
      profitCache = { at: Date.now(), body };
      log(`profit: report built in ${Date.now() - started}ms`);
      return body;
    })
    .catch((e) => {
      log(`profit: build failed — ${e instanceof Error ? e.message : e}`);
      throw e;
    })
    .finally(() => {
      profitBuilding = null;
    });
  return profitBuilding;
}

/**
 * Scan results, keyed by window length.
 *
 * A scan is two round trips and a few seconds; a minute of cache means a
 * panel that re-renders, or a second person looking, costs nothing. Anything
 * longer would start hiding drops that were configured while you watched.
 */
const scanCache = new Map<number, { at: number; body: Record<string, unknown> }>();
const scanInflight = new Map<number, Promise<Record<string, unknown>>>();
const SCAN_TTL_MS = envNumber(process.env.SNIPE_SCAN_TTL_MS, 60_000);
/**
 * The measured block rate, held for a while.
 *
 * It costs two block headers, and it does not move meaningfully between one
 * refresh and the next — paying for it every few seconds would double the cost
 * of a live refresh whose whole point is being nearly free.
 */
let blockRate: { at: number; perHour: number } | null = null;
const BLOCK_RATE_TTL_MS = 10 * 60_000;
/** A week of this chain is ~6M blocks; beyond that the wait stops being useful. */
const MAX_SCAN_HOURS = 168;

/**
 * How far behind the tip a cached scan may be and still be worth topping up
 * rather than redoing. An hour of blocks reads as fast as a minute of them;
 * beyond that the saving disappears and a clean read is simpler to trust.
 */
const INCREMENTAL_LIMIT_HOURS = 2;

/**
 * How much minting to look at, and how long to hold the answer.
 *
 * An hour of SeaDrop mints is one log query — about 3,250 events on this chain
 * — and it answers "is anyone actually minting this" for every collection in
 * the table at once. Held for half a minute because a live refresh every ten
 * seconds should not pay for it three times, and because a rate measured over
 * an hour does not move meaningfully in thirty.
 */
/**
 * What the chain's coin is worth, so a floor listed in a stablecoin can be
 * compared with a mint priced in the native one. Both occur here, and
 * comparing their face numbers produces things like "2,500,000% of the mint
 * price". One cheap call, held for an hour — this is used to decide whether a
 * floor is above or below a mint, not to price a trade.
 */
let coinUsd: { at: number; usd: number | null } | null = null;
const COIN_USD_TTL_MS = 3600_000;

async function nativeUsd(api: string | undefined): Promise<number | null> {
  if (!api) return null;
  if (coinUsd && Date.now() - coinUsd.at < COIN_USD_TTL_MS) return coinUsd.usd;
  let usd: number | null = null;
  try {
    const r = await fetch(`${api}/stats`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const v = Number(((await r.json()) as { coin_price?: string }).coin_price);
      usd = Number.isFinite(v) && v > 0 ? v : null;
    }
  } catch {
    // No rate means the cross-coin floor check reports "can't compare",
    // which is the honest answer and not worth failing a scan over.
  }
  coinUsd = { at: Date.now(), usd };
  return usd;
}

/**
 * Who launched what, across every scan this process has served.
 *
 * Held here rather than rebuilt per request because its value is exactly its
 * age: a six-hour scan sees one collection for an address that has launched
 * twelve, and the only way to know the twelve is to remember what earlier
 * scans saw.
 */
const creators = new CreatorIndex();

const PULSE_HOURS = 1;

const PULSE_TTL_MS = 30_000;
/**
 * The windows the live feed offers, in minutes.
 *
 * A day of this chain is around a hundred thousand mints, which the splitting
 * reader can fetch but which is a different kind of question from "what is
 * happening right now" — so both ends are offered and the caller picks.
 */
const LIVE_WINDOWS = [5, 15, 60, 240, 1440] as const;
const DEFAULT_LIVE_MINUTES = 15;

function nearestWindow(minutes: number): number {
  return LIVE_WINDOWS.reduce((best, w) =>
    Math.abs(w - minutes) < Math.abs(best - minutes) ? w : best,
  );
}

/** Keyed by window: a five-minute read and a daily one are different answers. */
const pulseCache = new Map<number, { at: number; by: Record<string, MintPulse> }>();
const pulseInflight = new Map<number, Promise<Record<string, MintPulse>>>();
/**
 * Why the last read of the mint feed failed, if it did.
 *
 * Swallowing this was the worse half of the bug it fixes: a refused log query
 * came back as an empty map, and a feed with nothing in it is indistinguishable
 * from a chain with nothing happening. "Nothing minting — the chain is quiet"
 * is a claim, and it should only ever be made when it is true.
 */
let pulseError: string | null = null;

/**
 * The live feed's rows: what is minting, with enough about each to read.
 *
 * A collection minting right now is not necessarily in the scanner's window —
 * its stage may have been configured days ago — so the names cannot be
 * borrowed from the scan and are read here. That is one multicall over the
 * few dozen collections that saw a mint in the hour, which rides on the same
 * thirty-second cache as the pulse itself.
 */
export interface LiveRow {
  contract: `0x${string}`;
  name?: string;
  maxSupply?: number;
  minted?: number;
  owner?: string;
  pulse: MintPulse;
}

const liveCache = new Map<number, { at: number; rows: LiveRow[] }>();
const liveInflight = new Map<number, Promise<LiveRow[]>>();
/** Enriching every quiet collection would be reads spent on empty rows. */
const LIVE_MAX_ROWS = 60;

async function liveRows(
  client: Parameters<typeof readMints>[0],
  tip: bigint,
  blocksPerHour: number,
  minutes: number,
): Promise<LiveRow[]> {
  const hit = liveCache.get(minutes);
  if (hit && Date.now() - hit.at < PULSE_TTL_MS) return hit.rows;
  const flying = liveInflight.get(minutes);
  if (flying) return flying;

  const run = (async () => {
    const by = await mintPulse(client, tip, blocksPerHour, minutes);
    const ranked = Object.entries(by)
      .sort((a, b) => b[1].trend - a[1].trend || b[1].quantity - a[1].quantity)
      .slice(0, LIVE_MAX_ROWS);
    const enriched = await enrichDrops(
      client as never,
      ranked.map(([contract]) => ({
        contract: contract as `0x${string}`,
        priceWei: "0",
        startTime: 0,
        endTime: 0,
        maxPerWallet: 0,
        feeBps: 0,
        block: 0,
      })),
    );
    for (const e of enriched) {
      creators.remember({ contract: e.contract, name: e.name, owner: e.owner });
    }
    const meta = new Map(enriched.map((e) => [e.contract.toLowerCase(), e]));
    const rows = ranked.map(([contract, pulse]) => {
      const m = meta.get(contract);
      return {
        contract: contract as `0x${string}`,
        name: m?.name,
        maxSupply: m?.maxSupply,
        minted: m?.minted,
        owner: m?.owner,
        pulse,
      };
    });
    liveCache.set(minutes, { at: Date.now(), rows });
    return rows;
  })()
    .catch((e) => {
      pulseError = e instanceof Error ? e.message : String(e);
      log(`live failed: ${pulseError}`);
      return [] as LiveRow[];
    })
    .finally(() => {
      liveInflight.delete(minutes);
    });

  liveInflight.set(minutes, run);
  return run;
}

async function mintPulse(
  client: Parameters<typeof readMints>[0],
  tip: bigint,
  blocksPerHour: number,
  minutes = 60,
): Promise<Record<string, MintPulse>> {
  const hit = pulseCache.get(minutes);
  if (hit && Date.now() - hit.at < PULSE_TTL_MS) return hit.by;
  const flying = pulseInflight.get(minutes);
  if (flying) return flying;

  const run = (async () => {
    const span = blocksForHours(minutes / 60, blocksPerHour);
    const events = await readMints(client, {
      fromBlock: tip > span ? tip - span : 0n,
      toBlock: tip,
      onNote: (n) => log(`pulse: ${n}`),
    });
    pulseError = null;
    const by = pulseByCollection(events, Math.floor(Date.now() / 1000), {
      spanSec: minutes * 60,
    });
    pulseCache.set(minutes, { at: Date.now(), by });
    log(`pulse: ${events.length} mints across ${Object.keys(by).length} collections in ${minutes}m`);
    return by;
  })()
    .catch((e) => {
      // A scan is still worth serving without it — the columns say "—" rather
      // than the whole table failing over one extra query — but the reason
      // travels with the response so nobody reads a failure as a quiet chain.
      pulseError = e instanceof Error ? e.message : String(e);
      log(`pulse failed: ${pulseError}`);
      return {} as Record<string, MintPulse>;
    })
    .finally(() => {
      pulseInflight.delete(minutes);
    });

  pulseInflight.set(minutes, run);
  return run;
}

async function startScan(hours: number): Promise<Record<string, unknown>> {
  const run = (async () => {
    const started = Date.now();
    const cfg = loadConfig(CONFIG_PATH);
    const info = getChainInfo(cfg.chainId);
    if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);
    const client = makeReadClient(info.chain, scanRpcs(cfg));

    const tip = await client.getBlockNumber();
    // Measured, not assumed: a hardcoded rate turns "last 24 hours" into a
    // lie the day the chain changes pace. Cached, because it barely moves.
    if (!blockRate || Date.now() - blockRate.at > BLOCK_RATE_TTL_MS) {
      blockRate = { at: Date.now(), perHour: await measureBlockRate(client as never, tip) };
    }
    const blocksPerHour = blockRate.perHour;
    const span = blocksForHours(hours, blocksPerHour);
    const windowFrom = tip > span ? tip - span : 0n;

    // Top up rather than re-read, when there is something to top up from.
    // A live refresh every few seconds then costs one small log query instead
    // of a three-megabyte one — the difference between a scanner you can leave
    // running and one you can't.
    const prior = scanCache.get(hours);
    const priorTo = prior ? BigInt((prior.body.toBlock as number) ?? 0) : 0n;
    const behind = tip - priorTo;
    const incremental =
      prior != null &&
      priorTo > 0n &&
      priorTo < tip &&
      behind < blocksForHours(INCREMENTAL_LIMIT_HOURS, blocksPerHour);

    const scan = await scanPublicDrops(client as never, {
      fromBlock: incremental ? priorTo + 1n : windowFrom,
      toBlock: tip,
      onNote: (note) => log(`scan: ${note}`),
    });

    let drops: ScannedDrop[];
    let toEnrich: ScannedDrop[];
    let events = scan.events;

    if (incremental) {
      const merged = mergeScans(
        (prior!.body.drops as ScannedDrop[]) ?? [],
        scan.drops,
        Number(windowFrom),
      );
      drops = merged.drops;
      const fresh = new Set(merged.fresh.map((c) => c.toLowerCase()));
      toEnrich = drops.filter((d) => fresh.has(d.contract.toLowerCase()));
      events = ((prior!.body.events as number) ?? 0) + scan.events;
    } else {
      drops = scan.drops;
      toEnrich = drops;
    }

    // Only what is still ahead or running gets per-collection reads — the
    // whole point of the event carrying its struct is that the filter is free.
    const now = Math.floor(Date.now() / 1000);
    const worth = toEnrich.filter((d) => classify(d, now) !== "ended");
    const enriched = await enrichDrops(client as never, worth);

    const byContract = new Map(drops.map((d) => [d.contract.toLowerCase(), d]));
    for (const e of enriched) byContract.set(e.contract.toLowerCase(), e);

    for (const d of byContract.values()) {
      creators.remember({
        contract: d.contract,
        name: d.name,
        startTime: d.startTime,
        owner: d.owner,
      });
    }

    const [pulse, nativeUsdRate] = await Promise.all([
      mintPulse(client as never, tip, blocksPerHour, PULSE_HOURS * 60),
      nativeUsd(info.blockscoutApi),
    ]);

    const body = {
      drops: sortForScan([...byContract.values()], now),
      hours,
      events,
      collections: byContract.size,
      enriched: enriched.length,
      /** Reading only the new blocks — the client says so, and it is cheap. */
      incremental,
      newDrops: incremental ? enriched.length : 0,
      fromBlock: Number(windowFrom),
      toBlock: scan.toBlock,
      blocksPerHour: Math.round(blocksPerHour),
      chain: info.label,
      explorerUrl: info.explorerUrl,
      openSeaSlug: info.openSeaSlug,
      /**
       * Which endpoint actually answered. A scan is the heaviest read this
       * server makes, and running it through the chain's public RPC ends in a
       * 429 — so the panel has to be able to say which node was used rather
       * than leaving the user to guess from the error.
       */
      readRpc: rpcHost(scanRpc(cfg, info)),
      publicRpc: scanRpcs(cfg).length === 0,
      /** Set when that endpoint cannot actually serve a scan at all. */
      readRpcNote: scanRpcNote,
      /** Minting over the last hour, keyed by lower-case contract. */
      pulse,
      pulseHours: PULSE_HOURS,
      pulseError,
      nativeSymbol: info.chain.nativeCurrency.symbol,
      nativeUsd: nativeUsdRate,
      /** Owner and handle groupings for the collections in this response. */
      related: creators.relatedFor([...byContract.keys()]),
      knownCollections: creators.size,
      now,
      tookMs: Date.now() - started,
    };
    scanCache.set(hours, { at: Date.now(), body });
    log(
      `scan: ${hours}h ${incremental ? `+${scan.events} new events (${behind} blocks)` : `${scan.events} events`}` +
        ` · ${byContract.size} collections · ${body.tookMs}ms`,
    );
    return body as Record<string, unknown>;
  })().finally(() => scanInflight.delete(hours));

  scanInflight.set(hours, run);
  return run;
}

/**
 * The last profit report, and when it was built.
 *
 * Reading it costs hundreds of round trips; nothing it reports on changes by
 * the second, and two panels asking at once should not mean two full scans.
 */
let profitCache: { at: number; body: Record<string, unknown> } | null = null;
const PROFIT_TTL_MS = envNumber(process.env.SNIPE_PROFIT_TTL_MS, 60_000);
/**
 * How long a request waits for a build before answering "still working".
 *
 * Well under the tunnel's hundred-second limit, and long enough that a warm
 * report comes back on the first ask rather than the second.
 */
const PROFIT_WAIT_MS = envNumber(process.env.SNIPE_PROFIT_WAIT_MS, 8_000);

/** Merge the on-disk defaults with whatever the panel supplied. */
function buildRequest(body: Record<string, unknown>): Omit<RunOptions, "keys"> {
  const cfg = loadConfig(CONFIG_PATH);

  const collection = typeof body.collection === "string" ? body.collection : cfg.collection;
  if (!/^0x[0-9a-fA-F]{40}$/.test(collection)) throw new Error("collection must be a 0x address");

  const stage = body.stage === "allowlist" || body.stage === "public" ? body.stage : cfg.stage;
  const timing = body.timing === "now" || body.timing === "wait" ? body.timing : cfg.timing;
  const quantity: number | "max" =
    body.quantity === "max"
      ? "max"
      : typeof body.quantity === "number" && Number.isInteger(body.quantity) && body.quantity >= 1
        ? body.quantity
        : cfg.quantity;
  const gasIn = (body.gas ?? {}) as Partial<RunOptions["gas"]>;

  return {
    chainId: typeof body.chainId === "number" ? body.chainId : cfg.chainId,
    collection: collection as `0x${string}`,
    stage,
    quantity,
    // The box's own endpoints lead whatever the caller sent. A panel that has
    // never pushed an RPC would otherwise mint through the public node, which
    // is the one place on this server where being metered costs a drop.
    extraRpcs: [
      ...MINT_ENV_RPCS,
      ...withEnvRpcs(
        Array.isArray(body.extraRpcs)
          ? (body.extraRpcs as unknown[]).filter((x): x is string => typeof x === "string")
          : cfg.extraRpcs,
      ).filter((u) => !MINT_ENV_RPCS.includes(u)),
    ],
    gas: {
      maxFeeGwei: gasIn.maxFeeGwei ?? cfg.gas.maxFeeGwei,
      tipGwei: gasIn.tipGwei ?? cfg.gas.tipGwei,
      limit: gasIn.limit ?? cfg.gas.limit,
    },
    timing,
    // How the shots sit on the clock. Per job, because the right answer
    // differs per drop: a contested free mint wants the spread, a quiet one
    // does not need the extra transactions.
    style: body.style === "spread" ? "spread" : "single",
    before: typeof body.before === "number" && body.before >= 0 ? Math.floor(body.before) : undefined,
    after: typeof body.after === "number" && body.after >= 0 ? Math.floor(body.after) : undefined,
    stepMs: typeof body.stepMs === "number" && body.stepMs >= 0 ? Math.floor(body.stepMs) : undefined,
    dryRun: body.dryRun !== false,
  };
}


/** Addresses a job is restricted to, validated; undefined means "all wallets". */
/**
 * Narrow the server's wallets to the ones a caller named.
 *
 * Every operation that touches a set of wallets — funding them, sweeping ETH
 * back, gathering NFTs — wants the same thing: all of them by default, a named
 * subset when asked. Doing it three times in three routes is how the three
 * quietly stop agreeing about what an unknown address means.
 *
 * An address the server does not hold is an error rather than a silent
 * omission: a typo would otherwise look like a successful run that touched
 * fewer wallets than asked, and the difference only shows up as money that
 * never arrived.
 */
function chooseWallets<T>(
  body: Record<string, unknown>,
  field: string,
  all: readonly T[],
  addressOf: (item: T) => string,
): T[] {
  const raw = body[field];
  if (!Array.isArray(raw)) return [...all];
  const want = [
    ...new Set(
      (raw as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((a) => a.trim().toLowerCase()),
    ),
  ];
  const known = new Map(all.map((item) => [addressOf(item).toLowerCase(), item]));
  const missing = want.filter((a) => !known.has(a));
  if (missing.length > 0) {
    throw new Error(`not wallets on this server: ${missing.slice(0, 3).join(", ")}`);
  }
  if (want.length === 0) throw new Error(`${field} was empty — no wallets chosen, nothing to do`);
  return want.map((a) => known.get(a)!);
}

function parseWalletFilter(body: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(body.wallets)) return undefined;
  const out = (body.wallets as unknown[])
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim().toLowerCase());
  for (const a of out) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`"${a}" is not a 0x address`);
  }
  return out.length > 0 ? out : undefined;
}

// ── Self-update ──────────────────────────────────────────────────────────────
/**
 * Pull the latest code and restart, triggered from the panel.
 *
 * The site and this server ship from the same repo but deploy separately, so
 * the box falls behind every time the site is published — and reaching a
 * terminal is exactly what someone away from their desk cannot do. This runs
 * the same two commands the README gives, over the same authenticated API as
 * everything else. It can only fast-forward the checkout it is already running
 * from: no caller input reaches the command line, and the remote is whatever
 * the box was cloned from.
 */
const run = promisify(execFile);

/** Heap ceiling for the update's typecheck, so it cannot starve the box. */
const TSC_HEAP_MB = envNumber(process.env.SNIPE_TSC_HEAP_MB, 320, 1);
/**
 * Headroom the typecheck needs beyond its own heap, for node itself.
 *
 * This used to be an absolute floor of 420MB of free RAM, which was a guess —
 * and on a 1GB instance the real figure sits around 380MB, so the guard
 * refused every update for eight hours running while reporting it as a memory
 * problem. The question is not "is there a lot of memory free" but "can a
 * capped typecheck run without the kernel having to kill something", and swap
 * counts towards that: it makes tsc slower, never fatal.
 */
const TSC_OVERHEAD_MB = envNumber(process.env.SNIPE_TSC_OVERHEAD_MB, 80, 1);

/**
 * Memory a new process could actually use, in MB — free RAM plus free swap.
 *
 * `freemem()` reads far too low on Linux, where the page cache counts as used;
 * `availableMemory()` is what the kernel itself reports as usable. Swap is read
 * from /proc, since node exposes no API for it.
 */
function usableMemoryMb(): number {
  const ram =
    typeof (os as { availableMemory?: () => number }).availableMemory === "function"
      ? (os as unknown as { availableMemory: () => number }).availableMemory()
      : os.freemem();
  let swapFreeKb = 0;
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    swapFreeKb = Number(/SwapFree:\s+(\d+)/.exec(meminfo)?.[1] ?? 0);
  } catch {
    // Not Linux, or /proc unavailable: RAM alone then.
  }
  return Math.round(ram / 1024 / 1024 + swapFreeKb / 1024);
}

async function gitHead(dir: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir });
  return stdout.trim();
}

interface UpdateResult {
  before: string;
  after: string;
  changed: boolean;
  detail: string;
  restarting: boolean;
}

async function selfUpdate(): Promise<UpdateResult> {
  const dir = process.cwd();
  let before: string;
  try {
    before = await gitHead(dir);
  } catch {
    throw new Error(
      `${dir} is not a git checkout, so there is nothing to pull — start the server from the cloned repo`,
    );
  }

  let detail: string;
  try {
    const { stdout } = await run("git", ["pull", "--ff-only"], { cwd: dir, timeout: 120_000 });
    detail = stdout.trim().split("\n").slice(-3).join(" · ");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const lines = `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // git's first line is usually "From <remote>"; the reason is further down.
    const said =
      lines.find((l) => /error|fatal|overwritten|conflict|diverged|refus/i.test(l)) ??
      lines[lines.length - 1];
    throw new Error(`git pull failed: ${said || "unknown reason"}`);
  }

  const after = await gitHead(dir);
  if (after === before) {
    return { before, after, changed: false, detail: "already up to date", restarting: false };
  }

  const usable = usableMemoryMb();
  const needed = TSC_HEAP_MB + TSC_OVERHEAD_MB;
  if (usable < needed) {
    await run("git", ["reset", "--hard", before], { cwd: dir }).catch(() => {});
    throw new Error(
      `${usable}MB of memory usable but the check needs ${needed}MB, so ${after} was rolled ` +
        `back to ${before}. Add swap (setup-vps.sh does), or lower SNIPE_TSC_HEAP_MB.`,
    );
  }

  // Dependencies only need reinstalling when the lockfile actually moved.
  const { stdout: touched } = await run("git", ["diff", "--name-only", before, after], { cwd: dir });
  if (touched.split("\n").some((f) => f.trim() === "package-lock.json")) {
    log("update: lockfile changed — installing dependencies");
    await run("npm", ["install", "--silent"], { cwd: dir, timeout: 600_000 });
  }

  // Restarting into code that doesn't compile leaves pm2 in a crash loop with
  // nothing serving, which on an unattended box means the next drop is simply
  // missed. Check first, and put the checkout back if it fails.
  //
  // The check is capped and guarded because it is not free: tsc wants a few
  // hundred MB, and on a 1GB box the kernel's OOM killer resolves that by
  // killing something — which once took the Cloudflare tunnel with it and left
  // the machine unreachable. A verification step must never be able to cost
  // more than the thing it verifies.
  try {
    await run("npx", ["tsc", "--noEmit"], {
      cwd: dir,
      timeout: 300_000,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${TSC_HEAP_MB}`.trim() },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const first = `${err.stdout ?? ""}${err.stderr ?? ""}`.split("\n").find((l) => l.includes("error"));
    await run("git", ["reset", "--hard", before], { cwd: dir }).catch(() => {});
    throw new Error(
      `${after} does not compile, so it was rolled back to ${before} and nothing restarted` +
        (first ? ` — ${first.trim()}` : ""),
    );
  }

  // Answer before the restart tears this process down; pm2 brings it back and
  // the tunnel is a separate process, so the URL and token do not change.
  setTimeout(() => {
    log("update: restarting");
    run("pm2", ["restart", "snipe-api"]).catch(() => process.exit(0));
  }, 400);

  return { before, after, changed: true, detail, restarting: true };
}

/**
 * The wallets the running job has signed transactions for, lowercased, or null
 * when nothing is running.
 *
 * A job with no wallet list of its own fires from every wallet on the box.
 */
function walletsOfActiveJob(): Set<string> | null {
  if (!activeJobId) return null;
  const job = jobs.find((j) => j.id === activeJobId);
  if (!job) return null;
  if (job.wallets && job.wallets.length > 0) {
    return new Set(job.wallets.map((w) => w.toLowerCase()));
  }
  try {
    const cfg = loadConfig(CONFIG_PATH);
    return new Set(
      loadKeyEntries(CONFIG_PATH, cfg.keysFile).map((e) =>
        privateKeyToAccount(e.key).address.toLowerCase(),
      ),
    );
  } catch {
    // Unreachable from the funding route, which loads the same config first and
    // fails there — but an empty set is the honest answer to "which wallets",
    // not a claim that none are firing.
    return new Set();
  }
}

/**
 * Why an update must not happen right now, or null if it may.
 *
 * A restart costs a few seconds of downtime, which is nothing except in the
 * window around a drop — so the rule is simply "only when the box has nothing
 * to do and nothing coming up soon".
 */
function updateBlockedBecause(): string | null {
  if (activeJobId) return "a job is running";
  if (jobs.some((j) => j.status === "armed")) return "a job is armed and about to fire";
  const soon = jobs.find(
    (j) =>
      j.status === "queued" &&
      j.startTime !== undefined &&
      j.startTime * 1000 - Date.now() <= UPDATE_BLACKOUT_MS,
  );
  if (soon) return `job ${soon.id} (${soon.label}) opens too soon`;
  return null;
}

/**
 * Pull updates on a timer so the box keeps in step with the published site
 * without anyone opening a terminal — the panel's button does the same thing,
 * but only while someone is looking at it.
 */
function startAutoUpdate() {
  if (!AUTO_UPDATE) {
    log("auto-update off (SNIPE_AUTO_UPDATE=0)");
    return;
  }
  const every =
    AUTO_UPDATE_MS >= 60_000
      ? `${Math.round(AUTO_UPDATE_MS / 60_000)} min`
      : `${Math.round(AUTO_UPDATE_MS / 1000)}s`;
  log(`auto-update every ${every} when idle`);
  const timer = setInterval(() => {
    const blocked = updateBlockedBecause();
    if (blocked) {
      log(`auto-update skipped — ${blocked}`);
      return;
    }
    void selfUpdate()
      .then((r) => {
        if (r.changed) log(`auto-update: ${r.before} → ${r.after} (${r.detail})`);
      })
      .catch((e) => log(`auto-update failed: ${e instanceof Error ? e.message : e}`));
  }, AUTO_UPDATE_MS);
  // Never hold the process open for this alone.
  timer.unref?.();
}

// ── Read endpoint ────────────────────────────────────────────────────────────
/**
 * The endpoint reads are *attempted* against first.
 *
 * Not the only one they can use: every read client is built with the chain's
 * own RPC behind this one, so a rate-limited provider costs a retry rather
 * than the whole request. This is what the panel displays.
 */
function readRpc(cfg: SnipeConfig, info: NonNullable<ReturnType<typeof getChainInfo>>): string {
  return readRpcs(cfg)[0] ?? info.chain.rpcUrls.default.http[0];
}

/** The endpoint the panel is looking at when it asks who answered a scan. */
function scanRpc(cfg: SnipeConfig, info: NonNullable<ReturnType<typeof getChainInfo>>): string {
  return scanRpcs(cfg)[0] ?? info.chain.rpcUrls.default.http[0];
}

/**
 * What the scan endpoint said when asked for a range worth scanning with, or
 * null while it has not been asked or had nothing to complain about. Surfaced
 * to the panel, so the badge stops naming an endpoint that never answers a
 * single log request.
 */
let scanRpcNote: string | null = null;

async function checkScanEndpoint(cfg: SnipeConfig): Promise<void> {
  const info = getChainInfo(cfg.chainId);
  if (!info) return;
  const url = scanRpcs(cfg)[0];
  if (!url) return;
  try {
    const client = makeReadClient(info.chain, [url]);
    const tip = await client.getBlockNumber();
    const verdict = await probeLogRange(url, SEADROP, tip);
    if (verdict.ok) return;
    const cap = verdict.suggested ? `${verdict.suggested} blocks at a time` : "a much smaller range";
    scanRpcNote =
      `${rpcHost(url)} won't serve eth_getLogs over ${PROBE_BLOCKS} blocks — it allows ${cap}, ` +
      "so scans fall through to the next endpoint instead";
    log(`scan endpoint: ${scanRpcNote}`);
    if (verdict.reason) log(`scan endpoint said: ${verdict.reason}`);
  } catch {
    // Couldn't ask. Say nothing rather than accuse a working endpoint.
  }
}

/**
 * Hosts, without repeats. Two keys from one provider are two endpoints with
 * the same host, and printing both made the startup line read like a bug.
 */
function uniq(hosts: string[]): string[] {
  return [...new Set(hosts)];
}

/** Host only — the full URL usually carries a provider API key. */
function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/**
 * Persist the endpoints the panel is using, so server-side reads (balances,
 * funding, sweeps) go through the same paid endpoint the browser does instead
 * of the rate-limited public one. Written back to the config file so it
 * survives a restart.
 */
/**
 * Ask an endpoint which chain it serves. A typo or a URL for the wrong network
 * would otherwise be stored and then silently break every balance read, so it
 * is checked before it is written rather than after it causes confusion.
 */
async function probeChainId(url: string): Promise<number> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!body.result) throw new Error(body.error?.message ?? "no chain id in the reply");
    return Number(BigInt(body.result));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every endpoint reads may go through, best first.
 *
 * The box's own setting leads: it is the one someone chose deliberately and
 * the one that survives a browser nobody has opened today.
 */
function readRpcs(cfg: SnipeConfig): string[] {
  return withEnvRpcs(cfg.extraRpcs);
}

/**
 * Every endpoint the heavy read-only routes may go through — the scanner, the
 * live feed, the drop list, the profit report.
 *
 * Falls back to the mint path's endpoints when no separate one is set, which
 * is the single-key case and the default.
 */
function scanRpcs(cfg: SnipeConfig): string[] {
  return layered(SCAN_ENV_RPCS, cfg);
}

/** Every endpoint a queued mint may arm and broadcast through, best first. */
function mintRpcs(cfg: SnipeConfig): string[] {
  return layered(MINT_ENV_RPCS, cfg);
}

/**
 * A dedicated list in front, the general one behind, and nothing duplicated.
 * An empty dedicated list means this job has none of its own and simply uses
 * the general endpoints — which is the one-key case, and the default.
 */
function layered(dedicated: readonly string[], cfg: SnipeConfig): string[] {
  if (dedicated.length === 0) return readRpcs(cfg);
  const out = [...dedicated];
  for (const u of readRpcs(cfg)) if (!out.includes(u)) out.push(u);
  return out;
}

/** The same rule for a list that arrived from somewhere else. */
function withEnvRpcs(urls: readonly string[]): string[] {
  const out = [...ENV_RPCS];
  for (const u of urls) if (!out.includes(u)) out.push(u);
  return out;
}

function saveExtraRpcs(urls: string[]): string[] {
  const clean: string[] = [];
  for (const u of urls) {
    const t = u.trim();
    if (!t) continue;
    let parsed: URL;
    try {
      parsed = new URL(t);
    } catch {
      throw new Error(`"${t.slice(0, 40)}" is not a URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("RPC endpoints must be http(s)");
    }
    if (!clean.includes(t)) clean.push(t);
  }
  if (clean.length > 8) throw new Error("that is more endpoints than is useful — keep it under eight");

  const abs = resolve(CONFIG_PATH);
  const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  raw.extraRpcs = clean;
  writeFileSync(abs, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  // Balances were read through the old endpoint; don't serve them as if they
  // came from the new one.
  balanceCache = null;
  return clean;
}

// ── Wallets ──────────────────────────────────────────────────────────────────
/**
 * Wallet management is deliberately write-only: keys go in, and only addresses
 * come back. Even with the token, this API cannot be used to read out a key
 * that is already on the box.
 */
function writeKeys(entries: KeyEntry[]) {
  const cfg = loadConfig(CONFIG_PATH);
  const abs = keysPath(CONFIG_PATH, cfg.keysFile);
  // 0600: readable only by the user running the server.
  writeFileSync(abs, serialiseKeys(entries), { mode: 0o600 });
}

/**
 * Balances are the expensive part of the wallet list, and two panels poll it
 * every few seconds. Serving a few-second-old number costs nothing and keeps a
 * hundred-wallet set from spending the endpoint's whole rate budget on a view.
 */
const BALANCE_TTL_MS = 10_000;
let balanceCache: { at: number; values: Map<string, string> } | null = null;

/** Addresses, labels and balances — never keys. */
async function walletsView() {
  const cfg = loadConfig(CONFIG_PATH);
  const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
  const info = getChainInfo(cfg.chainId);
  const addresses = entries.map((e) => ({
    address: privateKeyToAccount(e.key).address,
    label: e.label,
  }));

  let balances = new Map<string, string>();
  const fresh = balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS;
  if (fresh && balanceCache) {
    balances = balanceCache.values;
  } else if (info && addresses.length > 0) {
    try {
      const client = makeReadClient(info.chain, readRpcs(cfg));
      const got = await mapWithLimit(addresses, (a) => client.getBalance({ address: a.address }));
      balances = new Map(addresses.map((a, i) => [a.address, formatEther(got[i])]));
      balanceCache = { at: Date.now(), values: balances };
    } catch (e) {
      // Balances are a nicety; the list itself must still render. Say why once
      // so a rate limit doesn't look like the wallets have no money.
      log(`balances unavailable: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      balances = balanceCache?.values ?? new Map();
    }
  }

  return {
    chainId: cfg.chainId,
    chain: info?.label,
    readRpc: info ? rpcHost(readRpc(cfg, info)) : null,
    wallets: addresses.map((a) => ({ ...a, balance: balances.get(a.address) ?? null })),
  };
}

/** Send the run summary to Telegram, if configured. Never throws. */
async function notify(job: Job) {
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch {
    return;
  }
  if (!cfg.telegram) return;
  const plan = job.result?.plan;
  const outcomes = job.result?.outcomes;
  if (!plan) return;

  const wallets: MintedWallet[] = (outcomes ?? []).map((o) => ({
    address: o.address,
    status: o.status,
    quantity: o.tokenIds?.length ?? 0,
    tokenIds: o.tokenIds ?? [],
    txHash: o.txHash,
    detail: o.detail,
  }));

  const slug = plan.openSeaSlug;
  const parts = formatMintReport({
    collectionName: plan.name,
    collection: plan.collection,
    chainLabel: plan.chain,
    stage: plan.stage,
    dryRun: job.request.dryRun,
    collectionUrl: `https://opensea.io/assets/${slug}/${plan.collection}`,
    itemUrl: (id) => `https://opensea.io/item/${slug}/${plan.collection}/${id}`,
    profileUrl: (a) => `https://opensea.io/${a}`,
    explorerTxUrl: (h) => `${plan.explorerUrl}/tx/${h}`,
    wallets,
  });

  // In order, and one at a time: Telegram shows them in the order they arrive,
  // and the overview is only useful if it arrives first.
  let sent = 0;
  for (const part of parts) {
    const r = await sendTelegram(cfg.telegram, part);
    if (r.ok) sent += 1;
    else log(`telegram failed: ${r.error}`);
  }
  log(`telegram: ${sent}/${parts.length} message(s) sent for job ${job.id}`);
}

/** Run one job to completion, then notify. Only ever called by the scheduler. */
async function execute(job: Job) {
  activeJobId = job.id;
  const abort = new AbortController();
  job.abort = abort;
  job.status = "armed";
  persistJobs();
  let keys = loadKeys(CONFIG_PATH, loadConfig(CONFIG_PATH).keysFile);
  if (job.wallets && job.wallets.length > 0) {
    const want = new Set(job.wallets);
    keys = keys.filter((k) => want.has(privateKeyToAccount(k).address.toLowerCase()));
    if (keys.length === 0) {
      job.status = "error";
      job.error = "none of the wallets chosen for this job are on the server any more";
      activeJobId = null;
      persistJobs();
      return;
    }
  }
  log(`job ${job.id} (${job.label}) arming — ${job.request.dryRun ? "dry run" : "LIVE"}`);

  try {
    const result = await runSnipe(
      { ...job.request, keys },
      {
        signal: abort.signal,
        onLog: (line) => {
          const entry = `[${stamp()}] ${line}`;
          job.logs.push(entry);
          if (job.logs.length > 500) job.logs.shift();
          console.log(`  ${entry}`);
        },
      },
    );
    job.result = result;
    job.startTime = result.plan.startTime;
    // Remember what was minted, so a later "what do my wallets hold" needs no
    // index: reading Transfer logs is fast but has to be told which contract.
    if (!job.request.dryRun) {
      rememberCollection(CONFIG_PATH, {
        address: job.request.collection,
        name: result.plan.name,
      });
      // Gas spent is only in a receipt nobody will fetch again; write it down
      // now or the profit figure can never be worked out.
      recordMint(CONFIG_PATH, {
        at: Date.now(),
        collection: job.request.collection,
        collectionName: result.plan.name,
        chainId: result.plan.chainId,
        stage: result.plan.stage,
        wallets: (result.outcomes ?? []).map((o) => ({
          address: o.address,
          tokenIds: o.tokenIds ?? [],
          gasWei: o.gasWei ?? "0",
          valueWei: o.valueWei ?? "0",
          status: o.status,
        })),
      });
    }
    // The abort route may have fired while this was running; the signal is the
    // authority, since `status` was narrowed to "armed" above.
    job.status = abort.signal.aborted ? "aborted" : "done";
  } catch (e) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    log(`job ${job.id} failed: ${job.error}`);
  } finally {
    activeJobId = null;
    // Finished, one way or another — it leaves the file either way.
    persistJobs();
  }
  await consolidate(job);
  await notify(job);
}

/**
 * Move what this run just minted onto one wallet, when the config asks for it.
 * The token ids come from the receipts the run already decoded, so this needs
 * no holdings lookup and can't pick up anything the run didn't mint.
 */
async function consolidate(job: Job) {
  if (job.request.dryRun) return;
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch {
    return;
  }
  const to = cfg.consolidateTo;
  if (!to) return;

  const outcomes = job.result?.outcomes ?? [];
  const collection = job.request.collection;
  const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
  const keyByAddress = new Map(
    entries.map((e) => [privateKeyToAccount(e.key).address.toLowerCase(), e.key] as const),
  );

  const holdings = outcomes
    .filter((o) => o.status === "mined" && (o.tokenIds?.length ?? 0) > 0)
    // A wallet that is itself the destination has nothing to move.
    .filter((o) => o.address.toLowerCase() !== to.toLowerCase())
    .map((o) => ({
      key: keyByAddress.get(o.address.toLowerCase()),
      items: (o.tokenIds ?? []).map((tokenId) => ({ collection, tokenId })),
    }))
    .filter((h): h is { key: `0x${string}`; items: { collection: `0x${string}`; tokenId: string }[] } =>
      Boolean(h.key),
    );

  if (holdings.length === 0) return;
  try {
    const r = await sweepNfts(
      {
        chainId: job.request.chainId,
        extraRpcs: job.request.extraRpcs,
        gas: { maxFeeGwei: job.request.gas.maxFeeGwei, tipGwei: job.request.gas.tipGwei },
        holdings,
        to,
        dryRun: false,
      },
      (line) => {
        const entry = `[${stamp()}] consolidate: ${line}`;
        job.logs.push(entry);
        console.log(entry);
      },
    );
    job.consolidated = { to, moved: r.moved, total: r.total };
  } catch (e) {
    // A failed sweep must not turn a successful mint into a failed job — the
    // tokens are minted either way and can be swept by hand.
    const msg = e instanceof Error ? e.message : String(e);
    job.logs.push(`[${stamp()}] consolidate failed: ${msg}`);
    log(`consolidate failed for job ${job.id}: ${msg}`);
  }
}

/**
 * Scheduler tick. Picks the next job to run: a job is due when its stage is
 * within ARM_LEAD_MS (or already open), and nothing else is armed. Jobs whose
 * start time isn't known yet are treated as due immediately — the run itself
 * reads the drop and then holds.
 */
function tick() {
  if (activeJobId) return;
  const now = Date.now();
  const due = jobs
    .filter((j) => j.status === "queued")
    .filter((j) => j.startTime === undefined || j.startTime * 1000 - now <= ARM_LEAD_MS)
    // Soonest stage first; unknown start times go last so a dated job wins.
    .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
  const next = due[0];
  if (next) void execute(next);
}
setInterval(tick, 1000);

/**
 * Bring back whatever was still pending when this process last stopped.
 *
 * Done before the scheduler's first tick has anything to look at, so a job
 * whose stage is minutes away is armed on time rather than noticed late.
 */
function restoreQueue(): void {
  const stored = loadJobs(CONFIG_PATH);
  if (stored.length === 0) return;
  const now = Date.now();
  let back = 0;
  for (const j of stored) {
    const state = restoreStatus(j, now);
    jobs.push({
      id: j.id,
      label: j.label,
      addedAt: j.addedAt,
      status: state.status,
      request: j.request,
      startTime: j.startTime,
      wallets: j.wallets,
      logs: [],
      ...(state.status === "error" ? { error: state.error } : {}),
    });
    if (state.status === "queued") back++;
    else log(`queue: job ${j.id} (${j.label}) — ${state.error}`);
  }
  persistJobs();
  const when = (j: StoredJob) =>
    j.startTime ? new Date(j.startTime * 1000).toISOString() : "start unknown";
  log(
    `queue      restored ${back}/${stored.length} pending job(s) from disk` +
      (back > 0
        ? ` — next ${stored
            .filter((j) => j.startTime)
            .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
            .map(when)[0] ?? "unknown"}`
        : ""),
  );
}
restoreQueue();

/**
 * Find the address this box is reachable at and, if it has changed, say so in
 * Telegram.
 *
 * A quick tunnel gets a new random hostname every time cloudflared starts, and
 * prints it once. Without this, a tunnel restart silently cuts the panel off
 * and the new address is recoverable only from a terminal on the box — which
 * is exactly what someone with only a phone does not have. The last announced
 * URL is kept next to the config so a plain server restart stays quiet.
 */
const TUNNEL_STATE = () => `${resolve(CONFIG_PATH)}.tunnel`;

async function announceTunnel(): Promise<void> {
  const url = await currentTunnelUrl();
  tunnelUrl = url;
  if (!url) {
    log("tunnel URL unknown (no pm2 'tunnel' process, or it hasn't printed one)");
    return;
  }
  log(`tunnel     ${url}`);

  let previous: string | null = null;
  try {
    previous = readFileSync(TUNNEL_STATE(), "utf8").trim() || null;
  } catch {
    // First run — there is nothing to compare against, so announce it.
  }
  if (previous === url) return;

  try {
    writeFileSync(TUNNEL_STATE(), `${url}\n`, { mode: 0o600 });
  } catch {
    // Not being able to remember it only means we announce again next time.
  }

  const cfg = (() => {
    try {
      return loadConfig(CONFIG_PATH);
    } catch {
      return null;
    }
  })();
  if (!cfg?.telegram) return;
  const what = previous ? "changed" : "is";
  await sendTelegram(
    cfg.telegram,
    `<b>Server address ${what}</b>\n<code>${url}</code>\n\nPaste it into the panel's <b>server URL</b> field. Your token has not changed.`,
  ).catch(() => undefined);
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Unauthenticated liveness probe — says nothing about the wallets.
  if (url.pathname === "/api/ping") {
    json(res, 200, { ok: true, service: "launchpad-snipe", apiVersion: API_VERSION });
    return;
  }

  if (!tokenOk(req.headers.authorization)) {
    json(res, 401, { error: "bad or missing token" });
    return;
  }

  try {
    if (url.pathname === "/api/status" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      json(res, 200, {
        apiVersion: API_VERSION,
        running: activeJobId !== null,
        activeJobId,
        armLeadMs: ARM_LEAD_MS,
        autoUpdate: AUTO_UPDATE ? AUTO_UPDATE_MS : null,
        // Hosts only — the full URLs carry provider API keys.
        tunnelUrl,
        rpcHosts: readRpcs(cfg).map(rpcHost),
        readRpc: info ? rpcHost(readRpc(cfg, info)) : null,
        jobs: jobs.map(jobView),
      });
      return;
    }

    /**
     * Pull the latest code and restart. Refused while a job is armed or
     * running — a restart mid-mint would lose it.
     */
    if (url.pathname === "/api/update" && req.method === "POST") {
      const blocked = updateBlockedBecause();
      if (blocked) {
        json(res, 409, { error: `${blocked} — a restart now could cost you the mint` });
        return;
      }
      const result = await selfUpdate();
      log(`update: ${result.before} → ${result.after} (${result.detail})`);
      json(res, 200, result);
      return;
    }

    /**
     * Store the endpoints the panel is using. Reads on the server (balances,
     * funding, sweeps) then go through the same paid endpoint instead of the
     * public one, which is what a hundred-wallet set needs to stay inside a
     * rate limit.
     */
    if (url.pathname === "/api/rpcs" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.extraRpcs)) throw new Error("extraRpcs must be a list of URLs");
      const wanted = (body.extraRpcs as unknown[]).filter((x): x is string => typeof x === "string");
      const chainId = loadConfig(CONFIG_PATH).chainId;
      for (const u of wanted) {
        let got: number;
        try {
          got = await probeChainId(u.trim());
        } catch (e) {
          throw new Error(
            `${rpcHost(u)} did not answer: ${e instanceof Error ? e.message : e}`,
          );
        }
        if (got !== chainId) {
          throw new Error(`${rpcHost(u)} serves chain ${got}, not ${chainId}`);
        }
      }
      const saved = saveExtraRpcs(wanted);
      log(`read/blast endpoints set to: ${saved.map(rpcHost).join(", ") || "(none)"}`);
      json(res, 200, { rpcHosts: saved.map(rpcHost) });
      return;
    }

    if (url.pathname === "/api/wallets" && req.method === "GET") {
      json(res, 200, await walletsView());
      return;
    }

    // Add wallets. Keys are accepted, stored, and never handed back.
    if (url.pathname === "/api/wallets" && req.method === "POST") {
      const body = await readBody(req);
      const raw = typeof body.keys === "string" ? body.keys : "";
      if (!raw.trim()) throw new Error("no keys supplied");

      const cfg = loadConfig(CONFIG_PATH);
      const existing = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      const have = new Set(existing.map((e) => e.key));
      const label = typeof body.label === "string" ? body.label.slice(0, 60) : undefined;

      let added = 0;
      const rejected: string[] = [];
      for (const line of raw.split(/[\s,]+/)) {
        const t = line.trim();
        if (!t) continue;
        let key: `0x${string}`;
        try {
          key = normalizePrivateKey(t);
        } catch {
          // Never echo the offending text back — it is a private key.
          rejected.push("not a valid 64-hex private key");
          continue;
        }
        if (have.has(key)) continue;
        have.add(key);
        existing.push({ key, label });
        added += 1;
      }
      if (added > 0) writeKeys(existing);
      log(`wallets: added ${added}${rejected.length ? `, rejected ${rejected.length}` : ""}`);
      json(res, 200, { added, rejected: rejected.length, ...(await walletsView()) });
      return;
    }

    // Removes one wallet (?address=) or a batch (JSON body {addresses:[…]}),
    // so clearing out a set doesn't mean one request per wallet.
    if (url.pathname === "/api/wallets" && req.method === "DELETE") {
      if (activeJobId) {
        json(res, 409, { error: "a job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const requested = Array.isArray(body.addresses)
        ? (body.addresses as unknown[]).filter((a): a is string => typeof a === "string")
        : [url.searchParams.get("address") ?? ""];

      const wanted = new Set<string>();
      for (const a of requested) {
        const lower = a.trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error(`"${a}" is not a 0x address`);
        wanted.add(lower);
      }
      if (wanted.size === 0) throw new Error("no addresses given");

      const cfg = loadConfig(CONFIG_PATH);
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      const kept = entries.filter(
        (e) => !wanted.has(privateKeyToAccount(e.key).address.toLowerCase()),
      );
      const removed = entries.length - kept.length;
      if (removed === 0) {
        json(res, 404, { error: "none of those addresses are on the server" });
        return;
      }
      writeKeys(kept);
      log(`wallets: removed ${removed} of ${wanted.size} requested`);
      json(res, 200, { removed, ...(await walletsView()) });
      return;
    }

    // ── NFTs: see what the wallet set holds, and gather it onto one wallet ──
    /**
     * What each drop cost and what it has made, from the chain alone.
     *
     * Cost comes from the ledger the runner writes as it mints; revenue from
     * pairing every departure of a token with the seller's balance rise in
     * that block. No marketplace API, so nothing to key or to break.
     */
    // Drops someone added through the bot. Read-only from here: they are
    // entered on a phone, where the bot is, and this is the window onto them.
    // ── Scanner: drops configured on-chain but not yet announced ──────────
    if (url.pathname === "/api/scan" && req.method === "GET") {
      const hours = Math.min(
        MAX_SCAN_HOURS,
        Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24),
      );
      const fresh = url.searchParams.get("fresh") === "1";
      const hit = scanCache.get(hours);
      if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) {
        json(res, 200, { ...hit.body, cachedAt: hit.at });
        return;
      }
      // Two panels asking at once should cost one scan, not two.
      const inflight = scanInflight.get(hours);
      json(res, 200, await (inflight ?? startScan(hours)));
      return;
    }

    /**
     * Who a collection is and what its floor is, as far as anyone off-chain
     * has said. Neither is on the chain.
     *
     * Answers cost a large page fetch each, so this never blocks on one: it
     * returns what is cached and reports the rest as pending while they are
     * read in the background. The panel asks about the rows on screen and
     * asks again a moment later.
     */
    /**
     * What is minting right now, ranked. Same hour of logs the scanner's
     * columns come from, so asking for both costs one query, not two.
     */
    if (url.pathname === "/api/live" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);
      const client = makeReadClient(info.chain, scanRpcs(cfg));
      const tip = await client.getBlockNumber();
      if (!blockRate || Date.now() - blockRate.at > BLOCK_RATE_TTL_MS) {
        blockRate = { at: Date.now(), perHour: await measureBlockRate(client as never, tip) };
      }
      const minutes = nearestWindow(
        Number(url.searchParams.get("minutes") ?? DEFAULT_LIVE_MINUTES) || DEFAULT_LIVE_MINUTES,
      );
      const rows = await liveRows(client as never, tip, blockRate.perHour, minutes);
      json(res, 200, {
        rows,
        minutes,
        windows: LIVE_WINDOWS,
        error: pulseError,
        readRpc: rpcHost(scanRpc(cfg, info)),
        publicRpc: scanRpcs(cfg).length === 0,
        related: creators.relatedFor(rows.map((r) => r.contract)),
        knownCollections: creators.size,
        now: Math.floor(Date.now() / 1000),
        chain: info.label,
        openSeaSlug: info.openSeaSlug,
        cachedAt: liveCache.get(minutes)?.at,
      });
      return;
    }

    if (url.pathname === "/api/collection-info" && req.method === "GET") {
      const contracts = (url.searchParams.get("contracts") ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c));
      if (contracts.length === 0) {
        json(res, 200, { known: {}, pending: [] });
        return;
      }
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      const found = lookupCollections(
        info?.openSeaSlug ?? "ethereum",
        contracts.slice(0, 120),
        60,
        (n: string) => log(n),
      );
      // A handle is a fact about a contract, so it goes into the same index the
      // owner does — that is what makes "this Twitter has launched four
      // collections" answerable at all.
      for (const [contract, meta] of Object.entries(found.known)) {
        creators.remember({ contract, twitter: meta.twitter });
      }
      json(res, 200, {
        ...found,
        twitters: creators.relatedFor(Object.keys(found.known)).twitters,
      });
      return;
    }

    /**
     * Everything known about one collection, for filling a form in.
     *
     * Typing a contract into the watchlist should not then mean typing its
     * name, supply and handle as well — they are all readable, and the reason
     * they were being retyped is that nothing had asked for them together.
     *
     * The handle comes from the marketplace lookup, which answers in the
     * background; this waits a few seconds for it rather than making the form
     * poll, and returns without it if it does not land. A missing handle costs
     * that field, not the reply.
     */
    /**
     * The public stage of several collections at once.
     *
     * The watchlist shows the same table the scanner does, and that table is
     * about one thing: the public drop. Reading it per row would be a request
     * each; this is one multicall for the lot, through the same enrichment the
     * scanner uses so the two cannot disagree about what a collection is.
     */
    if (url.pathname === "/api/drops" && req.method === "GET") {
      const contracts = (url.searchParams.get("contracts") ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c))
        .slice(0, 120) as `0x${string}`[];
      if (contracts.length === 0) {
        json(res, 200, { drops: [] });
        return;
      }
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);
      const client = makeReadClient(info.chain, scanRpcs(cfg));

      // The public stage, straight off SeaDrop — never an allow-list one.
      const stages = (await client.multicall({
        multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
        allowFailure: true,
        contracts: contracts.map((c) => ({
          address: SEADROP as `0x${string}`,
          abi: PUBLIC_DROP_ABI,
          functionName: "getPublicDrop",
          args: [c],
        })) as never,
      })) as { status: string; result?: unknown }[];

      const base = contracts.map((contract, i) => {
        const r = stages[i];
        const d = r?.status === "success" ? (r.result as Record<string, unknown>) : undefined;
        return {
          contract,
          priceWei: d ? String(d.mintPrice ?? 0n) : "0",
          startTime: d ? Number(d.startTime ?? 0) : 0,
          endTime: d ? Number(d.endTime ?? 0) : 0,
          maxPerWallet: d ? Number(d.maxTotalMintableByWallet ?? 0) : 0,
          feeBps: d ? Number(d.feeBps ?? 0) : 0,
          block: 0,
        };
      });

      const enriched = await enrichDrops(client as never, base);
      for (const d of enriched) {
        creators.remember({ contract: d.contract, name: d.name, startTime: d.startTime, owner: d.owner });
      }
      json(res, 200, {
        drops: enriched,
        openSeaSlug: info.openSeaSlug,
        related: creators.relatedFor(enriched.map((d) => d.contract)),
        nativeSymbol: info.chain.nativeCurrency.symbol,
        nativeUsd: await nativeUsd(info.blockscoutApi),
      });
      return;
    }

    if (url.pathname === "/api/collection-preview" && req.method === "GET") {
      const contract = (url.searchParams.get("contract") ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        json(res, 400, { error: "not a contract address" });
        return;
      }
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      const addr = contract as `0x${string}`;

      const dropPromise = peekDrop(addr, []);
      lookupCollections(info?.openSeaSlug ?? "ethereum", [addr], 4, (n: string) => log(n));

      const drop = await dropPromise;
      let meta = creatorsMeta(addr);
      for (let i = 0; i < 7 && !meta; i++) {
        await new Promise((r) => setTimeout(r, 500));
        meta = creatorsMeta(addr);
      }

      json(res, 200, {
        contract: addr,
        name: drop?.name,
        maxSupply: drop?.maxSupply,
        totalSupply: drop?.totalSupply,
        priceWei: drop?.priceWei,
        startTime: drop?.startTime,
        endTime: drop?.endTime,
        perWallet: drop?.perWallet,
        twitter: meta?.twitter ?? null,
        site: meta?.site ?? null,
        /** False when the chain had nothing configured for this address. */
        onChain: drop !== undefined,
      });
      return;
    }

    if (url.pathname === "/api/upcoming" && req.method === "GET") {
      const info = getChainInfo(loadConfig(CONFIG_PATH).chainId);
      json(res, 200, {
        upcoming: sortByDate(loadUpcoming(CONFIG_PATH)),
        // So a row with a contract can link the same way every other table
        // in the app does.
        openSeaSlug: info?.openSeaSlug,
      });
      return;
    }

    /**
     * Add a drop from the panel rather than from the bot.
     *
     * Same four fields and the same validation — they share `buildUpcoming`,
     * so a name the bot accepts cannot be one the form rejects.
     */
    if (url.pathname === "/api/upcoming" && req.method === "POST") {
      const body = await readBody(req);
      const built = buildUpcoming(
        {
          name: String(body.name ?? ""),
          twitter: String(body.twitter ?? ""),
          contract: body.contract === undefined ? undefined : String(body.contract),
          supply: body.supply === undefined ? undefined : String(body.supply),
          when: body.when === undefined ? undefined : String(body.when),
        },
        Math.floor(Date.now() / 1000),
      );
      if ("error" in built) {
        json(res, 400, { error: built.error });
        return;
      }
      const { list, duplicate } = addUpcoming(CONFIG_PATH, built.mint);
      if (duplicate) {
        // Not an error: the caller wanted this drop watched and it is. Saying
        // so as a failure would have the panel show a red button for the one
        // outcome that is exactly what was asked for.
        log(`upcoming: ${built.mint.name} is already on the list — not added twice`);
        json(res, 200, { added: duplicate, duplicate: true, upcoming: sortByDate(list) });
        return;
      }
      log(`upcoming: added ${built.mint.name} from the panel`);
      json(res, 200, { added: built.mint, upcoming: sortByDate(list) });
      return;
    }

    /** Paint one entry. The calendar is the only caller. */
    if (url.pathname === "/api/upcoming" && req.method === "PATCH") {
      const id = url.searchParams.get("id") ?? "";
      const body = await readBody(req);
      const wanted = body.color;
      if (wanted !== undefined && !isPickable(wanted)) {
        json(res, 400, { error: `color must be one of ${PICKABLE.join(", ")}` });
        return;
      }
      const { updated, list } = recolorUpcoming(CONFIG_PATH, id, wanted as string | undefined);
      json(res, updated ? 200 : 404, {
        updated,
        upcoming: sortByDate(list),
        ...(updated ? {} : { error: `no upcoming mint with id ${id}` }),
      });
      return;
    }

    if (url.pathname === "/api/upcoming" && req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      const { removed, list } = removeUpcoming(CONFIG_PATH, id);
      json(res, removed ? 200 : 404, {
        removed: removed?.name,
        upcoming: sortByDate(list),
        ...(removed ? {} : { error: `no upcoming mint with id ${id}` }),
      });
      return;
    }

    if (url.pathname === "/api/profit" && req.method === "GET") {
      // Reading every wallet's whole history takes far longer than the hundred
      // seconds a Cloudflare tunnel allows a request, and this server does one
      // thing at a time — which is why a Dashboard left open used to stall the
      // Snipe tab and then fail anyway. So the work happens in the background:
      // the first ask starts it and says so, the next ask gets the answer.
      const fresh = url.searchParams.get("fresh") === "1";
      if (fresh && !profitBuilding) {
        clearProfitCaches();
        profitCache = null;
      }
      if (profitCache && Date.now() - profitCache.at < PROFIT_TTL_MS) {
        json(res, 200, { ...profitCache.body, cachedAt: profitCache.at });
        return;
      }
      const building = startProfitBuild();
      // Give it a few seconds first: with the caches warm it is usually done
      // well inside that, and then there is nothing to come back for.
      let why: string | null = null;
      const quick = await Promise.race([
        building
          .then(() => "done" as const)
          .catch((e) => {
            why = e instanceof Error ? e.message : String(e);
            return "failed" as const;
          }),
        new Promise<"slow">((r) => setTimeout(() => r("slow"), PROFIT_WAIT_MS)),
      ]);
      if (quick === "done" && profitCache) {
        json(res, 200, { ...profitCache.body, cachedAt: profitCache.at });
        return;
      }
      // The reason travels with the failure. "See the server log" is not an
      // error message, it is an instruction to go and find one — and the whole
      // point of a panel talking to a box over a tunnel is not having to.
      if (quick === "failed") {
        throw new Error(`couldn't read the chain: ${why ?? "no reason given"}`);
      }
      json(res, 202, {
        building: true,
        // Something to show while it works, if there is anything at all.
        ...(profitCache ? { ...profitCache.body, cachedAt: profitCache.at, stale: true } : {}),
      });
      return;
    }

    if (url.pathname === "/api/nfts" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);

      const onlyRaw = url.searchParams.get("collection");
      const only =
        onlyRaw && /^0x[0-9a-fA-F]{40}$/.test(onlyRaw) ? (onlyRaw as `0x${string}`) : undefined;

      const addresses = loadKeyEntries(CONFIG_PATH, cfg.keysFile).map(
        (e) => privateKeyToAccount(e.key).address,
      );
      const started = Date.now();
      const client = makeReadClient(info.chain, readRpcs(cfg));

      // Two queries cover every wallet and every collection, so there is
      // nothing to discover first and nothing that can be missed.
      const scan = await scanChain(client as never, addresses, { collection: only });
      const tookMs = Date.now() - started;
      log(
        `nft scan: ${addresses.length} wallets → ${scan.totalTokens} tokens across ` +
          `${scan.collections.length} collection(s) in ${tookMs}ms`,
      );

      json(res, 200, {
        chain: info.label,
        explorerUrl: info.explorerUrl,
        openSeaSlug: info.openSeaSlug,
        checked: addresses.length,
        withTokens: scan.walletsWithTokens,
        totalTokens: scan.totalTokens,
        collections: scan.collections.map((c) => ({
          collection: c.collection,
          name: c.name,
          totalTokens: c.totalTokens,
          wallets: c.wallets,
        })),
        // Flat shape too, so the sweep panel keeps working unchanged.
        holdings: scan.collections.flatMap((c) =>
          c.wallets.map((w) => ({
            wallet: w.wallet,
            collection: c.collection,
            collectionName: c.name,
            tokenIds: w.tokenIds,
          })),
        ),
        tookMs,
      });
      return;
    }

    if (url.pathname === "/api/sweep-nfts" && req.method === "POST") {
      if (activeJobId) {
        json(res, 409, { error: "a mint job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("to must be a 0x address");
      const only =
        typeof body.collection === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.collection)
          ? (body.collection as `0x${string}`)
          : undefined;

      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);
      const allEntries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      // Which wallets to gather from. Sweeping every wallet is the common case
      // and stays the default, but gathering a few onto one address and a few
      // onto another is a real thing to want, and doing it by sweeping the lot
      // and sending half back is both slower and more gas.
      const entries = chooseWallets(body, "from", allEntries, (e) =>
        privateKeyToAccount(e.key).address,
      );
      const addresses = entries.map((e) => privateKeyToAccount(e.key).address);

      // One scan for every chosen wallet and every collection, so a sweep
      // can't move what it happened to see and silently leave the rest.
      const client = makeReadClient(info.chain, readRpcs(cfg));
      const scan = await scanChain(client as never, addresses, { collection: only });

      const byWallet = new Map<string, Holding[]>();
      for (const c of scan.collections) {
        for (const w of c.wallets) {
          const list = byWallet.get(w.wallet.toLowerCase()) ?? [];
          list.push({
            wallet: w.wallet,
            collection: c.collection,
            collectionName: c.name,
            tokenIds: w.tokenIds,
          });
          byWallet.set(w.wallet.toLowerCase(), list);
        }
      }

      const perWallet = entries.map((e) => {
        const address = privateKeyToAccount(e.key).address;
        const held = byWallet.get(address.toLowerCase()) ?? [];
        return {
          key: e.key,
          items: held.flatMap((h) =>
            // Never move a token to the wallet it already sits on.
            address.toLowerCase() === to.toLowerCase()
              ? []
              : h.tokenIds.map((tokenId) => ({ collection: h.collection, tokenId })),
          ),
        };
      });
      log(
        `sweep: ${perWallet.reduce((n, p) => n + p.items.length, 0)} token(s) to move ` +
          `from ${perWallet.filter((p) => p.items.length > 0).length} wallet(s)`,
      );

      const result = await sweepNfts(
        {
          chainId: cfg.chainId,
          extraRpcs: readRpcs(cfg),
          gas: { maxFeeGwei: cfg.gas.maxFeeGwei, tipGwei: cfg.gas.tipGwei },
          holdings: perWallet,
          to: to as `0x${string}`,
          dryRun: body.dryRun !== false,
        },
        (line) => log(`nft-sweep: ${line}`),
      );
      json(res, 200, result);
      return;
    }

    // ── Funding: fan money out to the wallet set, or sweep it back ──────────
    if (url.pathname === "/api/disperse" && req.method === "POST") {
      // Deliberately allowed while a job is armed and waiting. Topping a wallet
      // up is the one thing you need to be able to do in that window — the
      // stage hasn't opened, the wallet is short, and blocking it means the
      // mint fails for want of gas money.
      //
      // It is safe because receiving does not consume a nonce: the mint
      // transactions were signed at arm time against nonces that money
      // arriving cannot move. The payer is a different matter — sending does
      // consume one — so the only case still refused is paying out of a wallet
      // this mint is about to fire from.
      const body = await readBody(req);
      const cfg = loadConfig(CONFIG_PATH);
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      if (entries.length === 0) throw new Error("no wallets on the server to fund");

      // The payer is either one of the stored wallets, or a one-off key that
      // is used for this call and never written anywhere.
      let fromKey: `0x${string}`;
      if (typeof body.fromKey === "string" && body.fromKey.trim()) {
        fromKey = normalizePrivateKey(body.fromKey);
      } else if (typeof body.fromAddress === "string") {
        const want = body.fromAddress.toLowerCase();
        const hit = entries.find((e) => privateKeyToAccount(e.key).address.toLowerCase() === want);
        if (!hit) throw new Error("that source wallet isn't on the server");
        fromKey = hit.key;
      } else {
        throw new Error("supply either fromKey (a one-off payer) or fromAddress (a stored wallet)");
      }

      // Either a flat amount each, or a level to bring everyone up to. The
      // second is what funding a mint actually wants: the wallets carry
      // different leftovers from the last drop, so a flat send overfunds the
      // ones that were nearly ready and underfunds the empty ones.
      const num = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
      const topUpTo = num(body.topUpToEth);
      const amount = num(body.amountEth);
      let amountWei = 0n;
      let topUpToWei: bigint | undefined;
      if (topUpTo) {
        if (!/^\d+(\.\d+)?$/.test(topUpTo)) throw new Error("topUpToEth must be a plain number");
        topUpToWei = parseEther(topUpTo);
        if (topUpToWei <= 0n) throw new Error("topUpToEth must be greater than zero");
      } else {
        if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error("amountEth must be a plain number");
        amountWei = parseEther(amount);
        if (amountWei <= 0n) throw new Error("amountEth must be greater than zero");
      }

      const payer = privateKeyToAccount(fromKey).address.toLowerCase();
      const firing = walletsOfActiveJob();
      if (firing?.has(payer)) {
        json(res, 409, {
          error:
            "that payer is one of the wallets this mint is firing from — " +
            "sending from it now would spend the nonce its mint is signed against. " +
            "Fund from another wallet, or abort the job first.",
        });
        return;
      }
      // A caller may name the wallets to fund — the queue does, so funding a
      // job pays exactly the wallets that job fires from and no others.
      const stored = entries.map((e) => privateKeyToAccount(e.key).address);
      // Never send a wallet its own money.
      const targets = chooseWallets(body, "targets", stored, (a) => a).filter(
        (a) => a.toLowerCase() !== payer,
      );
      if (targets.length === 0) throw new Error("no targets — the only wallet stored is the payer");

      // Kept as well as logged, so the panel can show what happened instead of
      // asking someone to go and read the server's console.
      const lines: string[] = [];
      const result = await disperse(
        {
          chainId: cfg.chainId,
          extraRpcs: readRpcs(cfg),
          gas: { maxFeeGwei: cfg.gas.maxFeeGwei, tipGwei: cfg.gas.tipGwei },
          fromKey,
          targets,
          amountWei,
          topUpToWei,
          skipIfAtLeastWei:
            typeof body.skipIfAtLeastEth === "string" && body.skipIfAtLeastEth
              ? parseEther(body.skipIfAtLeastEth)
              : undefined,
          dryRun: body.dryRun !== false,
        },
        (line) => {
          lines.push(line);
          log(`disperse: ${line}`);
        },
      );
      json(res, 200, { ...result, logs: lines });
      return;
    }

    if (url.pathname === "/api/collect" && req.method === "POST") {
      if (activeJobId) {
        json(res, 409, { error: "a mint job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("to must be a 0x address");

      const cfg = loadConfig(CONFIG_PATH);
      const stored = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      if (stored.length === 0) throw new Error("no wallets on the server to sweep");
      // Which wallets to empty. All of them by default; a named subset when
      // the panel says so, so ETH can be gathered from part of the set without
      // draining the rest.
      const entries = chooseWallets(body, "from", stored, (e) =>
        privateKeyToAccount(e.key).address,
      ).filter((e) => privateKeyToAccount(e.key).address.toLowerCase() !== to.toLowerCase());
      if (entries.length === 0) {
        throw new Error("nothing to sweep — the only wallet chosen is the destination");
      }

      const result = await collect(
        {
          chainId: cfg.chainId,
          extraRpcs: readRpcs(cfg),
          gas: { maxFeeGwei: cfg.gas.maxFeeGwei, tipGwei: cfg.gas.tipGwei },
          keys: entries.map((e) => e.key),
          to: to as `0x${string}`,
          dryRun: body.dryRun !== false,
        },
        (line) => log(`collect: ${line}`),
      );
      json(res, 200, result);
      return;
    }

    // Queue a drop. This is the normal path — add ten of them hours ahead.
    if (url.pathname === "/api/queue" && req.method === "POST") {
      const body = await readBody(req);
      const request = buildRequest(body);
      const wallets = parseWalletFilter(body);
      if (wallets) {
        // Catch a stale selection now, while someone is watching, rather than
        // at fire time hours later when nobody is.
        const cfg = loadConfig(CONFIG_PATH);
        const have = new Set(
          loadKeyEntries(CONFIG_PATH, cfg.keysFile).map((e) =>
            privateKeyToAccount(e.key).address.toLowerCase(),
          ),
        );
        const missing = wallets.filter((a) => !have.has(a));
        if (missing.length === wallets.length) {
          throw new Error("none of the chosen wallets are on this server");
        }
        if (missing.length > 0) {
          log(`queue: ${missing.length} chosen wallet(s) are not on this server — ignoring them`);
        }
      }
      // Ask the contract what this drop is before queueing it. Two round
      // trips, once, and they buy the whole queue: the price, the supply, and
      // above all when the stage opens — without which every job looks due
      // immediately and arms hours early, holding the box against funding and
      // sweeping the entire time.
      const drop = await peekDrop(request.collection as `0x${string}`, request.extraRpcs ?? []);
      const job: Job = {
        id: randomUUID().slice(0, 8),
        label:
          typeof body.label === "string" && body.label
            ? body.label
            : (drop?.name ?? request.collection.slice(0, 10)),
        addedAt: Date.now(),
        status: "queued",
        request,
        wallets,
        startTime:
          typeof body.startTime === "number"
            ? body.startTime
            : // Only the public stage's window is the one this tells us about;
              // an allow-list job keeps arming as soon as it is due.
              request.stage === "public" && drop && drop.startTime > 0
              ? drop.startTime
              : undefined,
        drop,
        logs: [],
      };
      jobs.push(job);
      persistJobs();
      log(
        `queued job ${job.id} (${job.label}) for ${request.collection}` +
          (drop ? ` — ${formatEther(BigInt(drop.priceWei))} ETH, ${drop.totalSupply}/${drop.maxSupply} minted` : ""),
      );
      json(res, 201, jobView(job));
      return;
    }

    if (url.pathname === "/api/queue" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const i = jobs.findIndex((j) => j.id === id);
      if (i === -1) {
        json(res, 404, { error: "no such job" });
        return;
      }
      if (jobs[i].id === activeJobId) {
        json(res, 409, { error: "job is running — abort it first" });
        return;
      }
      const [removed] = jobs.splice(i, 1);
      persistJobs();
      log(`removed job ${removed.id}`);
      json(res, 200, { removed: removed.id });
      return;
    }

    if (url.pathname === "/api/abort" && req.method === "POST") {
      const job = jobs.find((j) => j.id === activeJobId);
      if (!job) {
        json(res, 409, { error: "no run in progress" });
        return;
      }
      job.abort?.abort();
      job.status = "aborted";
      persistJobs();
      log(`abort requested for job ${job.id}`);
      json(res, 200, jobView(job));
      return;
    }

    // Back-compat single-shot: queue it and let the scheduler pick it up now.
    if (url.pathname === "/api/snipe" && req.method === "POST") {
      const body = await readBody(req);
      const request = buildRequest(body);
      const wallets = parseWalletFilter(body);
      if (wallets) {
        // Catch a stale selection now, while someone is watching, rather than
        // at fire time hours later when nobody is.
        const cfg = loadConfig(CONFIG_PATH);
        const have = new Set(
          loadKeyEntries(CONFIG_PATH, cfg.keysFile).map((e) =>
            privateKeyToAccount(e.key).address.toLowerCase(),
          ),
        );
        const missing = wallets.filter((a) => !have.has(a));
        if (missing.length === wallets.length) {
          throw new Error("none of the chosen wallets are on this server");
        }
        if (missing.length > 0) {
          log(`queue: ${missing.length} chosen wallet(s) are not on this server — ignoring them`);
        }
      }
      const job: Job = {
        id: randomUUID().slice(0, 8),
        label: typeof body.label === "string" && body.label ? body.label : request.collection.slice(0, 10),
        addedAt: Date.now(),
        status: "queued",
        request,
        wallets: parseWalletFilter(body),
        logs: [],
      };
      jobs.push(job);
      persistJobs();
      json(res, 202, { started: true, id: job.id, dryRun: request.dryRun });
      return;
    }

    /**
     * Everything the ARBITRAGE tab shows in one answer.
     *
     * A shadow-mode tab has no state of its own to poll separately: the tiles,
     * the per-collection roll-up and the log all come from the same table, and
     * three requests for one table is three chances for them to disagree.
     */

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`control server on http://${HOST}:${PORT}`);
  log(`config ${CONFIG_PATH} · origins ${ORIGINS.join(", ")} · arm lead ${ARM_LEAD_MS / 1000}s`);
  try {
    const cfg = loadConfig(CONFIG_PATH);
    // Which endpoint reads go through, said out loud at startup. A box quietly
    // on the chain's public node — metered, and the cause of every rate limit
    // in today's log — was invisible until something failed because of it.
    const hosts = uniq(readRpcs(cfg).map(rpcHost));
    const general = MINT_ENV_RPCS.length > 0 ? "wallets and sweeps go" : "reads and mints go";
    log(
      hosts.length > 0
        ? `${general} through ${hosts.join(", ")}`
        : `${general} through the chain's PUBLIC RPC, which meters — set SNIPE_RPCS in snipe.env to use your own`,
    );
    // Only worth a second line when the two are actually different: on one key
    // it would just be the same host twice and read like a misconfiguration.
    log(`reads up to ${readConcurrency()} chain call(s) at once (SNIPE_READ_CONCURRENCY)`);
    log(
      waveSize() > 0
        ? `fires the first ${waveSize()} wallet(s) at the sequencer alone, then the rest ` +
            `(SNIPE_WAVE_SIZE / SNIPE_WAVE_GAP_MS)`
        : `fires every wallet at every endpoint at once — wave dispatch off (SNIPE_WAVE_SIZE=0)`,
    );
    if (MINT_ENV_RPCS.length > 0) {
      log(`arms and mints through ${uniq(mintRpcs(cfg).map(rpcHost)).join(", ")} — kept to itself`);
    }
    if (SCAN_ENV_RPCS.length > 0) {
      log(`scans through ${uniq(scanRpcs(cfg).map(rpcHost)).join(", ")} — kept off the mint path`);
    }
    // And whether that endpoint can actually serve a scan. The read client is
    // a fallback chain, so an endpoint that refuses every getLogs still leaves
    // the scanner working — through the public node, silently, while the panel
    // goes on naming the paid one. Nothing short of asking it reveals that.
    void checkScanEndpoint(cfg);
    log(cfg.telegram ? "telegram notifications ON" : "telegram notifications off (no token/chat id)");
    // The same bot, now also listening: /add collects a drop that exists
    // nowhere but Twitter yet, and the site reads the list back.
    if (cfg.telegram) startTelegramBot(cfg.telegram, CONFIG_PATH, log);
  } catch {
    log("config not readable yet — queue requests will report the error");
  }
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    log("WARNING binding to a public interface — prefer 127.0.0.1 behind a Cloudflare Tunnel");
  }
  startAutoUpdate();
  void announceTunnel();
});
