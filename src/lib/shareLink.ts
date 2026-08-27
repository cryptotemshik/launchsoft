/**
 * A link that shows someone else what the feed is showing you.
 *
 * The panel talks to a server that holds real wallets, so the credential in a
 * shared link cannot be the one that fires from them. The box carries a second
 * token — set with `SNIPE_VIEW_TOKEN` — that reaches three read-only routes
 * and nothing else, and that is what travels here.
 *
 * It rides in the URL fragment rather than the query string. A fragment is
 * never sent to a server, so it stays out of access logs, out of `Referer`
 * headers on any link the page later loads, and out of the analytics of
 * whatever host the page is served from. The token still ends up in the
 * recipient's history and in whatever chat it was pasted into — a share link
 * is a secret you have decided to hand over, and the honest framing is that
 * anyone who gets it can watch, not that it is safe from everyone.
 */

export interface ShareTarget {
  /** The server's base URL. */
  url: string;
  /** The read-only token, never the firing one. */
  token: string;
}

const PREFIX = "#view=";

/** URL-safe base64, without the padding a link would have to escape. */
function encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4))));
}

export function buildShareLink(origin: string, target: ShareTarget): string {
  const base = origin.replace(/[#?].*$/, "").replace(/\/+$/, "");
  return `${base}/${PREFIX}${encode(JSON.stringify(target))}`;
}

/**
 * Read a share target out of a URL fragment, or null if there isn't one.
 *
 * Anything malformed returns null rather than throwing: this runs on page load
 * before anything is rendered, and a mangled link someone re-typed by hand
 * should land on the ordinary app, not on a blank screen.
 */
export function readShareLink(hash: string): ShareTarget | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(decode(hash.slice(PREFIX.length)));
    if (!parsed || typeof parsed !== "object") return null;
    const { url, token } = parsed as Record<string, unknown>;
    if (typeof url !== "string" || typeof token !== "string") return null;
    if (!url || !token) return null;
    // Only somewhere this app could sensibly talk to. A link is untrusted
    // input, and "https://" is the whole of what we can check here.
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, token };
  } catch {
    return null;
  }
}


/**
 * Whether this page was opened from a share link.
 *
 * Resolved once, at module load, because the answer decides what the very
 * first render shows — a viewer should never see the owner's tabs flash past
 * before being dropped into the feed.
 */
let viewing: ShareTarget | null = null;
let resolved = false;

export function adoptSharedLink(
  save: (url: string, token: string, remember: boolean) => void,
): ShareTarget | null {
  if (resolved || typeof window === "undefined") return viewing;
  resolved = true;
  const target = readShareLink(window.location.hash);
  if (!target) return null;
  save(target.url, target.token, false);
  // Out of the address bar, so a screenshot of the page does not carry it.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  viewing = target;
  return viewing;
}

/** True when the person looking at this is a guest, not the owner. */
export function isSharedView(): boolean {
  return viewing !== null;
}
