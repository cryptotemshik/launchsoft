/**
 * The scan, kept outside the component that draws it.
 *
 * The Scanner tab is unmounted the moment you look at anything else — the app
 * renders one tab at a time — and every piece of what it had found lived in
 * that component's state. So leaving the tab threw the scan away, and coming
 * back re-ran it from nothing: four seconds of waiting, on an empty table, to
 * be shown the same rows as before. Setting an auto-refresh did not help
 * either, because the interval driving it was unmounted along with everything
 * else. "Every 30 seconds" meant "every 30 seconds, while you watch it".
 *
 * So the scan lives here instead, in the module, where nothing unmounts it.
 * The tab subscribes, draws whatever is already known the instant it opens,
 * and the refresh loop keeps running whether or not anyone is looking.
 *
 * Kept here: what costs a request. The scan itself, the collection lookups
 * that go with it, the window it was taken for, and the refresh interval.
 * Not kept here: the filters, the search box, the sort. Those are instant,
 * they are re-applied to the same rows, and a filter that outlives the visit
 * that set it is a table that lies about what it is showing.
 */
import type { ScannedDrop } from "./dropScan";
import type { CollectionInfo } from "./collectionInfo";
import type { IndexedCollection } from "./creatorIndex";
import type { MintPulse } from "./mintPulse";

export interface ScanView {
  drops: ScannedDrop[];
  /** True when the server topped the last scan up instead of re-reading it. */
  incremental?: boolean;
  newDrops?: number;
  hours: number;
  events: number;
  collections: number;
  enriched: number;
  fromBlock: number;
  toBlock: number;
  blocksPerHour: number;
  /** Host of the endpoint the server actually read through. */
  readRpc?: string;
  /** True when that was the chain's public RPC, with nothing better set. */
  publicRpc?: boolean;
  /** Set when that endpoint cannot serve a scan at all. */
  readRpcNote?: string | null;
  /** Minting over the last hour, keyed by lower-case contract. */
  pulse?: Record<string, MintPulse>;
  pulseHours?: number;
  nativeSymbol?: string;
  nativeUsd?: number | null;
  /** Owner and handle groupings, accumulated by the server across scans. */
  related?: {
    owners?: Record<string, IndexedCollection[]>;
    twitters?: Record<string, IndexedCollection[]>;
  };
  chain: string;
  explorerUrl: string;
  openSeaSlug?: string;
  now: number;
  tookMs: number;
  cachedAt?: number;
  /**
   * Whether the server answered from its index or read the chain for this.
   * Absent on servers that predate the index.
   */
  source?: "index" | "live";
  /** How far back the index actually reaches, in hours. */
  indexHours?: number;
}

export interface ScanState {
  view: ScanView | null;
  /** The window the held scan was taken for. */
  hours: number;
  /** When the held scan finished, in ms. 0 when there has never been one. */
  at: number;
  busy: boolean;
  error: string | null;
  info: Record<string, CollectionInfo>;
  twitterRelated: Record<string, IndexedCollection[]>;
  /** Contracts that arrived in the most recent refresh. */
  justIn: Set<string>;
  /** Auto-refresh interval in seconds; 0 is off. */
  every: number;
  /** Seconds until the next automatic refresh. */
  nextIn: number;
}

/**
 * How old a held scan may be before opening the tab refreshes it.
 *
 * Long enough that flicking between tabs costs nothing, short enough that a
 * countdown reading "0m 31s" is not a minute stale by the time it is read.
 * The rows are shown either way — the refresh happens underneath them.
 */
export const STALE_MS = 45_000;

export type ScanFetcher = (hours: number, fresh: boolean) => Promise<ScanView>;

let state: ScanState = {
  view: null,
  hours: 24,
  at: 0,
  busy: false,
  error: null,
  info: {},
  twitterRelated: {},
  justIn: new Set(),
  every: 0,
  nextIn: 0,
};

const listeners = new Set<() => void>();
let fetcher: ScanFetcher | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
/** Contracts the last scan held, so a new arrival can be told from the rest. */
let seen: Set<string> | null = null;

