/**
 * The sender the runner uses to broadcast. Node-only.
 *
 * Node's `fetch` is HTTP/1.1 by default, and HTTP/1.1 cannot put two requests
 * on one connection at the same time. So a hundred wallets firing together
 * open a hundred connections — and the warming step, which opened exactly one,
 * saved exactly one of them a handshake. The other ninety-nine did their TLS
 * negotiation at T-0, in the microseconds that the whole design exists to
 * protect, while competing for the same CPU.
 *
 * Measured against a local TLS server, a hundred-wallet blast:
 *
 *   one warmed connection   99 fresh handshakes at fire time   223ms
 *   a warmed pool of 100     0 fresh handshakes                 27ms
 *
 * Localhost flatters the old number, because there a handshake costs almost
 * nothing; over a real network each one is a further round-trip.
 *
 * So: one socket per wallet, opened before the stage does, held open by
 * keep-alive, and re-warmed on the approach in case the far end dropped any.
 */
import { Agent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import type { RpcEndpoint, RpcSender } from "../lib/rpcBlast";

/**
 * Node closes idle pooled sockets above this many, so it has to be at least
 * as large as the pool we want held open.
 */
const MAX_SOCKETS = 512;

const poolOptions = {
  keepAlive: true,
  // TCP keep-alive probes, so an idle socket isn't dropped by anything in the
  // middle (a NAT, a load balancer) without us noticing.
  keepAliveMsecs: 10_000,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_SOCKETS,
  scheduling: "fifo" as const,
};

const agent = new Agent(poolOptions);
/** Same pool for plain http — a local node, and what the tests measure. */
const insecureAgent = new HttpAgent(poolOptions);

const WARM_BODY = JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 });

function post(url: string, body: string, timeoutMs = 15_000): Promise<string> {
  const u = new URL(url);
  const send = u.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        agent: u.protocol === "http:" ? insecureAgent : agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

export const nodeSender: RpcSender = {
  post,
  /**
   * Open `connections` sockets to each endpoint at once. They are only pooled
   * while they overlap — issuing them one after another would reuse a single
   * socket and warm nothing — so these all have to be in flight together.
   */
  async warm(endpoints: readonly RpcEndpoint[], connections: number): Promise<void> {
    const want = Math.min(Math.max(1, connections), MAX_SOCKETS);
    await Promise.all(
      endpoints.flatMap((ep) =>
        Array.from({ length: want }, () => post(ep.url, WARM_BODY, 8_000).catch(() => "")),
      ),
    );
  },
};

/** Sockets currently held open across both pools — for the fire-time log. */
export function pooledSockets(): number {
  const count = (a: Agent | HttpAgent) =>
    Object.values(a.freeSockets ?? {}).reduce((n, s) => n + (s?.length ?? 0), 0) +
    Object.values(a.sockets ?? {}).reduce((n, s) => n + (s?.length ?? 0), 0);
  return count(agent) + count(insecureAgent);
}

/** Close every pooled socket. Tests need it; the runner never does. */
export function destroyPool(): void {
  agent.destroy();
  insecureAgent.destroy();
}
