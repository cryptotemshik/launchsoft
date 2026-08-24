/**
 * Tiny fetch helper for the Blockscout v2 REST API. Public Blockscout
 * instances intermittently return an empty body or a transient 5xx; a couple
 * of quick retries make first paint reliable without a backend.
 */
export async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Blockscout responded ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error("Blockscout returned an empty response");
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
