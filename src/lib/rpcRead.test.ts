import { describe, expect, it, vi } from "vitest";
import { isRateLimit, mapWithLimit } from "./rpcRead";

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
