/**
 * A collection handed from one tab to another.
 *
 * The scanner finds a drop and the snipe tab acts on it, and the two never
 * render at the same time — so the handoff is a single value parked here, not
 * shared state.
 *
 * Reading and clearing are deliberately separate calls. A combined `take()`
 * looks tidier and is a trap: React's StrictMode runs a `useState` initializer
 * twice in development, so the first call would consume the value and the
 * second would find nothing. Peeking is idempotent; the clearing happens once,
 * from an effect, when the collection has actually been picked up.
 */

let pending: string | null = null;

export function setPendingTarget(contract: string): void {
  pending = contract;
}

/** What was handed over, if anything. Safe to call any number of times. */
export function readPendingTarget(): string | null {
  return pending;
}

/** Forget it, so returning to the tab later doesn't re-load it. */
export function clearPendingTarget(): void {
  pending = null;
}
