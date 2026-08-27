/**
 * Looking up who a collection is, without making anyone wait for it.
 *
 * Each answer costs a two-megabyte page fetch, so this is built around never
 * doing that fetch twice and never doing it in the request path. A lookup
 * returns whatever is already known immediately and starts the rest in the
 * background; the panel asks again a moment later and the answers have filled
 * in. The alternative — a request that blocks until forty pages have been
 * read — would time out on the tunnel long before it finished.
 *
 * Where a handle turns up, a second and far cheaper read follows it: a
 * kilobyte from a public mirror for the follower count and the join date. That
 * one is cached by handle rather than by collection, because a creator with
 * three drops has one account.
 *
 * The caches are deliberately long-lived. A creator who has connected an
 * account does not disconnect it, so a hit is good for hours; a miss is held
 * for much less, because connecting one later is exactly what a new project
 * does. The floor moves faster than either, which is what pins the page TTL.
 */
import { NO_INFO, parseCollectionPage, type CollectionInfo } from "../lib/collectionInfo";
import { parseTwitterStats, type TwitterStats } from "../lib/twitterStats";

interface Entry extends CollectionInfo {
  at: number;
  /** False when the page had nothing to say — held for a shorter time. */
  found: boolean;
}

const cache = new Map<string, Entry>();
const inflight = new Set<string>();
/** Null records a mirror that would not answer — held briefly, so a
 *  handle isn't re-asked on every refresh while both are down. */
const stats = new Map<string, { at: number; stats: TwitterStats | null }>();
const statsInflight = new Set<string>();

/**
 * A collection with a handle carries a floor price too, and that does move.
 * Half an hour is the compromise: fresh enough to act on, rare enough that a
 * table of forty rows costs forty page reads an hour at worst.
 */
const HIT_TTL_MS = 30 * 60_000;
const MISS_TTL_MS = 45 * 60_000;
const STATS_TTL_MS = 6 * 3600_000;
const STATS_FAIL_TTL_MS = 10 * 60_000;
/** OpenSea is not the product here — four at a time is polite and plenty. */
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 15_000;
const STATS_TIMEOUT_MS = 8_000;
/** A page this size is a rendered collection; anything smaller is an error. */
const MIN_USEFUL_BYTES = 20_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Two mirrors of the same data, under different field names. */
const TWITTER_MIRRORS = ["https://api.fxtwitter.com/", "https://api.vxtwitter.com/"];

const queue: { chain: string; contract: string }[] = [];
let running = 0;

function fresh(e: Entry): boolean {
  return Date.now() - e.at < (e.found ? HIT_TTL_MS : MISS_TTL_MS);
}

async function readPage(chain: string, contract: string): Promise<CollectionInfo | null> {
  const res = await fetch(`https://opensea.io/assets/${chain}/${contract}`, {
    headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // A collection OpenSea has never indexed 404s. That is a real answer — there
  // is no account to find — and it caches like any other miss, so a page that
  // appears later is picked up within the hour.
  if (res.status === 404) return NO_INFO;
  if (!res.ok) return null;
  const html = await res.text();
  if (html.length < MIN_USEFUL_BYTES) return null;
  // Null means the page said nothing about accounts either way, which is not
  // the same as saying there are none.
  return parseCollectionPage(html);
}

/**
 * Follower count and join date for one handle.
 *
 * Both mirrors answer an unknown handle with something that is not an account
 * — one serves an HTML page with a 200 — so the parser, not the status code,
 * decides whether there was an answer.
 */
async function readStats(handle: string): Promise<TwitterStats | null> {
  for (const base of TWITTER_MIRRORS) {
    try {
      const r = await fetch(base + encodeURIComponent(handle), {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const parsed = parseTwitterStats(await r.json());
      if (parsed) return parsed;
    } catch {
      // Try the other mirror; if both are unreachable the column simply shows
      // the handle without a count, which is still the useful half.
    }
  }
  return null;
}

function wantStats(handle: string, onNote?: (s: string) => void): void {
  const key = handle.toLowerCase();
  const hit = stats.get(key);
  const ttl = hit?.stats ? STATS_TTL_MS : STATS_FAIL_TTL_MS;
  if ((hit && Date.now() - hit.at < ttl) || statsInflight.has(key)) return;
  statsInflight.add(key);
  void readStats(handle)
    .then((s) => stats.set(key, { at: Date.now(), stats: s }))
    .catch((e) => onNote?.(`twitter ${key}: ${e instanceof Error ? e.message : e}`))
    .finally(() => statsInflight.delete(key));
}

function withStats(info: CollectionInfo): CollectionInfo {
  if (!info.twitter) return info;
  const s = stats.get(info.twitter.toLowerCase())?.stats;
  if (!s) return info;
  return { ...info, followers: s.followers, joinedMs: s.joinedMs ?? undefined };
}

function pump(onNote?: (s: string) => void): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    const key = job.contract.toLowerCase();
    running++;
    void readPage(job.chain, job.contract)
      .then((info) => {
        // A failed read is not an answer: leaving it uncached lets the next
        // ask try again, rather than pinning "no twitter" on a timeout.
        if (!info) return;
        cache.set(key, {
          ...info,
          at: Date.now(),
          found: info.twitter !== null || info.site !== null || info.floor !== null,
        });
        if (info.twitter) wantStats(info.twitter, onNote);
      })
      .catch((e) => onNote?.(`socials ${key.slice(0, 10)}: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        inflight.delete(key);
        running--;
        pump(onNote);
      });
  }
}

export interface CollectionLookup {
  known: Record<string, CollectionInfo>;
  /** Still being read, or waiting to be. Ask again shortly. */
  pending: string[];
}

/**
 * What is known about these collections, plus what is being found out.
 *
 * @param limit how many unknown collections this call may put in the queue.
 *   The panel asks about what is on screen, so the cap is a guard against a
 *   filter that matches two thousand rows, not against normal use.
 */
export function lookupCollections(
  chain: string,
  contracts: readonly string[],
  limit = 60,
  onNote?: (s: string) => void,
): CollectionLookup {
  const known: Record<string, CollectionInfo> = {};
  const pending: string[] = [];
  let queued = 0;

  for (const raw of contracts) {
    const key = raw.toLowerCase();
    const hit = cache.get(key);
    if (hit && fresh(hit)) {
      known[key] = withStats({ twitter: hit.twitter, site: hit.site, floor: hit.floor });
      // The page is cached but the follower count may not have landed with it,
      // or may have expired on its own clock.
      if (hit.twitter && known[key].followers === undefined) {
        wantStats(hit.twitter, onNote);
        // Only worth another round while nobody has decided about it yet: a
        // mirror that refused stays refused for a while, and saying "pending"
        // about it would keep the panel asking on a loop.
        if (!stats.has(hit.twitter.toLowerCase())) pending.push(key);
      }
      continue;
    }
    if (inflight.has(key)) {
      pending.push(key);
      continue;
    }
    if (queued >= limit) continue;
    queued++;
    inflight.add(key);
    queue.push({ chain, contract: raw });
    pending.push(key);
  }

  if (queued > 0) pump(onNote);
  return { known, pending };
}

/** For tests: the caches are process-lifetime state everywhere else. */
export function clearCollectionCache(): void {
  cache.clear();
  inflight.clear();
  stats.clear();
  statsInflight.clear();
  queue.length = 0;
}
