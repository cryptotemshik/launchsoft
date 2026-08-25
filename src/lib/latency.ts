/**
 * Summarising latency samples.
 *
 * The mean is the wrong number to look at here. What decides a first-come-
 * first-served race is not the average round-trip but the bad ones: an endpoint
 * that answers in 20ms nine times out of ten and 400ms on the tenth loses the
 * drop on the tenth. So the summary leads with the median and p95, and keeps
 * the minimum as the "how fast can this path possibly be" floor.
 */
export interface LatencySummary {
  /** Successful samples. */
  n: number;
  /** Attempts that errored or timed out. */
  failed: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

/**
 * @param samples milliseconds per attempt; null for an attempt that failed.
 */
export function summarise(samples: readonly (number | null)[]): LatencySummary {
  const ok = samples.filter((s): s is number => s !== null).sort((a, b) => a - b);
  const failed = samples.length - ok.length;
  if (ok.length === 0) {
    return { n: 0, failed, min: NaN, median: NaN, p95: NaN, max: NaN };
  }
  return {
    n: ok.length,
    failed,
    min: ok[0],
    median: quantile(ok, 0.5),
    p95: quantile(ok, 0.95),
    max: ok[ok.length - 1],
  };
}

/**
 * Nearest-rank quantile on an already-sorted list. No interpolation: every
 * number reported is a round-trip that actually happened, which is what you
 * want when the question is "how slow does this get".
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Right-aligned milliseconds, or a dash when there is nothing to show. */
export function ms(v: number): string {
  return Number.isFinite(v) ? `${Math.round(v)}ms` : "—";
}