export function getScanState(): ScanState {
  return state;
}

export function subscribeScan(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(patch: Partial<ScanState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/**
 * Install the thing that actually talks to the server.
 *
 * The store cannot do it itself: the URL and the token belong to the runner
 * client, which is a hook. The tab hands one down whenever those change, and
 * the loop keeps using the last one it was given.
 */
export function setScanFetcher(f: ScanFetcher | null): void {
  fetcher = f;
}

/** True when the held scan is old enough to be worth replacing. */
export function scanIsStale(nowMs = Date.now()): boolean {
  return state.at === 0 || nowMs - state.at > STALE_MS;
}

/**
 * Run a scan and keep it.
 *
 * Concurrent calls collapse into the running one: the countdown and the tab
 * opening can ask at the same moment, and two identical four-second reads
 * would be paid for twice.
 */
export function runScan(hours: number, fresh = false): Promise<void> {
  if (inflight) return inflight;
  if (!fetcher) return Promise.resolve();
  const f = fetcher;
  set({ busy: true, error: null, hours });
  inflight = (async () => {
    try {
      const r = await f(hours, fresh);
      // A response missing its drops is a server that answered something else;
      // showing an empty scan beats throwing a `.map of undefined`.
      const found = r.drops ?? [];
      const ids = new Set(found.map((d) => d.contract.toLowerCase()));
      // On the first scan everything is new, which is not news — so the
      // baseline is set silently.
      const arrived = seen ? [...ids].filter((c) => !seen!.has(c)) : [];
      seen = ids;
      set({
        view: { ...r, drops: found },
        hours,
        at: Date.now(),
        error: null,
        justIn: arrived.length > 0 ? new Set(arrived) : state.justIn,
      });
      if (arrived.length > 0) onArrival?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        error: /404/.test(msg)
          ? "This server is too old to scan — update it from the Snipe tab."
          : msg,
      });
    } finally {
      set({ busy: false });
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * What to do when a scan turns up a collection that was not there before.
 *
 * A hook rather than a direct call so the store stays free of anything that
 * touches the browser — it is the tab that owns the sound.
 */
let onArrival: (() => void) | null = null;
export function setScanArrivalHandler(fn: (() => void) | null): void {
  onArrival = fn;
}

export function mergeCollectionInfo(
  known: Record<string, CollectionInfo> | undefined,
  twitters: Record<string, IndexedCollection[]> | undefined,
): void {
  const patch: Partial<ScanState> = {};
  if (known && Object.keys(known).length > 0) patch.info = { ...state.info, ...known };
  if (twitters && Object.keys(twitters).length > 0) {
    patch.twitterRelated = { ...state.twitterRelated, ...twitters };
  }
  if (Object.keys(patch).length > 0) set(patch);
}

/**
 * Start, restart or stop the refresh loop.
 *
 * The loop lives in the module, so it survives leaving the tab — which is the
 * whole point of setting one. It still stands down while the browser tab
 * itself is hidden: a scanner left open in a background window for a week
 * would otherwise spend its budget on drops nobody is looking at, and the
 * first refresh on return catches up anyway.
 */
export function setScanEvery(secs: number): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  set({ every: secs, nextIn: secs });
  if (secs <= 0) return;
  timer = setInterval(() => {
    if (state.nextIn > 1) {
      set({ nextIn: state.nextIn - 1 });
      return;
    }
    set({ nextIn: secs });
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void runScan(state.hours);
    }
  }, 1000);
}

/** For tests: forget everything, including the loop. */
export function resetScanStore(): void {
  if (timer) clearInterval(timer);
  timer = null;
  fetcher = null;
  onArrival = null;
  inflight = null;
  seen = null;
  state = {
    view: null,
    hours: 24,
    at: 0,
    busy: false,
    error: null,
    info: {},
    twitterRelated: {},
    justIn: new Set(),
    every: 0,
    nextIn: 0,
  };
  listeners.clear();
}
