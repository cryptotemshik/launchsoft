/**
 * Race a signed transaction across several RPC endpoints at once and take
 * whichever answers first, instead of trusting one node's queue. Dispatch is
 * fire-and-forget: all requests are issued in the same tick, so wall-clock
 * cost at fire time is the slowest single request, not their sum.
 *
 * The transaction hash is computed locally (keccak256 of the raw signed tx)
 * so it's known before any endpoint responds — receipts can be polled
 * immediately instead of waiting on a submission response first.
 */
import { keccak256, type Hex, type PublicClient } from "viem";

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface BlastResult {
  label: string;
  txHash: string | null;
  error: string | null;
}

/** A short, recognisable label for a raw RPC URL — for the fire-time log only. */
export function labelRpc(url: string, index: number): string {
  const lower = url.toLowerCase();
  if (lower.includes("sequencer")) return "sequencer";
  if (lower.includes("alchemy")) return "alchemy";
  if (lower.includes("flashbots")) return "flashbots-protect";
  if (lower.includes("quicknode")) return "quicknode";
  if (lower.includes("infura")) return "infura";
  if (lower.includes("ankr")) return "ankr";
  if (lower.includes("publicnode")) return "publicnode";
  if (lower.includes("cloudflare")) return "cloudflare";
  try {
    return new URL(url).hostname;
  } catch {
    return `rpc[${index}]`;
  }
}

/** De-dupe and label a list of RPC URLs pulled from chain defaults + user input. */
export function parseRpcEndpoints(urls: string[]): RpcEndpoint[] {
  const seen = new Set<string>();
  const out: RpcEndpoint[] = [];
  urls
    .map((u) => u.trim())
    .filter(Boolean)
    .forEach((url, i) => {
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, label: labelRpc(url, i) });
    });
  return out;
}

export interface PreparedBlast {
  txHash: Hex;
  body: string;
}

/** Do all the compute work — hash + JSON-RPC envelope — before the fire moment. */
export function prepareBlast(rawTx: Hex): PreparedBlast {
  return {
    txHash: keccak256(rawTx),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [rawTx],
      id: 1,
    }),
  };
}

/**
 * How a request actually reaches an endpoint.
 *
 * The browser has one implementation and Node another, and the difference is
 * not cosmetic: a browser pools and multiplexes connections for you, while
 * Node's fetch opens a fresh HTTP/1.1 connection per concurrent request. With
 * a hundred wallets firing at once that means a hundred TLS handshakes at the
 * exact moment they must not happen, which is the cost warming exists to
 * avoid. Node therefore supplies a sender backed by a keep-alive pool — see
 * src/cli/nodeSender.ts.
 */
/** What a warm-up managed, so a short one can be said out loud. */
export interface WarmReport {
  /** Connections asked for, per endpoint. */
  wanted: number;
  /** Warm-up requests that came back, across every endpoint. */
  opened: number;
  failed: number;
  /** Endpoints that gave back fewer than `wanted`. */
  short: { label: string; opened: number }[];
  /** True when the request was clamped by the socket ceiling itself. */
  capped: boolean;
}

export interface RpcSender {
  /** POST a JSON-RPC body and return the response text. */
  post(url: string, body: string): Promise<string>;
  /**
   * Open connections ahead of the fire moment.
   * @param connections how many simultaneous requests the blast will make to
   *   each endpoint — one open socket per wallet, not one per endpoint.
   */
  warm(endpoints: readonly RpcEndpoint[], connections: number): Promise<WarmReport>;
}

const WARM_BODY = JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 });

/** The browser's sender: fetch, which pools and multiplexes on its own. */
export const fetchSender: RpcSender = {
  async post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return res.text();
  },
  async warm(endpoints, connections) {
    // One per endpoint is enough here: a browser reuses one HTTP/2 connection
    // for every concurrent request to the same origin.
    void connections;
    const results = await Promise.all(
      endpoints.map((ep) =>
        fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: WARM_BODY,
          keepalive: true,
        }).then(
          () => true,
          () => false,
        ),
      ),
    );
    const opened = results.filter(Boolean).length;
    return {
      wanted: 1,
      opened,
      failed: results.length - opened,
      short: endpoints.filter((_, i) => !results[i]).map((ep) => ({ label: ep.label, opened: 0 })),
      capped: false,
    };
  },
};

/**
 * How a blast is split into waves.
 *
 * Two measurements drive this, both taken against a local server with the far
 * end in its own process, three endpoints, medians of three runs:
 *
 *   wallets   all at once, 3 endpoints   sequencer only
 *        22   first  5.3ms               first 2.8ms
 *       100   first   13ms               first 7.1ms
 *       300   first   42ms               first  13ms
 *
 * Two separate costs, and the plan addresses both.
 *
 * The first is that every wallet you load slows down wallet number one. Node
 * has one thread: a single synchronous pass queues every request, and the
 * write for the first wallet does not reach the kernel until the pass is over.
 * So the wallets that will actually win the drop wait behind the ones that are
 * only there for volume. Firing a head wave on its own and letting it clear
 * first gives those wallets the latency they would have had if nothing else
 * were loaded — measured at 300 wallets: first done 27ms in waves against
 * 109ms all at once, with the tail arriving no later either.
 *
 * The second is that on a first-come-first-served chain only the sequencer
 * decides ordering. The other endpoints are insurance — worth having, worthless
 * for the race — and in the head wave they simply triple the work the thread
 * has to get through. So the head goes to the sequencer alone and reaches the
 * rest afterwards, which costs the head nothing and still leaves every wallet
 * broadcast everywhere.
 */
