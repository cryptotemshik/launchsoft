/**
 * Whether a drop is actually being minted, and by how many different people.
 *
 * The scanner's table says a stage is open. That is a schedule, not a market:
 * a collection can be "live" for six hours with nothing happening, and another
 * can take nine hundred mints in an hour from four wallets. These are the two
 * numbers that tell those apart — the rate, and the share of it that comes
 * from distinct wallets.
 *
 * Adapted from the scoring and analytics modules in `openseasuite`, with two
 * changes. Uniqueness there returns 1 for an empty window, which reads as
 * "perfectly clean" about a drop nobody has touched; here it returns null and
 * the caller has to say "no data" rather than "no problem". And the busiest
 * minute was found with `Math.max(...map.values())`, which spreads every
 * bucket onto the call stack — fine for a demo, a crash on a collection with
 * a long history.
 */

export interface MintEvent {
  collection: `0x${string}`;
  minter: string;
  /** NFTs in this transaction. */
  quantity: number;
  /** Unix seconds. */
  t: number;
}

/** Events inside the trailing window (now − windowSec, now]. */
export function inWindow<T extends { t: number }>(
  events: readonly T[],
  now: number,
  windowSec: number,
): T[] {
  const cutoff = now - windowSec;
  return events.filter((e) => e.t > cutoff && e.t <= now);
}

/** NFTs minted per minute across a window. */
export function mintsPerMinute(
  events: readonly MintEvent[],
  now: number,
  windowSec = 900,
): number {
  const qty = inWindow(events, now, windowSec).reduce((a, e) => a + e.quantity, 0);
  return (qty * 60) / windowSec;
}

/**
 * Distinct wallets ÷ mint transactions, or null when there is nothing to
 * judge from.
 *
 * Null rather than 1 is the whole point: one wallet minting two hundred times
 * scores near zero, two hundred wallets minting once score 1, and a drop with
 * three mints so far scores *neither* — it has not shown you anything yet.
 */
export function uniqueness(
  events: readonly MintEvent[],
  now: number,
  windowSec = 900,
  minSample = 5,
): number | null {
  const w = inWindow(events, now, windowSec);
  if (w.length < minSample) return null;
  const wallets = new Set(w.map((e) => e.minter.toLowerCase())).size;
  return wallets / w.length;
}

export interface MinterRow {
  minter: string;
  quantity: number;
  txs: number;
  /** Share of everything minted in the sample, 0..1. */
  share: number;
}

export interface Concentration {
  rows: MinterRow[];
  wallets: number;
  txs: number;
  quantity: number;
  /** The largest single wallet's share, 0..1. */
  top1: number;
  /** The five largest wallets' combined share, 0..1. */
  top5: number;
  /** The busiest single minute's share of the sample, 0..1. */
  burst: number;
}

export function concentration(events: readonly MintEvent[], top = 10): Concentration {
  const by = new Map<string, { quantity: number; txs: number }>();
  const perMinute = new Map<number, number>();
  let quantity = 0;
  let busiest = 0;

  for (const e of events) {
    const key = e.minter.toLowerCase();
    const row = by.get(key) ?? { quantity: 0, txs: 0 };
    row.quantity += e.quantity;
    row.txs += 1;
    by.set(key, row);
    quantity += e.quantity;

    // Counted in the same pass, and tracked as we go rather than spread over
    // Math.max at the end — a busy collection has tens of thousands of
    // buckets and that is an argument list, not a loop.
    const bucket = Math.floor(e.t / 60);
    const next = (perMinute.get(bucket) ?? 0) + e.quantity;
    perMinute.set(bucket, next);
    if (next > busiest) busiest = next;
  }

  const rows = [...by.entries()]
    .map(([minter, r]) => ({
      minter,
      quantity: r.quantity,
      txs: r.txs,
      share: quantity > 0 ? r.quantity / quantity : 0,
    }))
    .sort((a, b) => b.quantity - a.quantity);

  return {
    rows: rows.slice(0, top),
    wallets: by.size,
    txs: events.length,
    quantity,
    top1: rows[0]?.share ?? 0,
    top5: rows.slice(0, 5).reduce((a, r) => a + r.share, 0),
    burst: quantity > 0 ? busiest / quantity : 0,
  };
}

/**
 * How many buckets the retained hour is cut into, and how wide each is.
 *
 * Thirty two-minute buckets: fine enough that a wall of minting in one minute
 * still reads as a wall, coarse enough that the whole shape fits in a cell
 * and in a JSON payload repeated across fifty collections.
 */
export const SPARK_BUCKETS = 30;
export const SPARK_BUCKET_SEC = 120;

