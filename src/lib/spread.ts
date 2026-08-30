/**
 * Firing across the boundary instead of at it.
 *
 * A single perfectly-timed burst cannot win a contested drop on this chain,
 * and the chain says so plainly. PixelHood Monkes opened at 17:30:00 with 151
 * of 1111 left. Every one of those 151 was minted in a single block —
 * 49333506, the first block stamped 17:30:00 — against roughly 2,600 attempts.
 *
 * Our run fired at exactly 17:30:00.000 and had all hundred transactions away
 * by .078, which is as well-timed as a machine can manage. It got nothing. The
 * winning fleet had 70 transactions in the block *before* the boundary and 80
 * in the winning one; ours first appear two blocks later.
 *
 * The reason is that a block's timestamp is stamped when the sequencer seals
 * it, not when a transaction arrives. Block 49333506 is full of transactions
 * that arrived *before* 17:30:00 and became valid anyway. By the time a
 * perfectly-timed transaction arrives at 17:30:00.010, the block that will
 * carry the mint is already full of people who arrived earlier and guessed.
 *
 * Two further facts from the same blocks decide the shape of this schedule:
 *
 *   - The sequencer admits roughly 350 transactions per block, and gas is
 *     nowhere near the limit — it is a batching choice, not a gas ceiling.
 *   - It rotates between client connections rather than draining one. Nobody's
 *     burst stays contiguous: our fifteen in block 49333509 sat at positions
 *     31 through 265, the rival's eighty in 49333506 at 1 through 348.
 *
 * So a burst is the wrong unit. What works is a stream: transactions arriving
 * continuously for a while either side of the start, so that whichever block
 * turns out to be the first valid one, you already have transactions in it.
 * The ones that land early revert on `NotActive` and are the price of not
 * knowing where the boundary falls.
 *
 * Measured cost of a burned shot here: 25,046 gas, about 0.0000024 ETH.
 */

/** How a run puts its transactions on the clock. */
export type MintStyle = "single" | "spread";

export interface SpreadPlan {
  /** Transactions per wallet, one per shot. */
  shots: number;
  /** Milliseconds relative to the stage's start, one per shot, in order. */
  offsets: number[];
}

/**
 * Shots before the start, shots after it, and how far apart.
 *
 * The defaults cover 800ms either side at 100ms — a block here is 100-200ms
 * under load, so that is a transaction in every block from four before the
 * boundary to four after. Weighted evenly: the early ones buy a place in the
 * block that seals on the boundary, the late ones catch the drain if the
 * supply outlasts the first block.
 */
export const DEFAULT_BEFORE = 8;
export const DEFAULT_AFTER = 8;
export const DEFAULT_STEP_MS = 100;

export function spreadPlan(before: number, after: number, stepMs: number): SpreadPlan {
  const b = Math.max(0, Math.floor(before));
  const a = Math.max(0, Math.floor(after));
  const step = Math.max(0, Math.floor(stepMs));
  const offsets: number[] = [];
  for (let i = -b; i <= a; i++) offsets.push(i * step + 0);
  return { shots: offsets.length, offsets };
}

/** One shot at the start means the old behaviour, whatever the caller called it. */
export function planFor(
  style: MintStyle,
  before: number,
  after: number,
  stepMs: number,
): SpreadPlan {
  return style === "spread" ? spreadPlan(before, after, stepMs) : spreadPlan(0, 0, 0);
}

/**
 * Gas a wallet must hold for a spread run, on top of the mint itself.
 *
 * Not `shots × the full reservation`. The transactions run one at a time, and
 * a reverted one gives back everything but the gas it burned — so the wallet
 * needs the full `gasLimit × maxFee` reservation once, plus the small change
 * each earlier shot actually costs. Demanding the whole reservation per shot
 * would ask for seventeen times the funding a run needs and refuse wallets
 * that could mint perfectly well.
 *
 * The estimate per burned shot is deliberately generous: measured reverts on
 * this chain used 25k gas (`NotActive`) and 38k (`MintQuantityExceedsMaxSupply`).
 */
export const BURNED_SHOT_GAS = 50_000n;

export function gasNeededWei(shots: number, gasLimit: bigint, maxFeePerGas: bigint): bigint {
  const n = BigInt(Math.max(1, Math.floor(shots)));
  return gasLimit * maxFeePerGas + (n - 1n) * BURNED_SHOT_GAS * maxFeePerGas;
}

/**
 * When each shot goes, as absolute milliseconds.
 *
 * Shots already in the past are not dropped: a run armed late, or one whose
 * stage moved under it, should still send everything it signed rather than
 * silently skipping the transactions whose moment passed while it was
 * thinking. They simply go at once, in order.
 */
export function shotTimes(plan: SpreadPlan, startMs: number): number[] {
  return plan.offsets.map((o) => startMs + o);
}

/** "-800 … +800 ms, 17 shots every 100ms" — the schedule at a glance. */
export function spreadLabel(before: number, after: number, stepMs: number): string {
  const p = spreadPlan(before, after, stepMs);
  if (p.shots === 1) return "one shot at the start";
  const first = p.offsets[0];
  const last = p.offsets[p.offsets.length - 1];
  return `${first} … ${last > 0 ? `+${last}` : last} ms · ${p.shots} shots every ${Math.max(0, Math.floor(stepMs))}ms`;
}
