import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";
import { isRateLimit, mapWithLimit, readTransport } from "./rpcRead";
import { getChainInfo } from "../chains";

describe("isRateLimit", () => {
  it("recognises the message Robinhood Chain's RPC returns", () => {
    expect(isRateLimit(new Error("Rate Limit Hit, limit will reset in 60 seconds"))).toBe(true);
  });

  it("recognises an HTTP 429 carried on the error object", () => {
    expect(isRateLimit({ message: "request failed", status: 429 })).toBe(true);
  });

  it("recognises a provider's JSON-RPC throttle code", () => {
    expect(isRateLimit({ message: "limit exceeded", code: -32005 })).toBe(true);
  });

  it("looks through a wrapped cause, as viem nests them", () => {
    const inner = new Error("Too Many Requests");
    const outer = new Error("HTTP request failed", { cause: inner });
    expect(isRateLimit(outer)).toBe(true);
  });

  it("does not treat an ordinary revert as a rate limit", () => {
    expect(isRateLimit(new Error("execution reverted: stage not open"))).toBe(false);
  });

  it("survives null and odd shapes", () => {
    expect(isRateLimit(null)).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
    expect(isRateLimit(42)).toBe(false);
  });
});

describe("mapWithLimit", () => {
  it("keeps results in input order", async () => {
    const out = await mapWithLimit([1, 2, 3, 4, 5], async (n) => n * 2, { limit: 2 });
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("never runs more than the limit at once", async () => {
    let live = 0;
    let peak = 0;
    await mapWithLimit(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1));
        live -= 1;
      },
      { limit: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("retries a rate-limited call and backs off further each time", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const out = await mapWithLimit(
      ["a"],
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Rate Limit Hit, limit will reset in 60 seconds");
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms), backoffMs: 100 },
    );
    expect(out).toEqual(["ok"]);
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("gives up once the retries are spent", async () => {
    await expect(
      mapWithLimit(["a"], async () => {
        throw new Error("Rate Limit Hit");
      }, { retries: 2, sleep: async () => {} }),
    ).rejects.toThrow(/rate limit/i);
  });

  it("does not retry an error that isn't about rate", async () => {
    const fn = vi.fn(async () => {
      throw new Error("insufficient funds");
    });
    await expect(mapWithLimit(["a"], fn, { sleep: async () => {} })).rejects.toThrow(
      "insufficient funds",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports each wait so a long pause doesn't look like a hang", async () => {
    const seen: number[] = [];
    let first = true;
    await mapWithLimit(
      ["a"],
      async () => {
        if (first) {
          first = false;
          throw new Error("429 Too Many Requests");
        }
        return 1;
      },
      { sleep: async () => {}, backoffMs: 50, onRetry: (ms) => seen.push(ms) },
    );
    expect(seen).toEqual([50]);
  });

  it("handles an empty list without spawning workers", async () => {
    expect(await mapWithLimit([], async () => 1)).toEqual([]);
  });
});


/**
 * The case this exists for: arming a hundred wallets against a provider that
 * meters per second. Alchemy's free tier allows 25 requests a second, and a
 * hundred unbatched nonce reads fired together simply lose — two minutes
 * before a drop opens, with nobody watching.
 */
describe("reading a hundred wallets through a metered endpoint", () => {
  let server: Server;
  let url: string;
  let windowStart = 0;
  let usedThisSecond = 0;
  let requests = 0;
  let refusals = 0;

  const LIMIT_PER_SECOND = 25;

  beforeEach(async () => {
    windowStart = Date.now();
    usedThisSecond = 0;
    requests = 0;
    refusals = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests += 1;
        const calls = ([] as unknown[]).concat(JSON.parse(body) as unknown);
        if (Date.now() - windowStart >= 1000) {
          windowStart = Date.now();
          usedThisSecond = 0;
        }
        if (usedThisSecond + calls.length > LIMIT_PER_SECOND) {
          refusals += 1;
          res.writeHead(429, { "content-type": "application/json" });
          res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"Too Many Requests"}}');
          return;
        }
        usedThisSecond += calls.length;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            calls.map((c) => ({ jsonrpc: "2.0", id: (c as { id: number }).id, result: "0x5" })),
          ),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const chain = getChainInfo(4663)!.chain;
  const wallets = Array.from(
    { length: 100 },
    (_, i) => ("0x" + (i + 1).toString(16).padStart(40, "0")) as `0x${string}`,
  );

  it("gets every nonce despite the limit, by batching and backing off", async () => {
    const client = createPublicClient({ chain, transport: readTransport(url) });
    const nonces = await mapWithLimit(wallets, (a) =>
      client.getTransactionCount({ address: a, blockTag: "pending" }),
    );

    expect(nonces).toHaveLength(100);
    expect(nonces.every((n) => n === 5)).toBe(true);
    // Batched: a hundred calls must not cost a hundred requests.
    expect(requests).toBeLessThan(40);
    // And the endpoint really did push back — otherwise this proves nothing.
    expect(refusals).toBeGreaterThan(0);
  }, 30_000);

  it("shows why: unbatched and unthrottled, the same read loses wallets", async () => {
    const naive = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
    const settled = await Promise.allSettled(
      wallets.map((a) => naive.getTransactionCount({ address: a, blockTag: "pending" })),
    );
    const got = settled.filter((r) => r.status === "fulfilled").length;

    expect(requests).toBe(100);
    expect(refusals).toBeGreaterThan(0);
    expect(got).toBeLessThan(100);
  }, 30_000);
});