/** Per-bucket quantities, oldest first, ending at `now`. */
export function sparkline(
  events: readonly MintEvent[],
  now: number,
  buckets = SPARK_BUCKETS,
  bucketSec = SPARK_BUCKET_SEC,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  const start = now - buckets * bucketSec;
  for (const e of events) {
    if (e.t <= start || e.t > now) continue;
    const i = Math.min(buckets - 1, Math.floor((e.t - start) / bucketSec));
    out[i] += e.quantity;
  }
  return out;
}

/**
 * One number to rank a live feed by.
 *
 * Rate is the substance; the rest are discounts on how much to believe it. A
 * drop minting fast from one wallet is discounted toward half, a drop that has
 * gone quiet decays away over about ten minutes, and a drop whose uniqueness
 * nobody could measure yet is treated as neither clean nor washed.
 *
 *   score = rate × (0.5 + 0.5 × uniqueness) × e^(−silence / 600)
 */
export function trendScore(p: {
  perMin: number;
  uniqueness: number | null;
  lastT: number;
}, now: number): number {
  if (p.perMin <= 0) return 0;
  const believable = 0.5 + 0.5 * (p.uniqueness ?? 0.5);
  const silence = p.lastT > 0 ? Math.max(0, now - p.lastT) : 0;
  return p.perMin * believable * Math.exp(-silence / 600);
}

export interface MintPulse {
  /** NFTs a minute over the trailing 15 minutes. */
  perMin: number;
  /** Distinct wallets ÷ txs over the same window, null below the sample floor. */
  uniqueness: number | null;
  /** Mint transactions in the retained sample. */
  txs: number;
  /** NFTs minted in the retained sample. */
  quantity: number;
  /** Distinct wallets in the retained sample. */
  wallets: number;
  top1: number;
  top5: number;
  burst: number;
  /** Unix seconds of the most recent mint seen. */
  lastT: number;
  /** Quantities per two-minute bucket over the retained hour, oldest first. */
  spark: number[];
  /** Ranking number for a live feed; see {@link trendScore}. */
  trend: number;
}

/**
 * The rate is about now; the wallet spread is about the whole sample.
 *
 * These want different windows and it took live data to see it. Measured over
 * the same fifteen minutes as the rate, uniqueness came back "no data" for the
 * three busiest collections on the chain — each had taken ten thousand mints
 * earlier in the hour and gone quiet, so the one number that would have told
 * you whether those ten thousand came from real wallets was the one number
 * being thrown away. The rate has to be recent to mean anything. The evidence
 * does not.
 */
export function pulseOf(events: readonly MintEvent[], now: number): MintPulse {
  const c = concentration(events, 5);
  const perMin = mintsPerMinute(events, now);
  const uniq = uniqueness(events, now, Infinity);
  const lastT = events.reduce((m, e) => (e.t > m ? e.t : m), 0);
  return {
    perMin,
    uniqueness: uniq,
    txs: c.txs,
    quantity: c.quantity,
    wallets: c.wallets,
    top1: c.top1,
    top5: c.top5,
    burst: c.burst,
    lastT,
    spark: sparkline(events, now),
    trend: trendScore({ perMin, uniqueness: uniq, lastT }, now),
  };
}

/** One pulse per collection, from a flat batch of mints. */
export function pulseByCollection(
  events: readonly MintEvent[],
  now: number,
): Record<string, MintPulse> {
  const by = new Map<string, MintEvent[]>();
  for (const e of events) {
    const key = e.collection.toLowerCase();
    const list = by.get(key);
    if (list) list.push(e);
    else by.set(key, [e]);
  }
  const out: Record<string, MintPulse> = {};
  for (const [key, list] of by) out[key] = pulseOf(list, now);
  return out;
}

export interface CurvePoint {
  t: number;
  /** NFTs minted up to and including t. */
  cum: number;
}

/**
 * The cumulative shape of a mint, from its buckets.
 *
 * Drawn from the sparkline rather than from raw events because the buckets are
 * what actually crosses the wire — fifty collections' worth of individual
 * mints would be megabytes, and the shape is the whole point: a wall in one
 * bucket and a flat line after it is a different drop from a steady climb,
 * even when both end at the same supply.
 */
export function cumulativeFromSpark(spark: readonly number[]): number[] {
  let cum = 0;
  return spark.map((q) => (cum += q));
}

/** The cumulative mint curve, time-sorted and thinned to at most `maxPoints`. */
export function mintCurve(events: readonly MintEvent[], maxPoints = 120): CurvePoint[] {
  const sorted = [...events].filter((e) => e.t > 0).sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];
  const points: CurvePoint[] = [];
  let cum = 0;
  for (const e of sorted) {
    cum += e.quantity;
    const last = points[points.length - 1];
    if (last && last.t === e.t) last.cum = cum;
    else points.push({ t: e.t, cum });
  }
  if (points.length <= maxPoints) return points;
  // Keep the ends and sample evenly between them, so the curve's shape and
  // its final height both survive the thinning.
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => points[Math.round(i * step)]);
}
