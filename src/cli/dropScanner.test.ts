import { afterEach, describe, expect, it, vi } from "vitest";
import { scanPublicDrops } from "./dropScanner";

/** A client that records the ranges asked for and answers however told to. */
function fakeClient(answer: (from: bigint, to: bigint, call: number) => unknown) {
  const asked: { from: bigint; to: bigint }[] = [];
  let n = 0;
  return {
    asked,
    client: {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        asked.push({ from: fromBlock, to: toBlock });
        const r = answer(fromBlock, toBlock, n++);
        if (r instanceof Error) throw r;
        return r as unknown[];
      },
    } as never,
  };
}

const span = (a: { from: bigint; to: bigint }) => Number(a.to - a.from);

afterEach(() => vi.useRealTimers());

describe("reading the log range", () => {
  it("takes one request when the endpoint is happy", async () => {
    const { client, asked } = fakeClient(() => []);
    await scanPublicDrops(client, { fromBlock: 0n, toBlock: 900_000n });
    expect(asked).toEqual([{ from: 0n, to: 900_000n }]);
  });

  it("halves a range the endpoint calls too wide", async () => {
    const { client, asked } = fakeClient((from, to) =>
      to - from > 100_000n ? new Error("query returned more than 10000 results, block range too large") : [],
    );
    await scanPublicDrops(client, { fromBlock: 0n, toBlock: 400_000n });
    // 400k refused, each 200k half refused, then four ~100k reads succeed —
    // and the halves cover the original range with no block read twice.
    expect(asked.filter((a) => span(a) <= 100_000).length).toBe(4);
    const leaves = asked.filter((a) => span(a) <= 100_000).sort((a, b) => Number(a.from - b.from));
    expect(leaves[0].from).toBe(0n);
    expect(leaves[leaves.length - 1].to).toBe(400_000n);
    leaves.slice(1).forEach((l, i) => expect(l.from).toBe(leaves[i].to + 1n));
  });

  it("reads the halves one after the other, not both at once", async () => {
    // The whole point: a wide range is refused when the endpoint is already
    // under load, and answering that by doubling the requests in flight is how
    // a scan turns into a burst.
    let inFlight = 0;
    let peak = 0;
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        if (toBlock - fromBlock > 50_000n) throw new Error("block range is too large");
        return [];
      },
    } as never;
    await scanPublicDrops(client, { fromBlock: 0n, toBlock: 400_000n });
    expect(peak).toBe(1);
  });

  it("waits out a rate limit instead of splitting it", async () => {
    // Splitting a throttled range is the failure this exists to prevent: each
    // half is throttled too, and four levels down one refusal has become
    // sixteen requests against an endpoint that asked for fewer.
    vi.useFakeTimers();
    const { client, asked } = fakeClient((_f, _t, call) =>
      call < 3 ? new Error("rate limit (HTTP 429) from rpc.example.com") : [],
    );
    const run = scanPublicDrops(client, { fromBlock: 0n, toBlock: 900_000n });
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(asked).toHaveLength(4);
    // Same range every time — never divided.
    expect(new Set(asked.map(span))).toEqual(new Set([900_000]));
  });

  it("gives up on a range that stays throttled rather than retrying forever", async () => {
    vi.useFakeTimers();
    const { client, asked } = fakeClient(() => new Error("rate limit (HTTP 429) from rpc.example.com"));
    const run = scanPublicDrops(client, { fromBlock: 0n, toBlock: 900_000n });
    const settled = expect(run).rejects.toThrow(/rate limit/);
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
    expect(asked.length).toBeLessThanOrEqual(5);
  });

  it("passes an error it cannot answer straight up", async () => {
    const { client, asked } = fakeClient(() => new Error("method not supported"));
    await expect(
      scanPublicDrops(client, { fromBlock: 0n, toBlock: 900_000n }),
    ).rejects.toThrow(/method not supported/);
    expect(asked).toHaveLength(1);
  });

  it("stops splitting once the range is small enough to be the real problem", async () => {
    const { client, asked } = fakeClient(() => new Error("block range is too large"));
    await expect(scanPublicDrops(client, { fromBlock: 0n, toBlock: 20_000n })).rejects.toThrow();
    // 20k → 10k → 5k, and 5k is the floor.
    expect(Math.min(...asked.map(span))).toBeGreaterThanOrEqual(4_999);
  });
});
