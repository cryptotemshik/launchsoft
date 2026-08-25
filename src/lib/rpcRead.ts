/**
 * Reading chain state for a large wallet set without tripping a rate limit.
 *
 * A hundred wallets means a hundred `eth_getBalance` calls, and the same again
 * for nonces before a disperse. Fired all at once at a public endpoint that
 * meters per second, most of them come back as "Rate Limit Hit" — and because
 * the funding flow reads a block for the base fee too, the whole operation
 * fails on a read, having sent nothing.
 *
 * Two things fix it, and both are needed:
 *   - JSON-RPC batching, so twenty calls travel in one HTTP POST. Robinhood
 *     Chain's own RPC and every provider we point at support it.
 *   - A ceiling on how many of those batches are in flight, plus a retry that
 *     waits out the window when one is refused anyway.
 */
import { http, type HttpTransport } from "viem";

/** How many calls viem may coalesce into a single POST. */
const BATCH_SIZE = 20;
/** How long viem waits to collect calls before sending a batch. */
const BATCH_WAIT_MS = 16;

/**
 * A transport for reads over a big wallet set. Deliberately different from the
 * one used to broadcast a mint: there, batching would add latency to the only
 * request that matters.
 */
export function readTransport(url: string, opts: { retryCount?: number } = {}): HttpTransport {
  return http(url, {
    batch: { batchSize: BATCH_SIZE, wait: BATCH_WAIT_MS },
    // Behind a fallback this should be low: every retry here is time spent on
    // an endpoint already known to be failing, before the next one is tried.
    retryCount: opts.retryCount ?? 3,
    retryDelay: 400,
    timeout: 20_000,
    // Robinhood Chain's RPC answers a throttled batch with HTTP 429 and a
    // single JSON-RPC error object rather than one entry per call. viem takes
    // that as the batch's reply, tries to match it up per call, and surfaces
    // the resulting TypeError as "An unknown RPC error occurred" — which is
    // neither retried nor recognisable. Catching the status here turns it back
    // into what it is.
    onFetchResponse(response) {
      if (response.status === 429) {
        throw new Error(`rate limit (HTTP 429) from ${new URL(response.url || url).host}`);
      }
    },
  });
}

/**
 * Whether an error is the endpoint saying "slow down" rather than "no".
 * Providers disagree on how to say it: some use HTTP 429, some a JSON-RPC
 * error code, some only the message.
 */
export function isRateLimit(err: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "string") parts.push(cur);
    else if (typeof cur === "object") {
      const o = cur as Record<string, unknown>;
      if (typeof o.message === "string") parts.push(o.message);
      if (typeof o.details === "string") parts.push(o.details);
      if (typeof o.shortMessage === "string") parts.push(o.shortMessage);
      if (typeof o.status === "number") parts.push(String(o.status));
      if (typeof o.code === "number") parts.push(String(o.code));
      cur = o.cause;
      continue;
    }
    break;
  }
  const text = parts.join(" ").toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("429") ||
    // Common JSON-RPC codes for throttling across providers.
    text.includes("-32005") ||
    text.includes("-32029")
  );
}

export interface MapOptions {
  /** Calls in flight at once. With batching each one is a fraction of a POST. */
  limit?: number;
  /** How many times a rate-limited call is retried before giving up. */
  retries?: number;
  /** Base backoff; doubles per attempt. */
  backoffMs?: number;
  /** Injected in tests so waiting costs nothing. */
  sleep?: (ms: number) => Promise<void>;
  /** Surfaced so a long wait doesn't look like a hang. */
  onRetry?: (waitMs: number, attempt: number) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `Promise.all(items.map(fn))` with a ceiling on concurrency and a backoff for
 * anything the endpoint refuses for rate. Results keep the input order.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: MapOptions = {},
): Promise<R[]> {
  const limit = Math.max(1, opts.limit ?? 25);
  const retries = opts.retries ?? 4;
  const backoffMs = opts.backoffMs ?? 600;
  const sleep = opts.sleep ?? wait;

  const out = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      let attempt = 0;
      for (;;) {
        try {
          out[i] = await fn(items[i], i);
          break;
        } catch (e) {
          if (!isRateLimit(e) || attempt >= retries) throw e;
          const waitMs = backoffMs * 2 ** attempt;
          attempt += 1;
          opts.onRetry?.(waitMs, attempt);
          await sleep(waitMs);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
