/**
 * Talking to a Blockscout index without being throttled into silence.
 *
 * Measured against Robinhood Chain's instance, twenty simultaneous requests
 * had fifteen refused; even five at a time lost two in twenty. A scan that
 * treats a refusal as "this wallet holds nothing" therefore reports zero for a
 * wallet full of tokens — which is exactly what the sweep did, and why it
 * looked broken rather than rate-limited.
 *
 * So every request here is throttled, retried, and — when it still fails —
 * reported as a failure rather than folded into the result as an absence.
 */
import { mapWithLimit } from "../lib/rpcRead";

/** Concurrent requests. Five is where the index stops refusing outright. */
export const SCAN_CONCURRENCY = 5;
const TIMEOUT_MS = 20_000;
const RETRIES = 4;

export class BlockscoutError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BlockscoutError";
  }
}

/** One GET, with a timeout, decoded as JSON. Throws on anything but 2xx. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new BlockscoutError(`HTTP ${res.status} from ${new URL(url).pathname}`, res.status);
  }
  return (await res.json()) as T;
}

/** Whether a failure is worth waiting out rather than giving up on. */
function worthRetrying(e: unknown): boolean {
  if (e instanceof BlockscoutError) {
    // 429 and the 5xx family are "later, not never". A 404 is never.
    return e.status === undefined || e.status === 429 || e.status >= 500;
  }
  // Timeouts and socket errors, which under load are the common shape.
  return true;
}

/** getJson with a backoff, because the index refuses some of every burst. */
export async function getJsonRetrying<T>(
  url: string,
  onRetry?: (waitMs: number, attempt: number) => void,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await getJson<T>(url);
    } catch (e) {
      if (!worthRetrying(e) || attempt >= RETRIES) throw e;
      const waitMs = 500 * 2 ** attempt;
      attempt += 1;
      onRetry?.(waitMs, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** How many tokens of each collection an address holds. */
export interface TokenCount {
  collection: `0x${string}`;
  collectionName?: string;
  count: number;
}

/**
 * The cheap half of a scan: which collections a wallet holds and how many.
 *
 * `/tokens` is 773 bytes where `/nft` is 11.8KB for the same wallet, because
 * it carries counts rather than every token's metadata and base64 image. It
 * has no token ids, which is fine — most wallets turn out to hold nothing, and
 * this decides which ones are worth the expensive call.
 */
export async function walletTokenCounts(
  api: string,
  wallet: `0x${string}`,
): Promise<TokenCount[]> {
  const data = await getJsonRetrying<{
    items?: { token?: { address_hash?: string; name?: string }; value?: string }[];
  }>(`${api}/addresses/${wallet}/tokens?type=ERC-721`);

  const out: TokenCount[] = [];
  for (const item of data.items ?? []) {
    const addr = item.token?.address_hash?.toLowerCase();
    const count = Number(item.value ?? 0);
    if (!addr || !Number.isFinite(count) || count <= 0) continue;
    out.push({
      collection: addr as `0x${string}`,
      collectionName: item.token?.name,
      count,
    });
  }
  return out;
}

export interface ScanFailure {
  wallet: `0x${string}`;
  reason: string;
}

/**
 * Run `fn` over every wallet, throttled, collecting failures rather than
 * letting one refusal stand in for an empty wallet.
 */
export async function scanWallets<T>(
  wallets: readonly `0x${string}`[],
  fn: (wallet: `0x${string}`) => Promise<T>,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<{ results: Map<string, T>; failed: ScanFailure[] }> {
  const results = new Map<string, T>();
  const failed: ScanFailure[] = [];
  let done = 0;

  await mapWithLimit(
    wallets,
    async (wallet) => {
      try {
        results.set(wallet.toLowerCase(), await fn(wallet));
      } catch (e) {
        failed.push({ wallet, reason: e instanceof Error ? e.message : String(e) });
      } finally {
        done += 1;
        opts.onProgress?.(done, wallets.length);
      }
    },
    { limit: SCAN_CONCURRENCY, retries: 0 },
  );

  return { results, failed };
}
