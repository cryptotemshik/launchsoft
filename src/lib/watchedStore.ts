/**
 * What is already on the watchlist, known everywhere the "watch" button is.
 *
 * The scanner and the live feed never loaded the watchlist, so their buttons
 * had no way to know a collection was already on it — you could press watch on
 * the same row on every refresh and get an entry each time. The server refuses
 * duplicates now, which is the guarantee; this is so the button can say so
 * before it is pressed rather than after.
 *
 * One fetch per session, shared: a scan renders a hundred of these buttons and
 * a hundred requests for the same list would be worse than the problem.
 */

let watched = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
/** The in-flight load, so a hundred buttons mounting cause one request. */
let loading: Promise<void> | null = null;

function announce(): void {
  version += 1;
  for (const l of listeners) l();
}

/** A contract or a handle, compared the way the server compares them. */
function key(value: string | null | undefined): string | null {
  const t = (value ?? "").trim().toLowerCase();
  if (!t) return null;
  return t.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "").replace(/^@/, "");
}

export function isWatched(contract?: string | null, twitter?: string | null): boolean {
  const c = key(contract);
  if (c && watched.has(c)) return true;
  const t = key(twitter);
  return t !== null && watched.has(t);
}

/** Replace what is known, from a list the server just returned. */
export function seedWatched(list: readonly { contract?: string; twitter?: string }[]): void {
  const next = new Set<string>();
  for (const m of list) {
    const c = key(m.contract);
    if (c) next.add(c);
    const t = key(m.twitter);
    if (t) next.add(t);
  }
  watched = next;
  announce();
}

/** Note one as watched without waiting for a reload. */
export function markWatched(contract?: string | null, twitter?: string | null): void {
  const c = key(contract);
  const t = key(twitter);
  if (!c && !t) return;
  watched = new Set(watched);
  if (c) watched.add(c);
  if (t) watched.add(t);
  announce();
}

/**
 * Load the list once, if nothing has yet.
 *
 * Failure is deliberately silent: not knowing means the button stays pressable
 * and the server still refuses the duplicate. A red button on every scanner row
 * because one request failed would be worse than the thing it warns about.
 */
export function ensureWatchedLoaded(
  call: (path: string) => Promise<unknown>,
): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = (await call("/api/upcoming")) as { upcoming?: { contract?: string; twitter?: string }[] };
      seedWatched(r.upcoming ?? []);
    } catch {
      // Try again next time something asks.
      loading = null;
    }
  })();
  return loading;
}

export function subscribeWatched(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function watchedVersion(): number {
  return version;
}
