import { describe, expect, it } from "vitest";
import { FUNDED_MIN_ETH, isFunded, pickRandom } from "./walletSelection";

describe("what counts as funded", () => {
  it("rejects dust that would never pay for gas", () => {
    // The old rule was "more than zero", and sweep leftovers pass that while
    // minting nothing.
    expect(isFunded("0.00001")).toBe(false);
    expect(isFunded("0")).toBe(false);
  });

  it("accepts a balance at the floor and above", () => {
    expect(isFunded(String(FUNDED_MIN_ETH))).toBe(true);
    expect(isFunded("0.05")).toBe(true);
  });

  it("treats an unread balance as not funded rather than assuming", () => {
    expect(isFunded(null)).toBe(false);
    expect(isFunded(undefined)).toBe(false);
    expect(isFunded("not a number")).toBe(false);
  });
});

describe("drawing a random subset", () => {
  const pool = Array.from({ length: 50 }, (_, i) => i);

  it("draws the count asked for, with no repeats", () => {
    const got = pickRandom(pool, 20);
    expect(got).toHaveLength(20);
    expect(new Set(got).size).toBe(20);
  });

  it("never draws more than the pool holds", () => {
    expect(pickRandom(pool, 999)).toHaveLength(50);
    expect(pickRandom([], 5)).toEqual([]);
    expect(pickRandom(pool, 0)).toEqual([]);
    expect(pickRandom(pool, -3)).toEqual([]);
  });

  it("leaves the pool alone", () => {
    const before = [...pool];
    pickRandom(pool, 25);
    expect(pool).toEqual(before);
  });

  it("reaches both ends of the pool, not just the front", () => {
    // A biased shuffle looks fine until you notice it favours one end. Over
    // many draws every index should turn up.
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) for (const n of pickRandom(pool, 5)) seen.add(n);
    expect(seen.size).toBe(pool.length);
  });
});
