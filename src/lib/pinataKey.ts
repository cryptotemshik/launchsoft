/**
 * Optional "remember my Pinata JWT" storage.
 *
 * The key is kept in THIS browser's localStorage only, so the Launch and
 * Reveal tabs prefill it instead of asking every session. It is deliberately
 * never compiled into the app: LaunchPad ships as a public static site, so a
 * hard-coded key would be readable by every visitor in the JS bundle and let
 * anyone pin files to that Pinata account.
 */

const KEY = "launchpad.pinata.jwt.v1";

export function loadPinataJwt(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function savePinataJwt(jwt: string): void {
  try {
    const trimmed = jwt.trim();
    if (trimmed) localStorage.setItem(KEY, trimmed);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode / quota) — the in-memory value still works.
  }
}

export function forgetPinataJwt(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
