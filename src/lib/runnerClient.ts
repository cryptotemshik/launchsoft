/**
 * Shared connection to the VPS control server.
 *
 * Both the Snipe queue panel and the Wallets tab talk to the same box, so the
 * URL and token live here rather than in either component — connect once and
 * every panel is connected.
 *
 * The URL is remembered in localStorage (harmless). The token is only put in
 * localStorage when the user opts in; otherwise it lives in sessionStorage and
 * is gone when the browser closes.
 */
import { useCallback, useEffect, useState } from "react";

const URL_KEY = "launchpad.runner.url";
const TOKEN_KEY = "launchpad.runner.token";

/**
 * The backend a normal visitor talks to, baked in at build time so they never
 * see or type a server address — that is operator machinery. Set VITE_RUNNER_URL
 * when building for the public site; left empty, only the operator (who types a
 * URL in the runner panel) reaches a server, which is exactly today's behaviour.
 */
export const DEFAULT_RUNNER_URL =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_RUNNER_URL ?? "").trim();

export function loadRunnerUrl(): string {
  return localStorage.getItem(URL_KEY) ?? DEFAULT_RUNNER_URL;
}

export function loadRunnerToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? "";
}

export function tokenIsRemembered(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
}

/** Forget the session token (a sign-out). The URL is left as-is. */
export function clearRunnerToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

export function saveRunnerCreds(url: string, token: string, remember: boolean) {
  localStorage.setItem(URL_KEY, url);
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.setItem(TOKEN_KEY, token);
  }
}

export interface RunnerApi {
  url: string;
  setUrl: (u: string) => void;
  token: string;
  setToken: (t: string) => void;
  remember: boolean;
  setRemember: (r: boolean) => void;
  /** Normalised base URL (no trailing slash). */
  base: string;
  /** Authenticated JSON call; throws with the server's message on failure. */
  call: (path: string, init?: RequestInit) => Promise<never | Record<string, unknown>>;
  /** Persist the current credentials. */
  save: () => void;
  /**
   * API version of the server that answered last, or null before the first
   * successful call. Older servers than {@link API_VERSION} predate the field
   * and report 1 — which is exactly the case worth warning about.
   */
  serverVersion: number | null;
}

/**
 * Sign in to a runner with a wallet, returning a session token to use as the
 * bearer in place of the operator's SNIPE_TOKEN.
 *
 * The three-step handshake: ask the server for a challenge, have the wallet
 * sign the exact message it returns, and post the signature back. The signer
 * is passed in — the caller has the wallet, this file does not — so this stays
 * free of wagmi and testable on its own.
 */
export async function signInWithWallet(
  base: string,
  address: string,
  sign: (message: string) => Promise<string>,
): Promise<{ token: string; address: string; admin: boolean }> {
  const root = base.trim().replace(/\/+$/, "");
  const ch = await fetch(`${root}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!ch.ok) throw new Error((await ch.json().catch(() => ({}))).error ?? `challenge failed (${ch.status})`);
  const { nonce, message } = (await ch.json()) as { nonce: string; message: string };
  const signature = await sign(message);
  const v = await fetch(`${root}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, nonce, signature }),
  });
  const body = (await v.json().catch(() => ({}))) as {
    token?: string;
    address?: string;
    admin?: boolean;
    error?: string;
  };
  if (!v.ok || !body.token) throw new Error(body.error ?? `sign-in failed (${v.status})`);
  return { token: body.token, address: body.address ?? address, admin: Boolean(body.admin) };
}

export interface Me {
  /** Null for the operator token, which is not a wallet account. */
  address: string | null;
  admin: boolean;
  /** True when authenticated by the operator token rather than a wallet. */
  operator?: boolean;
  tier: "free" | "pro";
  proUntil: number | null;
  profile: { nickname?: string; avatarUrl?: string; twitter?: string; telegram?: string };
}

/**
 * Who the browser is signed in as, from the server — or null when there is no
 * session yet. Used to decide what the UI offers (the admin tab, Pro-only
 * features, free-tier caps). It only ever hides or reveals; every gated route
 * checks for itself server-side, so a forged answer here buys nothing.
 */
export function useMe(): { me: Me | null; loading: boolean; reload: () => void } {
  const { base, token, call } = useRunnerApi();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    if (!base || !token) {
      setMe(null);
      return;
    }
    setLoading(true);
    void call("/api/auth/me")
      .then((m) => live && setMe(m as unknown as Me))
      .catch(() => live && setMe(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [base, token, call, tick]);
  return { me, loading, reload: () => setTick((n) => n + 1) };
}

export function useRunnerApi(): RunnerApi {
  const [url, setUrl] = useState(loadRunnerUrl);
  const [token, setToken] = useState(loadRunnerToken);
  const [remember, setRemember] = useState(tokenIsRemembered);
  const [serverVersion, setServerVersion] = useState<number | null>(null);

  const base = url.trim().replace(/\/+$/, "");

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${token.trim()}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      // Read the version even off an error response — a stale server is most
      // often noticed because a request it can't parse just failed.
      if (typeof body.apiVersion === "number") setServerVersion(body.apiVersion);
      else if (res.ok) setServerVersion(1);
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [base, token],
  );

  const save = useCallback(
    () => saveRunnerCreds(base, token.trim(), remember),
    [base, token, remember],
  );

  return { url, setUrl, token, setToken, remember, setRemember, base, call, save, serverVersion };
}
