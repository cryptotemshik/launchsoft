import { describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { expectedTries, normalizePattern, randomWallet, startWalk, stepWalk } from "./vanity";

const addr = (k: `0x${string}`) => privateKeyToAddress(k).toLowerCase();

describe("vanity", () => {
  it("normalises and rejects patterns", () => {
    expect(normalizePattern(" 0xDEad ")).toBe("dead");
    expect(normalizePattern("")).toBe("");
    expect(() => normalizePattern("xyz")).toThrow(/only 0-9 and a-f/);
    expect(expectedTries("ab", "c")).toBe(4096);
  });

  it("a random wallet's key really owns its address", () => {
    for (let i = 0; i < 5; i++) {
      const w = randomWallet();
      expect(w.key).toMatch(/^0x[0-9a-f]{64}$/);
      expect(addr(w.key)).toBe(w.address);
    }
  });

  it("every match's key owns an address with the asked-for ends", () => {
    let found = 0;
    let walk = startWalk();
    while (found < 4) {
      const r = stepWalk(walk, "a", "b", 64);
      if (!r.found) continue;
      expect(r.found.address.startsWith("0xa")).toBe(true);
      expect(r.found.address.endsWith("b")).toBe(true);
      expect(addr(r.found.key)).toBe(r.found.address);
      found += 1;
      walk = startWalk();
    }
  });

  it("keeps the walk's key and point in step across batches", () => {
    const walk = startWalk(1000n);
    stepWalk(walk, "00000000", "", 3);
    stepWalk(walk, "00000000", "", 4);
    expect(walk.k).toBe(1007n);
    expect(walk.P.equals(startWalk(1007n).P)).toBe(true);
  });

  it("restarts rather than walk through the group order", () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const walk = startWalk(n - 5n);
    expect(() => stepWalk(walk, "00000000", "", 16)).not.toThrow();
    expect(walk.k < n).toBe(true);
    expect(walk.P.equals(startWalk(walk.k).P)).toBe(true);
  });
});
