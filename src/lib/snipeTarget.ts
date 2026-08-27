/**
 * Collections handed from one tab to another.
 *
 * The scanner, the live feed and the calendar all find drops worth acting on,
 * and the snipe tab is where acting happens — so a row's "snipe" button parks
 * the contract here for that tab to pick up.
 *
 * It used to be a single slot, and the tab switched the moment you pressed the
 * button. Both were wrong for the way the tabs are actually used: someone
 * going down a scan marks three or four things worth a closer look, and being
 * thrown out of the list after the first one means walking back to find their
 * place. So nothing navigates now, and the parked collections queue up instead
 * of overwriting each other.
 *
 * Reading and clearing are deliberately separate calls. A combined `take()`
 * looks tidier and is a trap: React's StrictMode runs a `useState` initializer
 * twice in development, so the first call would consume the value and the
 * second would find nothing. Peeking is idempotent; the clearing happens once,
 * from an effect, when the collection has actually been picked up.
 */

/** Far more than anyone marks in one pass, and a bound all the same. */
const LIMIT = 20;

let parked: string[] = [];
/** Bumped on every change, so a tab can re-render when one arrives. */
let version = 0;
const listeners = new Set<() => void>();

function announce(): void {
  version += 1;
  for (const l of listeners) l();
}

/**
 * Park a collection for the snipe tab. Newest first — the one just pressed is
 * the one most likely wanted next.
 */
export function setPendingTarget(contract: string): void {
  const key = contract.toLowerCase();
  parked = [contract, ...parked.filter((c) => c.toLowerCase() !== key)].slice(0, LIMIT);
  announce();
}

/** What was handed over most recently, if anything. Safe to call repeatedly. */
export function readPendingTarget(): string | null {
  return parked[0] ?? null;
}

/** Everything still parked, newest first. */
export function pendingTargets(): readonly string[] {
  return parked;
}

/** Forget one, so picking it up doesn't leave it on the list. */
export function clearPendingTarget(contract?: string): void {
  if (contract === undefined) parked = parked.slice(1);
  else {
    const key = contract.toLowerCase();
    parked = parked.filter((c) => c.toLowerCase() !== key);
  }
  announce();
}

/** Forget all of them. */
export function clearPendingTargets(): void {
  parked = [];
  announce();
}

/** For `useSyncExternalStore`, so a parked collection shows up as it lands. */
export function subscribePendingTargets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pendingVersion(): number {
  return version;
}
