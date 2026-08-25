/**
 * The client every read in the snipe flow goes through.
 *
 * A chain's public RPC is the default because it needs no setup, not because
 * it is good: it sits behind a CDN, meters requests per minute, and answers a
 * burst of balance or nonce reads with 429. Once someone has pasted their own
 * endpoint there is no reason to keep reading through the public one — so the
 * first endpoint they give becomes the primary and the public RPC drops to
 * being the backstop behind it.
 *
 * `fallback` is what makes that safe: if the paid endpoint errors or times out,
 * viem moves down the list rather than failing the read, so a provider outage
 * mid-drop degrades to "slower" instead of "broken".
 */
import { createPublicClient, fallback, type Chain, type PublicClient } from "viem";
import { readTransport } from "./rpcRead";

/**
 * @param custom endpoints the user supplied, best first. Empty means the chain
 *   default is all there is.
 */
export function makeReadClient(chain: Chain, custom: readonly string[]): PublicClient {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const u of [...custom, ...chain.rpcUrls.default.http]) {
    const t = u.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    urls.push(t);
  }
  return createPublicClient({
    chain,
    // rank: false keeps the given order — the user's endpoint is first because
    // they chose it, not because it won a latency race a moment ago. With more
    // than one endpoint, a dead primary should cost one failed attempt and then
    // the next endpoint, not three seconds of retries against a dead host.
    transport: fallback(
      urls.map((u) => readTransport(u, { retryCount: urls.length > 1 ? 1 : 3 })),
      { rank: false, retryCount: 0 },
    ),
  }) as PublicClient;
}

/** Host of the endpoint reads will actually be attempted against first. */
export function primaryReadHost(chain: Chain, custom: readonly string[]): string {
  const url = custom.find((u) => u.trim()) ?? chain.rpcUrls.default.http[0];
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
