/**
 * One watchlist, two tabs looking at it.
 *
 * The calendar and the watchlist are two views of the same server-side list:
 * both read `/api/upcoming`, and both can colour a row, write a note on it, or
 * strike it off. On the server that is one record, so there is nothing to keep
 * in step there. On this side there are two stores, and without a word between
 * them a colour picked in the calendar sat there until the watchlist happened
 * to read again — the same drop, two colours, which is worse than no colours.
 *
 * So a write says so, and whoever else is holding that list drops what they
 * have. A store with a fetcher installed reads again at once; one belonging to
 * a tab nobody has opened simply counts as stale, and reads when it is opened.
 *
 * Deliberately a signal and not shared state. Making both tabs read one store
 * would mean one shape that suits neither: the calendar holds events merged
 * from two sources, the watchlist holds raw entries alongside the chain's view
 * of them. They agree on the facts, not on the shape.
 */

type Listener = (source: unknown) => void;

const listeners = new Set<Listener>();

/**
 * Call after any write that changes the watchlist.
 *
 * `source` is whatever identifies the writer — its own store. The writer has
 * already applied the change optimistically, so telling it to read again would
 * only cost a request to confirm what it just did.
 */
export function notifyWatchlistChanged(source?: unknown): void {
  for (const fn of listeners) fn(source);
}

export function onWatchlistChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** For tests, so one file's listeners cannot leak into another's. */
export function resetWatchlistSignal(): void {
  listeners.clear();
}
