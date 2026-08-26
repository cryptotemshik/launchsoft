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
 * The cache is deliberately long-lived. A creator who has connected an account
 * does not disconnect it, so a hit is good for hours; a miss is held for much
 * less, because connecting one later is exactly what a new project does.
 */
import { NO_SOCIALS, parseSocials, type CollectionSocials } from "../lib/socials";

interface Entry extends CollectionSocials {
  at: number;
  /** False when the page had nothing to say — held for a shorter time. */
  found: boolean;
}

const cache = new Map<string, Entry>();
const inflight = new Set<string>();

const HIT_TTL_MS = 12 * 3600_000;
const MISS_TTL_MS = 45 * 60_000;
/** OpenSea is not the product here — four at a time is polite and plenty. */
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 15_000;
/** A page this size is a rendered collection; anything smaller is an error. */
const MIN_USEFUL_BYTES = 20_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const queue: { chain: string; contract: string }[] = [];
let running = 0;

function fresh(e: Entry): boolean {
  return Date.now() - e.at < (e.found ? HIT_TTL_MS : MISS_TTL_MS);
}

async function readOne(chain: string, contract: string): Promise<CollectionSocials | null> {
  const res = await fetch(`https://opensea.io/assets/${chain}/${contract}`, {
    headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // A collection OpenSea has never indexed 404s. That is a real answer — there
  // is no account to find — and it caches like any other miss, so a page that
  // appears later is picked up within the hour.
  if (res.status === 404) return NO_SOCIALS;
  if (!res.ok) return null;
  const html = await res.text();
  if (html.length < MIN_USEFUL_BYTES) return null;
  // Null means the page said nothing about accounts either way, which is not
  // the same as saying there are none.
  return parseSocials(html);
}

function pump(onNote?: (s: string) => void): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    const key = job.contract.toLowerCase();
    running++;
    void readOne(job.chain, job.contract)
      .then((s) => {
        // A failed read is not an answer: leaving it uncached lets the next
        // ask try again, rather than pinning "no twitter" on a timeout.
        if (!s) return;
        cache.set(key, { ...s, at: Date.now(), found: s.twitter !== null || s.site !== null });
      })
      .catch((e) => onNote?.(`socials ${key.slice(0, 10)}: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        inflight.delete(key);
        running--;
        pump(onNote);
      });
  }
}

export interface SocialLookup {
  known: Record<string, CollectionSocials>;
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
export function lookupSocials(
  chain: string,
  contracts: readonly string[],
  limit = 60,
  onNote?: (s: string) => void,
): SocialLookup {
  const known: Record<string, CollectionSocials> = {};
  const pending: string[] = [];
  let queued = 0;

  for (const raw of contracts) {
    const key = raw.toLowerCase();
    const hit = cache.get(key);
    if (hit && fresh(hit)) {
      known[key] = { twitter: hit.twitter, site: hit.site };
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

/** For tests: the cache is process-lifetime state everywhere else. */
export function clearSocialCache(): void {
  cache.clear();
  inflight.clear();
  queue.length = 0;
}
