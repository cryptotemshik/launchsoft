/**
 * Wait until a target instant, then return. Coarse-grained via setTimeout
 * (cheap, but only accurate to ~tens of ms in a browser tab), then a short
 * bounded busy-wait for the final stretch to sharpen that up — capped so the
 * main thread is never stalled for longer than a dropped frame or two.
 */
export type WaitOutcome = "fired" | "aborted";

const SPIN_WINDOW_MS = 40;
/** How long before the target `onApproach` fires (once). */
const APPROACH_MS = 3_000;

export async function waitUntil(
  targetMs: number,
  opts: {
    onTick?: (msLeft: number) => void;
    signal?: AbortSignal;
    /** Called once, ~3s out — the moment to re-open idle connections. */
    onApproach?: () => void;
  } = {},
): Promise<WaitOutcome> {
  const { onTick, signal, onApproach } = opts;
  let approached = false;

  while (true) {
    if (signal?.aborted) return "aborted";
    const msLeft = targetMs - Date.now();
    if (msLeft <= SPIN_WINDOW_MS) break;
    if (!approached && msLeft <= APPROACH_MS) {
      approached = true;
      onApproach?.();
    }
    onTick?.(msLeft);
    // Sleep in short hops so onTick keeps a live countdown, and so an abort
    // mid-wait doesn't have to wait out a long single timeout.
    await sleep(Math.min(500, msLeft - SPIN_WINDOW_MS), signal);
  }

  if (signal?.aborted) return "aborted";
  onTick?.(Math.max(0, targetMs - Date.now()));

  // Sub-frame precision for the last stretch. Network dispatch time (several
  // ms at best) dwarfs this anyway — the goal is only to beat setTimeout's
  // coarse resolution, not to hit the microsecond.
  while (Date.now() < targetMs) {
    if (signal?.aborted) return "aborted";
  }
  return "fired";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
