/**
 * Watching the chain for arbitrage that was there to be taken.
 *
 * This is the shadow phase: it executes nothing and holds no keys. It reads
 * completed Seaport fills, pairs a listing bought in ETH with the best
 * collection offer accepted shortly after, and records what the spread was.
 * A day of that answers the only question worth spending a contract on —
 * whether the money is there, and which collections it is in.
 *
 * The pairing needs a listing and an offer to be in the same batch, so batches
 * overlap: each pass re-reads the last window before where it stopped. That
 * costs one window of duplicate reads and buys correctness at the seams; the
 * store's primary key absorbs the repeats.
 */
import { parseAbiItem, type PublicClient } from "viem";
import { findOpportunities, type Fill, type SpreadOptions } from "../lib/arbMath";
import type { ArbStore, StoredOpportunity } from "./arbStore";

/** Seaport 1.6, the only version deployed on this chain. */
export const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395" as const;

export const ORDER_FULFILLED = parseAbiItem(
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
);

/** What a paid endpoint answers without complaint; see the scan chunking. */
const CHUNK = 10_000n;
/** How much chain one pass covers. Bigger batches pair better at the seams. */
const BATCH = 60_000n;
/**
 * How far back a first run reaches.
 *
 * A cold start with no backfill shows an empty page until enough chain has
 * gone by, which is the wrong first impression for a tool whose whole job is
 * to say whether the money is there. One pass covers 60,000 blocks and the
 * chain produces 35,600 an hour, so the catch-up is a handful of passes
 * however far back this reaches.
 */
export const DEFAULT_BACKFILL_BLOCKS = 213_600n; // six hours of this chain

export interface WatchOptions extends SpreadOptions {
  /** How far back a first run reaches. Ignored once there is a saved position. */
  backfillBlocks?: bigint;
  onNote?: (s: string) => void;
}

export interface WatchResult {
  fromBlock: number;
  toBlock: number;
  fills: number;
  found: number;
  stored: number;
  tookMs: number;
}

/**
 * Read one batch and record what it found.
 *
 * Returns null when there is nothing new to read, so a caller polling every
 * few seconds does not log a line each time.
 */
export async function watchOnce(
  client: PublicClient,
  store: ArbStore,
  opts: WatchOptions,
): Promise<WatchResult | null> {
  const started = Date.now();
  const tip = await client.getBlockNumber();

  const saved = store.getState("lastBlock");
  const back = opts.backfillBlocks ?? DEFAULT_BACKFILL_BLOCKS;
  const last = saved ? BigInt(saved) : tip > back ? tip - back : 0n;
  if (last >= tip) return null;

  const to = last + BATCH > tip ? tip : last + BATCH;
  // Overlap backwards by a window so a buy near the previous seam can still
  // find the offer that followed it.
  const overlap = BigInt(opts.windowBlocks);
  const from = last > overlap ? last - overlap : 0n;

  const fills: Fill[] = [];
  for (let s = from; s <= to; s += CHUNK) {
    const e = s + CHUNK - 1n > to ? to : s + CHUNK - 1n;
    const logs = await client.getLogs({ address: SEAPORT, event: ORDER_FULFILLED, fromBlock: s, toBlock: e });
    for (const l of logs) {
      fills.push({
        block: Number(l.blockNumber),
        offerer: l.args.offerer ?? "",
        recipient: l.args.recipient ?? "",
        offer: (l.args.offer ?? []).map((o) => ({
          itemType: o.itemType, token: o.token, identifier: String(o.identifier), amount: String(o.amount),
        })),
        consideration: (l.args.consideration ?? []).map((c) => ({
          itemType: c.itemType, token: c.token, identifier: String(c.identifier),
          amount: String(c.amount), recipient: c.recipient,
        })),
      });
    }
  }

  const opportunities = findOpportunities(fills, opts);

  // Block timestamps are not in the log, and one header per opportunity would
  // undo the saving. Two headers pin the range and the rest is interpolated —
  // accurate to a second or two on a chain producing 35,600 blocks an hour,
  // which is finer than anything here groups by.
  let stored = 0;
  if (opportunities.length > 0) {
    const [head, tail] = await Promise.all([
      client.getBlock({ blockNumber: from }),
      client.getBlock({ blockNumber: to }),
    ]);
    const span = Number(to - from) || 1;
    const t0 = Number(head.timestamp);
    const perBlock = (Number(tail.timestamp) - t0) / span;
    const rows: StoredOpportunity[] = opportunities.map((o) => ({
      ...o,
      at: Math.round(t0 + (o.buyBlock - Number(from)) * perBlock),
    }));
    stored = store.record(rows);
  }

  store.setState("lastBlock", to.toString());
  return {
    fromBlock: Number(from),
    toBlock: Number(to),
    fills: fills.length,
    found: opportunities.length,
    stored,
    tookMs: Date.now() - started,
  };
}
