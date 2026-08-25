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
export interface RpcSender {
  /** POST a JSON-RPC body and return the response text. */
  post(url: string, body: string): Promise<string>;
  /**
   * Open connections ahead of the fire moment.
   * @param connections how many simultaneous requests the blast will make to
   *   each endpoint — one open socket per wallet, not one per endpoint.
   */
  warm(endpoints: readonly RpcEndpoint[], connections: number): Promise<void>;
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
    await Promise.all(
      endpoints.map((ep) =>
        fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: WARM_BODY,
          keepalive: true,
        }).catch(() => undefined),
      ),
    );
  },
};

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
): Promise<void> {
  await sender.warm(endpoints, connections);
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
