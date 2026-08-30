/**
 * The worker that keeps the drop index current.
 *
 * Two jobs, and they are deliberately different.
 *
 * **Catching up** happens once, when the index is empty or has been off for a
 * while. Thirty days is 25 million blocks, far too much for one request and
 * enough to matter as a burst of load, so it is walked backwards in pieces
 * with a pause between them. The tab works throughout — it simply sees less
 * history until the walk finishes.
 *
 * **Keeping up** happens every minute and reads only the blocks since the last
 * pass, which at this chain's rate is around 600. That is one small log query
 * and, on a quiet minute, no enrichment at all.
 *
 * The split matters because the costs are nothing alike: catching up thirty
 * days is roughly 14,000 compute units once, while keeping up is about 500,000
 * a month — against the 22 million a month the scanner's auto-refresh already
 * spends. Neither is worth worrying about; conflating them would have made the
 * cheap one look like the expensive one.
 */
import type { PublicClient } from "viem";
import { enrichDrops, scanPublicDrops } from "./dropScanner";
import type { DropIndex } from "./dropIndex";

export interface IndexerOptions {
  /** How far back the index reaches, in days. */
  keepDays: number;
  /** Blocks produced per hour, measured rather than assumed. */
  blocksPerHour: number;
  /** Largest range one catch-up step reads. */
  stepBlocks: bigint;
  onNote?: (s: string) => void;
}

/** A range that was read, and what it turned up. */
export interface PassRange {
  fromBlock: bigint;
  toBlock: bigint;
  /** Collections stored from this range. */
  found: number;
}

export interface PassResult {
  /** The head this pass measured itself against. */
  head: bigint;
  /** Blocks read to catch the head. Null when there was nothing new. */
  keptUp: PassRange | null;
  /**
   * Blocks read walking backwards. Kept apart from `keptUp` because the two
   * are nothing alike in size — a keep-up step is a few hundred blocks, a
   * catch-up step is tens of thousands — and reporting one number for both
   * makes the log claim a hundred collections in six hundred blocks.
   */
  reachedBack: PassRange | null;
  /** Oldest block the index covers, once the walk has begun. */
  oldestBlock: bigint | null;
  /** How far back the index reaches, in days. */
  coverageDays: number;
  stored: number;
  pruned: number;
  /** True while history is still being walked backwards. */
  catchingUp: boolean;
}

const LAST_BLOCK = "lastBlock";
/** How far back the catch-up has reached. Absent once it is done. */
const OLDEST_BLOCK = "oldestBlock";

/**
 * Read one range and store what it holds.
 *
 * Enrichment is what costs real time — seven contract reads per collection,
 * batched a hundred at a time — so it only runs on what the range actually
 * turned up. A minute with no new drops does no enrichment at all.
 */
async function ingest(
  client: PublicClient,
  index: DropIndex,
  fromBlock: bigint,
  toBlock: bigint,
  onNote?: (s: string) => void,
): Promise<number> {
  const { drops } = await scanPublicDrops(client, { fromBlock, toBlock, onNote });
  if (drops.length === 0) return 0;
  const enriched = await enrichDrops(client, drops);
  index.put(enriched, Math.floor(Date.now() / 1000));
  return enriched.length;
}

/**
 * One pass. Call it on a timer; it decides for itself whether this is a
 * catch-up step or a keep-up step.
 *
 * Forward progress is committed before backward progress, because the two
 * failure modes are not equal: falling behind the head means missing a drop
 * that is about to open, while a gap in old history only shortens the view.
 */
export async function indexOnce(
  client: PublicClient,
  index: DropIndex,
  opts: IndexerOptions,
): Promise<PassResult> {
  const head = await client.getBlockNumber();
  const windowBlocks = BigInt(Math.round(opts.blocksPerHour * 24 * opts.keepDays));
  const floor = head > windowBlocks ? head - windowBlocks : 0n;

  const lastRaw = index.get(LAST_BLOCK);
  const last = lastRaw ? BigInt(lastRaw) : null;

  // ── Keep up: everything since the last pass ────────────────────────────
  let keptUp: PassRange | null = null;
  if (last !== null && last < head) {
    const from = last + 1n;
    keptUp = { fromBlock: from, toBlock: head, found: await ingest(client, index, from, head, opts.onNote) };
    index.set(LAST_BLOCK, head.toString());
  }
  let seeded = false;
  if (last === null) {
    // First ever pass: take the most recent step and start the walk back.
    const from = head > opts.stepBlocks ? head - opts.stepBlocks : floor;
    keptUp = { fromBlock: from, toBlock: head, found: await ingest(client, index, from, head, opts.onNote) };
    index.set(LAST_BLOCK, head.toString());
    index.set(OLDEST_BLOCK, from.toString());
    seeded = true;
  }

  // ── Catch up: one step further back, if there is any left ──────────────
  // Not on the pass that just seeded the index: that one has already read a
  // step, and doing two would make the first minute twice as heavy as every
  // minute after it for no reason.
  const oldestRaw = index.get(OLDEST_BLOCK);
  let catchingUp = Boolean(oldestRaw) && BigInt(oldestRaw ?? "0") > floor;
  let reachedBack: PassRange | null = null;
  if (oldestRaw && !seeded) {
    const oldest = BigInt(oldestRaw);
    if (oldest > floor) {
      const stepFrom = oldest - opts.stepBlocks > floor ? oldest - opts.stepBlocks : floor;
      reachedBack = {
        fromBlock: stepFrom,
        toBlock: oldest - 1n,
        found: await ingest(client, index, stepFrom, oldest - 1n, opts.onNote),
      };
      index.set(OLDEST_BLOCK, stepFrom.toString());
      catchingUp = stepFrom > floor;
      if (!catchingUp) opts.onNote?.("index reaches the full window now");
    }
  }

  const cutoff = Math.floor(Date.now() / 1000) - opts.keepDays * 86_400;
  const pruned = index.prune(cutoff);

  const nowOldest = index.get(OLDEST_BLOCK);
  return {
    head,
    keptUp,
    reachedBack,
    oldestBlock: nowOldest ? BigInt(nowOldest) : null,
    coverageDays: (coverageHours(index, head, opts.blocksPerHour) ?? 0) / 24,
    stored: index.count(),
    pruned,
    catchingUp,
  };
}

/**
 * How much of the asked-for window the index can actually answer.
 *
 * A caller asking for thirty days while the walk has reached six should be
 * told so rather than shown six days as though they were thirty — a scanner
 * that quietly under-reports is worse than one that says it is still filling.
 */
export function coverageHours(
  index: DropIndex,
  head: bigint,
  blocksPerHour: number,
): number | null {
  const oldest = index.get(OLDEST_BLOCK);
  if (!oldest) return null;
  const span = head > BigInt(oldest) ? Number(head - BigInt(oldest)) : 0;
  return span / blocksPerHour;
}
