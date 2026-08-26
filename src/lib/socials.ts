/**
 * Whether a collection has a Twitter account attached to it.
 *
 * There is no on-chain answer to this. I looked for one: `contractURI()` is
 * empty on 88 of 90 collections sampled on this chain, and the two that return
 * anything carry name/description/image and nothing social. SeaDrop's
 * `DropURIUpdated` points at IPFS documents that describe the stages —
 * price, supply, start, end — and again no accounts. So the only place the
 * link exists is the marketplace the creator connected it on, and reading it
 * means reading OpenSea's page for the collection.
 *
 * That payload is a large escaped-JSON blob inside a script tag, which is why
 * this is a regex over text rather than a parse: pulling two fields out of two
 * megabytes is not worth reconstructing the document for.
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

export interface CollectionSocials {
  /** Handle without the @, or null when the creator connected nothing. */
  twitter: string | null;
  /** The project's own site, when it has one. */
  site: string | null;
}

export const NO_SOCIALS: CollectionSocials = { twitter: null, site: null };

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
 * The collection's accounts, or null when the page did not say.
 *
 * Null is the "ask again later" answer; a returned object with a null handle
 * is the "nothing connected" answer. They look alike and mean opposite things.
 */
export function parseSocials(html: string): CollectionSocials | null {
  const m = html.match(TWITTER);
  if (!m || m.index === undefined) return null;

  const from = Math.max(0, m.index - NEARBY);
  const near = html.slice(from, m.index + NEARBY);
  const site = near.match(/\\?"externalUrl\\?"\s*:\s*\\?"(https?:[^"\\]{0,300})\\?"/)?.[1];

  return { twitter: cleanHandle(m[1]), site: site ?? null };
}

export function twitterUrl(handle: string): string {
  return `https://x.com/${handle}`;
}