export interface WavePlan {
  /** Wallets in the first wave. */
  head: number;
  /** Where the first wave goes — the sequencer alone, where there is one. */
  headEndpoints: RpcEndpoint[];
  /** Where the first wave is repeated once the rest is away. */
  catchUpEndpoints: RpcEndpoint[];
  /** Everything the second wave goes to. */
  tailEndpoints: RpcEndpoint[];
  /** Longest the second wave will wait for the first to clear. */
  maxGapMs: number;
}

export function planWaves(
  total: number,
  endpoints: readonly RpcEndpoint[],
  submit: readonly RpcEndpoint[],
  opts: { headSize: number; maxGapMs: number },
): WavePlan {
  const all = [...endpoints];
  // headSize 0 turns the split off: one wave, every endpoint, as it was.
  const head = opts.headSize <= 0 ? 0 : Math.min(opts.headSize, total);
  const submitUrls = new Set(submit.map((e) => e.url));
  const preferred = all.filter((e) => submitUrls.has(e.url));
  // A chain with no send-only endpoint has nothing to prefer, so the head
  // goes everywhere at once and there is nothing left to catch up on.
  const headEndpoints = head > 0 && preferred.length > 0 ? preferred : all;
  const catchUpEndpoints = head > 0 ? all.filter((e) => !headEndpoints.includes(e)) : [];
  return { head, headEndpoints, catchUpEndpoints, tailEndpoints: all, maxGapMs: opts.maxGapMs };
}

/**
 * Wait for the first wave to clear, but never longer than the gap.
 *
 * Waiting for the responses rather than sleeping a fixed number of
 * milliseconds is what makes the split self-tuning: the gap only has to be
 * long enough, and a head that answers in 4ms does not cost the tail 40. The
 * cap is there so an endpoint that never answers cannot hold the rest of the
 * blast — the transactions are already signed and the stage is already open.
 */
export function settleOrTimeout(work: readonly Promise<unknown>[], maxMs: number): Promise<void> {
  if (work.length === 0 || maxMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    void Promise.allSettled(work).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Fire the prepared payload at every endpoint simultaneously. Returns
 * immediately with the locally-computed hash — the caller doesn't wait on
 * any network response before moving to the next wallet.
 */
export function blastToAll(
  prepared: PreparedBlast,
  endpoints: RpcEndpoint[],
  sender: RpcSender = fetchSender,
): { txHash: Hex; results: Promise<BlastResult[]> } {
  const results = Promise.all(
    endpoints.map(async (ep): Promise<BlastResult> => {
      try {
        const text = await sender.post(ep.url, prepared.body);
        const json = JSON.parse(text) as {
          result?: string;
          error?: { message?: string } | string;
        };
        if (json.result) return { label: ep.label, txHash: json.result, error: null };
        const msg =
          typeof json.error === "string"
            ? json.error
            : (json.error?.message ?? "unknown error");
        return { label: ep.label, txHash: null, error: msg };
      } catch (err) {
        return {
          label: ep.label,
          txHash: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return { txHash: prepared.txHash, results };
}

/**
 * Open connections to every endpoint ahead of the fire moment.
 *
 * A cold HTTPS request pays DNS + TCP + TLS before a single byte of the
 * transaction moves — measured at ~400ms of a ~470ms request, i.e. most of the
 * cost. Warming means the broadcast is just the round-trip.
 *
 * `connections` is the number of wallets that will fire at once, not a tuning
 * knob: under HTTP/1.1 each concurrent request needs its own socket, so
 * warming one connection for a hundred wallets leaves ninety-nine of them
 * shaking hands at T-0. Measured against a local TLS server, a hundred-wallet
 * blast went from 99 fresh handshakes and 223ms to 0 handshakes and 27ms.
 */
export async function warmEndpoints(
  endpoints: readonly RpcEndpoint[],
  connections = 1,
  sender: RpcSender = fetchSender,
): Promise<WarmReport> {
  return sender.warm(endpoints, connections);
}

/** True when a per-endpoint error means "already broadcast", not "rejected". */
export function isAlreadyKnown(error: string | null): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return e.includes("already known") || e.includes("already exists");
}

/**
 * Poll for a receipt without throwing on timeout — a transaction that never
 * confirms in the window still has its hash logged, so the user can keep
 * checking the explorer link instead of losing track of it.
 */
export async function waitForReceiptOrNull(
  publicClient: PublicClient,
  hash: Hex,
  timeoutMs = 60_000,
) {
  try {
    return await publicClient.waitForTransactionReceipt({
      hash,
      timeout: timeoutMs,
      pollingInterval: 1000,
    });
  } catch {
    return null;
  }
}
