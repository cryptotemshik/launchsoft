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
 * Fire the prepared payload at every endpoint simultaneously. Returns
 * immediately with the locally-computed hash — the caller doesn't wait on
 * any network response before moving to the next wallet.
 */
export function blastToAll(
  prepared: PreparedBlast,
  endpoints: RpcEndpoint[],
): { txHash: Hex; results: Promise<BlastResult[]> } {
  const results = Promise.all(
    endpoints.map(async (ep): Promise<BlastResult> => {
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: prepared.body,
        });
        const json = (await res.json()) as {
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
