/**
 * Referral attribution, browser side.
 *
 * An influencer's link is `…/?ref=CODE`. We stash the code the moment someone
 * lands (before they've connected a wallet), strip it from the address bar so
 * it doesn't linger or get shared on, and bind it to their account once they
 * sign in (see App). Storage, not a cookie — same-origin, per-browser, and it
 * survives the reload that a sign-in triggers.
 */
const KEY = "orvex.ref";

function clean(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
}

/** Pull ?ref= out of the URL into storage, then remove it from the address bar. */
export function captureRefFromUrl(): void {
  try {
    const u = new URL(window.location.href);
    const raw = u.searchParams.get("ref");
    if (!raw) return;
    const code = clean(raw);
    if (code) localStorage.setItem(KEY, code);
    u.searchParams.delete("ref");
    window.history.replaceState({}, "", u.pathname + u.search + u.hash);
  } catch {
    /* a locked-down browser can throw on storage/history — attribution is best-effort */
  }
}

/** The referral code awaiting binding, if any. */
export function pendingRefCode(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? clean(v) : null;
  } catch {
    return null;
  }
}

export function clearRefCode(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
