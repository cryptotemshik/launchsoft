/**
 * What the marketplace knows about a collection that the chain does not.
 *
 * There is no on-chain answer to this. I looked for one: `contractURI()` is
 * empty on 88 of 90 collections sampled on this chain, and the two that return
 * anything carry name/description/image and nothing social. SeaDrop's
 * `DropURIUpdated` points at IPFS documents that describe the stages —
 * price, supply, start, end — and again no accounts. So the only place the
 * link exists is the marketplace the creator connected it on, and reading it
 * means reading OpenSea's page for the collection.
 *
 * The floor price rides along in the same page, so it costs nothing extra —
 * one fetch answers both questions. It is genuinely absent on most drops here,
 * because a collection with no listings has no floor, and that is reported as
 * absent rather than as zero.
 *
 * That payload is a large escaped-JSON blob inside a script tag, which is why
 * this is a regex over text rather than a parse: pulling a few fields out of
 * two megabytes is not worth reconstructing the document for.
 *
 * The one rule that matters here is the difference between "no account" and
 * "could not tell". A page that has never heard of `twitterUsername` is not a
 * collection without a Twitter — it is a page whose shape has changed, and
 * reporting it as an empty handle would quietly put a dash on every row in the
 * table. This returns null for that case, so the caller can decline to cache
 * an answer it did not get. Most collections genuinely have nothing here —
 * about one in ten of the ones sampled had a handle — and that is itself the
 * signal worth showing.
 */

/** The cheapest listing, in whatever coin the chain prices in. */
export interface FloorPrice {
  unit: number;
  /** USDG and ETH both occur on this chain — never assume which. */
  symbol: string;
  usd: number | null;
}

export interface CollectionInfo {
  /** Handle without the @, or null when the creator connected nothing. */
  twitter: string | null;
  /** The project's own site, when it has one. */
  site: string | null;
  /** Null when nothing is listed — which is normal for a drop that is early. */
  floor: FloorPrice | null;
  /** Filled in separately, once there is a handle to ask about. */
  followers?: number;
  joinedMs?: number;
}

export const NO_INFO: CollectionInfo = { twitter: null, site: null, floor: null };

/**
 * Where the collection's own social record sits.
 *
 * `twitterUsername` appears exactly once in the page — measured, across
 * collections with a handle and without — which is what makes an unanchored
 * match safe for it. Nothing else in the payload is: `isVerified` occurs about
 * two hundred times with both values, so a badge read from it would be a coin
 * flip, and there is no verified mark here for that reason.
 */
const TWITTER = /\\?"twitterUsername\\?"\s*:\s*(?:\\?"([^"\\]{0,200})\\?"|null)/;

/** Fields near the handle belong to the same collection; far ones do not. */
const NEARBY = 600;

/** A handle OpenSea would accept: letters, digits and underscore, up to 15. */
function cleanHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Creators paste whole URLs into that box often enough to be worth undoing.
  const m = raw.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
  const handle = (m?.[1] ?? raw).replace(/^@+/, "").trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

/**
 * The floor, read from the one place the page states it.
 *
 * `floorPrice` occurs exactly once per page — measured across collections with
 * a floor and without — while `bestOffer` occurs fifty times, once per item on
 * screen. Only the unique one can be attributed to this collection.
 */
function parseFloor(html: string): FloorPrice | null {
  const head = html.match(/\\?"floorPrice\\?"\s*:\s*(\{|null)/);
  // A collection with nothing listed writes `null` here. Scanning past that
  // for the next `unit` in the page finds some other record's price and
  // reports it as a floor of zero — which is what this guard is for.
  if (!head || head.index === undefined || head[1] !== "{") return null;
  const at = head.index + head[0].length;
  const near = html.slice(at, at + 500);
  const unit = Number(near.match(/\\?"unit\\?"\s*:\s*([0-9.eE+-]+)/)?.[1]);
  const symbol = near.match(/\\?"symbol\\?"\s*:\s*\\?"([A-Za-z]{1,10})\\?"/)?.[1];
  if (!Number.isFinite(unit) || !symbol) return null;
  const usd = Number(near.match(/\\?"usd\\?"\s*:\s*([0-9.eE+-]+)/)?.[1]);
  return { unit, symbol, usd: Number.isFinite(usd) ? usd : null };
}

/**
 * What the page says about this collection, or null when it did not say.
 *
 * Null is the "ask again later" answer; a returned object with a null handle
 * is the "nothing connected" answer. They look alike and mean opposite things.
 */
export function parseCollectionPage(html: string): CollectionInfo | null {
  const m = html.match(TWITTER);
  if (!m || m.index === undefined) return null;

  const from = Math.max(0, m.index - NEARBY);
  const near = html.slice(from, m.index + NEARBY);
  const site = near.match(/\\?"externalUrl\\?"\s*:\s*\\?"(https?:[^"\\]{0,300})\\?"/)?.[1];

  return { twitter: cleanHandle(m[1]), site: site ?? null, floor: parseFloor(html) };
}

export function twitterUrl(handle: string): string {
  return `https://x.com/${handle}`;
}
