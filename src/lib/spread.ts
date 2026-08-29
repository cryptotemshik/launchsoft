/**
 * Firing across the boundary instead of at it.
 *
 * A single perfectly-timed burst loses a contested drop, and the chain says so
 * plainly. PixelHood Monkes opened at 17:30:00 with 151 of 1111 left; those
 * 151 went in the first block of the stage, and around 2,600 mint attempts
 * arrived for them. Two blocks *before* the open already carried 437 attempts
 * — rivals deliberately firing early, eating a `NotActive` revert, so that
 * they would have transactions in the sequencer's queue on both sides of the
 * boundary. A run that fires once, exactly at the start time, lands wherever
 * the queue happens to be by then: ours landed in the fourth block, by which
 * point there was nothing left to mint.
 *
 * So a spread run signs several transactions per wallet on consecutive nonces
 * and sends them a step apart around the start. The early ones revert and are
 * meant to; what they buy is that one of the later ones is already in the
 * queue when the stage turns valid.
 *
 * Measured cost of a burned shot on this chain: 25,046 gas, about 0.0000024
 * ETH. A hundred wallets throwing away two shots each costs 0.00047 ETH.
 */

/** How a run puts its transactions on the clock. */
export type MintStyle = "single" | "spread";

export interface SpreadPlan {
  /** Transactions per wallet, one per shot. */
  shots: number;
  /** Milliseconds relative to the stage's start, one per shot, in order. */
  offsets: number[];
}

export const DEFAULT_SHOTS = 5;
export const DEFAULT_STEP_MS = 150;

/**
 * Shots either side of the start, with one landing exactly on it.
 *
 * Centred rather than leading, because a shot before the start is only useful
 * as queue position — it can never mint — while a shot after it can. An even
 * count therefore leans late: two shots are the start and one step past it,
 * never one step early and the start.
 */
export function spreadPlan(shots: number, stepMs: number): SpreadPlan {
  const n = Math.max(1, Math.floor(shots));
  const step = Math.max(0, Math.floor(stepMs));
  const before = Math.floor((n - 1) / 2);
  return {
    shots: n,
    // `+ 0` normalises the negative zero that a zero step produces for the
    // shots before the start — harmless in arithmetic, confusing in a log.
    offsets: Array.from({ length: n }, (_, i) => (i - before) * step + 0),
  };
}

/** One shot means the old behaviour, whatever the caller called it. */
export function planFor(style: MintStyle, shots: number, stepMs: number): SpreadPlan {
  return style === "spread" ? spreadPlan(shots, stepMs) : spreadPlan(1, 0);
}

/**
 * Gas a wallet must hold for a spread run, on top of the mint itself.
 *
 * Not `shots × the full reservation`. The transactions run one at a time, and
 * a reverted one gives back everything but the gas it burned — so the wallet
 * needs the full `gasLimit × maxFee` reservation once, plus the small change
 * each earlier shot actually costs. Demanding the whole reservation per shot
 * would ask for five times the funding a run needs and refuse wallets that
 * could mint perfectly well.
 *
 * The estimate per burned shot is deliberately generous: measured reverts on
 * this chain used 25k gas (`NotActive`) and 38k (`MintQuantityExceedsMaxSupply`).
 */
export const BURNED_SHOT_GAS = 50_000n;

export function gasNeededWei(
  shots: number,
  gasLimit: bigint,
  maxFeePerGas: bigint,
): bigint {
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

/** "−300, −150, 0, +150, +300 ms" — the schedule, readable at a glance. */
export function spreadLabel(shots: number, stepMs: number): string {
  return `${spreadPlan(shots, stepMs)
    .offsets.map((o) => (o > 0 ? `+${o}` : String(o)))
    .join(", ")} ms`;
}
