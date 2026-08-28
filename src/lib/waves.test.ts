import { describe, expect, it, vi } from "vitest";
import { parseRpcEndpoints, planWaves, settleOrTimeout } from "./rpcBlast";

const SEQUENCER = "https://sequencer.mainnet.chain.robinhood.com";
const PUBLIC = "https://rpc.mainnet.chain.robinhood.com";
const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/key";

const all = parseRpcEndpoints([SEQUENCER, PUBLIC, ALCHEMY]);
const submit = parseRpcEndpoints([SEQUENCER]);
const labels = (e: { label: string }[]) => e.map((x) => x.label);

describe("splitting a blast into waves", () => {
  it("sends the first wave to the sequencer alone", () => {
    // Ordering on this chain is decided by arrival at the sequencer; the other
    // two endpoints are insurance, and in the head they are only competition
    // for the one thread doing the writing.
    const p = planWaves(300, all, submit, { headSize: 100, maxGapMs: 40 });
    expect(p.head).toBe(100);
    expect(labels(p.headEndpoints)).toEqual(["sequencer"]);
    expect(labels(p.catchUpEndpoints)).toEqual(["rpc.mainnet.chain.robinhood.com", "alchemy"]);
    expect(labels(p.tailEndpoints)).toEqual(labels(all));
  });

  it("still reaches every endpoint, just later for the head", () => {
    const p = planWaves(300, all, submit, { headSize: 100, maxGapMs: 40 });
    expect([...labels(p.headEndpoints), ...labels(p.catchUpEndpoints)].sort()).toEqual(
      labels(all).sort(),
    );
  });

  it("narrows the head to the wallets that exist", () => {
    // 22 wallets and a head of 100 is one wave, not a promise of 100.
    const p = planWaves(22, all, submit, { headSize: 100, maxGapMs: 40 });
    expect(p.head).toBe(22);
  });

  it("helps even when every wallet fits in the head, by going sequencer-first", () => {
    const p = planWaves(22, all, submit, { headSize: 100, maxGapMs: 40 });
    expect(labels(p.headEndpoints)).toEqual(["sequencer"]);
    expect(p.catchUpEndpoints).toHaveLength(2);
  });

  it("falls back to every endpoint when the chain has no send-only node", () => {
    // Nothing to prefer means nothing to catch up on — one wave, as before.
    const p = planWaves(300, all, [], { headSize: 100, maxGapMs: 40 });
    expect(labels(p.headEndpoints)).toEqual(labels(all));
    expect(p.catchUpEndpoints).toEqual([]);
  });

  it("turns the split off entirely at head size 0", () => {
    const p = planWaves(300, all, submit, { headSize: 0, maxGapMs: 40 });
    expect(p.head).toBe(0);
    expect(labels(p.headEndpoints)).toEqual(labels(all));
    expect(p.catchUpEndpoints).toEqual([]);
  });

  it("ignores a submit endpoint the run isn't broadcasting to", () => {
    const other = parseRpcEndpoints(["https://sequencer.example.com"]);
    const p = planWaves(300, all, other, { headSize: 100, maxGapMs: 40 });
    expect(labels(p.headEndpoints)).toEqual(labels(all));
  });
});

describe("the gap between waves", () => {
  it("releases as soon as the head has answered, not when the gap expires", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const head = [Promise.resolve("sent")];
      const gap = settleOrTimeout(head, 40_000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      await gap;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases anyway when an endpoint never answers", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const gap = settleOrTimeout([new Promise(() => {})], 40).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(39);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await gap;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait at all when there is no head to wait for", async () => {
    await expect(settleOrTimeout([], 40_000)).resolves.toBeUndefined();
  });

  it("waits for a rejected send too, rather than throwing the fire path", async () => {
    await expect(settleOrTimeout([Promise.reject(new Error("refused"))], 40_000)).resolves.toBeUndefined();
  });
});
