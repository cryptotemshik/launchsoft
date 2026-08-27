import { describe, expect, it } from "vitest";
import {
  concentration,
  mintCurve,
  mintsPerMinute,
  pulseByCollection,
  pulseOf,
  uniqueness,
  type MintEvent,
} from "./mintPulse";

const NOW = 1_800_000_000;
const C = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

const ev = (over: Partial<MintEvent> = {}): MintEvent => ({
  collection: C,
  minter: "0x1111111111111111111111111111111111111111",
  quantity: 1,
  t: NOW - 60,
  ...over,
});

/** n mints from n different wallets, one a minute back from `now`. */
const spread = (n: number, now = NOW): MintEvent[] =>
  Array.from({ length: n }, (_, i) =>
    ev({ minter: `0x${String(i).padStart(40, "b")}`, t: now - i * 60 }),
  );

describe("mintsPerMinute", () => {
  it("counts NFTs, not transactions", () => {
    // A ten-item mint is ten NFTs leaving the supply, whatever the tx count.
    const rate = mintsPerMinute([ev({ quantity: 10 }), ev({ quantity: 5 })], NOW, 900);
    expect(rate).toBeCloseTo(1, 5);
  });

  it("ignores what fell out of the window", () => {
    expect(mintsPerMinute([ev({ t: NOW - 5000 })], NOW, 900)).toBe(0);
  });
});

describe("uniqueness", () => {
  it("is near 1 when every mint came from a different wallet", () => {
    expect(uniqueness(spread(20), NOW)).toBe(1);
  });

  it("collapses toward 0 as one wallet loops", () => {
    const looped = Array.from({ length: 20 }, (_, i) => ev({ t: NOW - i }));
    expect(uniqueness(looped, NOW)).toBeCloseTo(0.05, 5);
  });

  it("says nothing at all below the sample floor", () => {
    // The fix over the module this came from, which returned 1 here — a drop
    // with three mints was being reported as perfectly clean.
    expect(uniqueness([], NOW)).toBeNull();
    expect(uniqueness(spread(3), NOW)).toBeNull();
    expect(uniqueness(spread(5), NOW)).not.toBeNull();
  });
});

describe("concentration", () => {
  it("measures what the biggest wallets took", () => {
    const c = concentration([
      ev({ minter: "0xwhale", quantity: 60 }),
      ev({ minter: "0xb", quantity: 20 }),
      ev({ minter: "0xc", quantity: 20 }),
    ]);
    expect(c.top1).toBeCloseTo(0.6, 5);
    expect(c.top5).toBeCloseTo(1, 5);
    expect(c.wallets).toBe(3);
    expect(c.quantity).toBe(100);
  });

  it("keys wallets case-insensitively", () => {
    const c = concentration([ev({ minter: "0xAB" }), ev({ minter: "0xab" })]);
    expect(c.wallets).toBe(1);
    expect(c.rows[0].txs).toBe(2);
  });

  it("finds the busiest minute's share", () => {
    const c = concentration([
      ev({ t: 600, quantity: 80 }),
      ev({ t: 640, quantity: 10 }),
      ev({ t: 9000, quantity: 10 }),
    ]);
    // 90 of 100 landed in the minute starting at 600.
    expect(c.burst).toBeCloseTo(0.9, 5);
  });

  it("survives a sample far larger than an argument list", () => {
    // The crash this replaced: the original spread every per-minute bucket
    // into Math.max, and a long history is tens of thousands of them.
    const many = Array.from({ length: 200_000 }, (_, i) => ev({ t: i * 60 }));
    expect(() => concentration(many)).not.toThrow();
    expect(concentration(many).quantity).toBe(200_000);
  });

  it("reports zeroes rather than dividing by nothing", () => {
    expect(concentration([])).toMatchObject({ top1: 0, top5: 0, burst: 0, quantity: 0 });
  });
});

describe("pulseOf", () => {
  it("judges the wallet spread over the whole sample, not just the live minutes", () => {
    // The case that caught this: a collection that took ten thousand mints
    // earlier in the hour and has since gone quiet. Its rate is rightly zero;
    // its uniqueness is the most useful thing known about it.
    const done = Array.from({ length: 40 }, (_, i) =>
      ev({ minter: `0x${String(i).padStart(40, "c")}`, t: NOW - 2400 - i }),
    );
    const p = pulseOf(done, NOW);
    expect(p.perMin).toBe(0);
    expect(p.uniqueness).toBe(1);
  });

  it("puts the rate and the wallet spread side by side", () => {
    const p = pulseOf(spread(15), NOW);
    expect(p.txs).toBe(15);
    expect(p.uniqueness).toBe(1);
    expect(p.lastT).toBe(NOW);
    expect(p.perMin).toBeGreaterThan(0);
  });

  it("reports a quiet collection as quiet, not as suspicious", () => {
    const p = pulseOf([], NOW);
    expect(p).toMatchObject({ perMin: 0, uniqueness: null, txs: 0, lastT: 0 });
  });
});

describe("pulseByCollection", () => {
  it("splits a flat batch of mints into one pulse each", () => {
    const other = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
    const out = pulseByCollection(
      [...spread(6), ...spread(9).map((e) => ({ ...e, collection: other }))],
      NOW,
    );
    expect(Object.keys(out).sort()).toEqual([C, other].sort());
    expect(out[C].txs).toBe(6);
    expect(out[other].txs).toBe(9);
  });

  it("keys on the address in lower case, as every other lookup here does", () => {
    const out = pulseByCollection([ev({ collection: "0xAAAA" as never })], NOW);
    expect(out["0xaaaa"]).toBeDefined();
  });
});

describe("mintCurve", () => {
  it("accumulates in time order however the events arrived", () => {
    const curve = mintCurve([
      ev({ t: 300, quantity: 5 }),
      ev({ t: 100, quantity: 2 }),
      ev({ t: 200, quantity: 3 }),
    ]);
    expect(curve).toEqual([
      { t: 100, cum: 2 },
      { t: 200, cum: 5 },
      { t: 300, cum: 10 },
    ]);
  });

  it("collapses mints sharing a second into one point", () => {
    expect(mintCurve([ev({ t: 100, quantity: 2 }), ev({ t: 100, quantity: 3 })])).toEqual([
      { t: 100, cum: 5 },
    ]);
  });

  it("thins a long curve but keeps both ends", () => {
    const curve = mintCurve(
      Array.from({ length: 1000 }, (_, i) => ev({ t: i + 1, quantity: 1 })),
      50,
    );
    expect(curve).toHaveLength(50);
    expect(curve[0]).toEqual({ t: 1, cum: 1 });
    expect(curve[49]).toEqual({ t: 1000, cum: 1000 });
  });

  it("drops events with no timestamp rather than pinning them to 1970", () => {
    expect(mintCurve([ev({ t: 0 }), ev({ t: 500 })])).toEqual([{ t: 500, cum: 1 }]);
  });
});
