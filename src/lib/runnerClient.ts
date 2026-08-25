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
import { useCallback, useState } from "react";

const URL_KEY = "launchpad.runner.url";
const TOKEN_KEY = "launchpad.runner.token";

export function loadRunnerUrl(): string {
  return localStorage.getItem(URL_KEY) ?? "";
}

export function loadRunnerToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? "";
}

export function tokenIsRemembered(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
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
