/**
 * What a tab knows, kept outside the tab.
 *
 * The app renders one tab at a time, so leaving one unmounts it and everything
 * it had fetched goes with it. Coming back means fetching it all again: a few
 * seconds of empty screen to arrive at what was on it a moment ago. Worse, an
 * auto-refresh interval is unmounted along with its component, so "every 30
 * seconds" quietly meant "every 30 seconds, while you watch it".
 *
 * The Scanner was fixed first, by hand. This is the same fix as something the
 * other tabs can be given rather than each growing its own copy — the calendar,
 * the live feed and the watchlist all have the same shape of problem, and the
 * next tab will too.
 *
 * What belongs in here is what a request paid for. Filters, sort order and
 * search boxes deliberately stay in the component: they cost nothing to
 * re-apply, and a filter that outlives the visit that set it is a page quietly
 * lying about what it is showing.
 */

export interface TabSnapshot<T> {
  /** Everything the tab fetched. Present from the start, so a first render
   *  draws an empty page rather than branching on null. */
  data: T;
  /** When a load last finished, in ms. 0 when there has never been one. */
  at: number;
  busy: boolean;
  error: string | null;
  /** Auto-refresh interval in seconds; 0 is off. */
  every: number;
  /** Seconds until the next automatic refresh. */
  nextIn: number;
}

export interface TabStore<T> {
  getState(): TabSnapshot<T>;
  subscribe(fn: () => void): () => void;
  /** Merge into the held data. What a fetcher calls as answers come back. */
  set(patch: Partial<T>): void;
  /**
   * Install the thing that talks to the server.
   *
   * The store cannot do it itself: the URL and the token belong to a hook, and
   * the loop that uses them does not. The tab hands one down whenever those
   * change, and the loop keeps using the last one it was given.
   */
  setFetcher(f: (() => Promise<void>) | null): void;
  /** Run the fetcher, tracking busy and error. Concurrent calls collapse. */
  run(): Promise<void>;
  /**
   * Report a failure that did not come from a load.
   *
   * A tab can fail while doing something other than fetching — recolouring a
   * row, removing one — and that has to reach the same line of red text as a
   * failed refresh rather than a second one the component owns alone.
   */
  setError(message: string | null): void;
  /** True when the held data is old enough to be worth replacing. */
  isStale(nowMs?: number): boolean;
  /**
   * Declare what is held out of date, without reading anything.
   *
   * For when something else changed the data underneath — another tab writing
   * to the same list. The rows stay on screen; they are simply no longer
   * treated as fresh, so the next open reads again.
   */
  invalidate(): void;
  /** Start, restart or stop the refresh loop. Survives the tab unmounting. */
  setEvery(secs: number): void;
  /** For tests: forget everything, including the loop. */
  reset(): void;
}

export interface TabStoreOptions {
  /**
   * How old held data may be before opening the tab refreshes it.
   *
   * Long enough that flicking between tabs costs nothing, short enough that a
   * countdown is not a minute wrong by the time it is read. The old data is
   * shown either way — the refresh happens underneath it.
   */
  staleMs?: number;
  /** Turn a thrown message into something worth showing. */
  describeError?: (message: string) => string;
}

export const DEFAULT_STALE_MS = 45_000;

export function createTabStore<T extends object>(
  initial: T,
  options: TabStoreOptions = {},
): TabStore<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const describe = options.describeError ?? ((m: string) => m);
  const fresh = (): TabSnapshot<T> => ({
    data: { ...initial },
    at: 0,
    busy: false,
    error: null,
    every: 0,
    nextIn: 0,
  });

  let state = fresh();
  const listeners = new Set<() => void>();
  let fetcher: (() => Promise<void>) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;

  // One object, replaced whole on every change: useSyncExternalStore compares
  // snapshots by identity and re-reads forever if a fresh one comes back each
  // time it asks.
  function put(patch: Partial<TabSnapshot<T>>): void {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  }

  const store: TabStore<T> = {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(patch) {
      put({ data: { ...state.data, ...patch } });
    },
    setFetcher(f) {
      fetcher = f;
    },
    run() {
      // Concurrent asks collapse into the one already running: the countdown
      // and the tab opening can fire at the same moment, and the same read
      // would otherwise be paid for twice.
      if (inflight) return inflight;
      if (!fetcher) return Promise.resolve();
      const f = fetcher;
      put({ busy: true, error: null });
      inflight = (async () => {
        try {
          await f();
          put({ at: Date.now(), error: null });
        } catch (e) {
          // The data already held stays: a failed refresh should cost the
          // reader nothing they could still be reading.
          put({ error: describe(e instanceof Error ? e.message : String(e)) });
        } finally {
          put({ busy: false });
          inflight = null;
        }
      })();
      return inflight;
    },
    setError(message) {
      put({ error: message });
    },
    invalidate() {
      put({ at: 0 });
    },
    isStale(nowMs = Date.now()) {
      return state.at === 0 || nowMs - state.at > staleMs;
    },
    setEvery(secs) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      put({ every: secs, nextIn: secs });
      if (secs <= 0) return;
      timer = setInterval(() => {
        if (state.nextIn > 1) {
          put({ nextIn: state.nextIn - 1 });
          return;
        }
        put({ nextIn: secs });
        // Still stands down while the browser tab itself is hidden: a page
        // left open in a background window for a week would otherwise spend
        // its budget on nothing, and the first refresh on return catches up.
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          void store.run();
        }
      }, 1000);
    },
    reset() {
      if (timer) clearInterval(timer);
      timer = null;
      fetcher = null;
      inflight = null;
      state = fresh();
      listeners.clear();
    },
  };
  return store;
}
