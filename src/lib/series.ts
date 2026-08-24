/**
 * Chart series math for the Dashboard profit chart. Pure and unit-tested;
 * rendering lives in components/ProfitChart.tsx.
 */
import type { TimedAmount } from "./profit";

export interface SeriesPoint {
  t: number;
  /** Cumulative wei at time t. */
  cum: bigint;
}

/**
 * Merge timed deltas into a cumulative, time-sorted series. Events with an
 * unknown timestamp (t = 0) are folded into the earliest known point instead
 * of drawing a bogus 1970 tail. A final "now" point extends the line to the
 * present.
 */
export function buildCumulativeSeries(
  events: TimedAmount[],
  now: number,
): SeriesPoint[] {
  const known = events.filter((e) => e.t > 0).sort((a, b) => a.t - b.t);
  const unknownSum = events
    .filter((e) => e.t <= 0)
    .reduce((acc, e) => acc + e.wei, 0n);
  const points: SeriesPoint[] = [];
  let cum = unknownSum;
  if (known.length === 0) {
    return unknownSum !== 0n
      ? [
          { t: now - 1, cum: unknownSum },
          { t: now, cum: unknownSum },
        ]
      : [];
  }
  // Anchor the line at zero-ish just before the first event so it rises from a baseline.
  points.push({ t: known[0].t - 1, cum: unknownSum });
  for (const e of known) {
    cum += e.wei;
    const last = points[points.length - 1];
    if (last && last.t === e.t) {
      last.cum = cum;
    } else {
      points.push({ t: e.t, cum });
    }
  }
  if (points[points.length - 1].t < now) points.push({ t: now, cum });
  return points;
}

/**
 * Deduplicate royalty event lists that share a royalty receiver: several
 * collections paying to one wallet would otherwise count the same payouts
 * N times in a combined chart/total.
 */
export function dedupeByReceiver(
  lists: { receiver: string; events: TimedAmount[] }[],
): TimedAmount[] {
  const seen = new Set<string>();
  const out: TimedAmount[] = [];
  for (const { receiver, events } of lists) {
    const key = receiver.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(...events);
  }
  return out;
}

/** "Nice" y-axis tick values (in ETH floats) for a wei range. */
export function niceTicks(minWei: bigint, maxWei: bigint, count = 4): number[] {
  const min = Number(minWei) / 1e18;
  const max = Number(maxWei) / 1e18;
  if (!(max > min)) return [min];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const err = span / count / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / s) * s; v <= max + s / 1e6; v += s) {
    ticks.push(Number(v.toPrecision(10)));
  }
  return ticks;
}
