import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blastToAll, parseRpcEndpoints, prepareBlast, warmEndpoints } from "../lib/rpcBlast";
import { destroyPool, nodeSender, pooledSockets } from "./nodeSender";

/**
 * The property under test is the one the whole pre-signing design rests on:
 * at the fire moment there must be no connection setup left to do. Counting
 * the server's `connection` events is the only honest way to check it — a
 * timing assertion would pass on a fast machine and fail on a slow one.
 */
let server: Server;
let url: string;
let connections = 0;
let served = 0;

beforeEach(async () => {
  connections = 0;
  served = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      served += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":"0xdead"}');
    });
  });
  server.on("connection", () => (connections += 1));
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  url = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  destroyPool();
  await new Promise<void>((r) => server.close(() => r()));
});

const raw = (i: number) => ("0x" + (i + 1).toString(16).padStart(64, "0")) as `0x${string}`;

describe("nodeSender", () => {
  it("opens one socket per wallet when warming, not one per endpoint", async () => {
    const endpoints = parseRpcEndpoints([url]);
    await warmEndpoints(endpoints, 8, nodeSender);
    expect(connections).toBe(8);
  });

  it("costs no new connection at fire time — the whole point of warming", async () => {
    const endpoints = parseRpcEndpoints([url]);
    const N = 8;
    await warmEndpoints(endpoints, N, nodeSender);
    const afterWarm = connections;

    const prepared = Array.from({ length: N }, (_, i) => prepareBlast(raw(i)));
    const results = await Promise.all(
      prepared.map((p) => blastToAll(p, endpoints, nodeSender).results),
    );

    expect(connections - afterWarm).toBe(0);
    expect(results.flat().every((r) => r.txHash === "0xdead")).toBe(true);
  });

  it("holds the pool open between warming and firing", async () => {
    const endpoints = parseRpcEndpoints([url]);
    await warmEndpoints(endpoints, 5, nodeSender);
    await new Promise((r) => setTimeout(r, 250));
    expect(pooledSockets()).toBeGreaterThanOrEqual(5);
  });

  it("re-warming an already warm pool opens nothing new", async () => {
    const endpoints = parseRpcEndpoints([url]);
    await warmEndpoints(endpoints, 6, nodeSender);
    const first = connections;
    // What the runner does 3s before the stage opens.
    await warmEndpoints(endpoints, 6, nodeSender);
    expect(connections).toBe(first);
  });

  it("warms every endpoint, not just the first", async () => {
    const second = createServer((_, res) => res.end("{}"));
    let secondConnections = 0;
    second.on("connection", () => (secondConnections += 1));
    await new Promise<void>((r) => second.listen(0, "127.0.0.1", r));
    const addr = second.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");

    await warmEndpoints(parseRpcEndpoints([url, `http://127.0.0.1:${addr.port}`]), 4, nodeSender);
    expect(connections).toBe(4);
    expect(secondConnections).toBe(4);
    second.close();
  });

  it("survives an endpoint that refuses the warm-up, and names it", async () => {
    // Nothing listening on this port: warming must not throw, because one dead
    // endpoint should never stop a run whose other endpoints are fine. It must
    // not stay quiet about it either — a warm that opened half of what it was
    // asked for looks identical to one that worked, and the difference only
    // shows up as handshakes at the moment they cost most.
    const endpoints = parseRpcEndpoints([url, "http://127.0.0.1:9"]);
    const report = await warmEndpoints(endpoints, 3, nodeSender);
    expect(connections).toBe(3);
    expect(report.opened).toBe(3);
    expect(report.failed).toBe(3);
    expect(report.short.map((e) => e.opened)).toEqual([0]);
    expect(report.capped).toBe(false);
  });

  it("reports the whole warm-up when every endpoint answers", async () => {
    const report = await warmEndpoints(parseRpcEndpoints([url]), 5, nodeSender);
    expect(report).toMatchObject({ wanted: 5, opened: 5, failed: 0, capped: false });
    expect(report.short).toEqual([]);
  });

  it("reports a rejection from the endpoint rather than throwing", async () => {
    server.removeAllListeners("request");
    server.on("request", (_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"error":{"message":"nonce too low"}}');
    });
    const endpoints = parseRpcEndpoints([url]);
    const out = await blastToAll(prepareBlast(raw(0)), endpoints, nodeSender).results;
    expect(out[0]).toMatchObject({ txHash: null, error: "nonce too low" });
  });

  it("still returns the locally-computed hash when every endpoint is down", async () => {
    const endpoints = parseRpcEndpoints(["http://127.0.0.1:9"]);
    const prepared = prepareBlast(raw(0));
    const { txHash, results } = blastToAll(prepared, endpoints, nodeSender);
    expect(txHash).toBe(prepared.txHash);
    const out = await results;
    expect(out[0].txHash).toBeNull();
    expect(out[0].error).toBeTruthy();
  });

  it("does not lose requests when firing more wallets than warmed sockets", async () => {
    const endpoints = parseRpcEndpoints([url]);
    await warmEndpoints(endpoints, 2, nodeSender);
    const prepared = Array.from({ length: 10 }, (_, i) => prepareBlast(raw(i)));
    const out = await Promise.all(
      prepared.map((p) => blastToAll(p, endpoints, nodeSender).results),
    );
    expect(out.flat().filter((r) => r.txHash === "0xdead")).toHaveLength(10);
    expect(served).toBeGreaterThanOrEqual(10);
  });
});
