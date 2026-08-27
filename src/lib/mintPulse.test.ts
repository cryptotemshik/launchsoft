import { describe, expect, it } from "vitest";
import {
  concentration,
  cumulativeFromSpark,
  sparkline,
  trendScore,
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
  it("judges the wallet spread over the whole sample, whatever the rate says", () => {
    // The case that caught this: a collection that took ten thousand mints
    // earlier in the hour and has since gone quiet. Ask for the last five
    // minutes and its rate is rightly zero — but the evidence about who was
    // minting is the most useful thing known about it, and it survives.
    const done = Array.from({ length: 40 }, (_, i) =>
      ev({ minter: `0x${String(i).padStart(40, "c")}`, t: NOW - 2400 - i }),
    );
    expect(pulseOf(done, NOW, { spanSec: 300 })).toMatchObject({ perMin: 0, uniqueness: 1 });
    // Over the hour it happened in, it is not quiet — that is the same data
    // answering a different question, which is why the window is a choice.
    expect(pulseOf(done, NOW, { spanSec: 3600 }).perMin).toBeGreaterThan(0);
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

describe("sparkline", () => {
  it("buckets by time, oldest first", () => {
    const spark = sparkline(
      [ev({ t: NOW - 10, quantity: 7 }), ev({ t: NOW - 3500, quantity: 4 })],
      NOW,
      30,
      120,
    );
    expect(spark).toHaveLength(30);
    expect(spark[29]).toBe(7);
    expect(spark[0]).toBe(4);
    expect(spark.reduce((a, b) => a + b, 0)).toBe(11);
  });

  it("leaves out what falls outside the span entirely", () => {
    expect(sparkline([ev({ t: NOW - 99_999 }), ev({ t: NOW + 60 })], NOW).every((v) => v === 0))
      .toBe(true);
  });
});

describe("trendScore", () => {
  it("is zero for a collection nobody is minting", () => {
    expect(trendScore({ perMin: 0, uniqueness: 1, lastT: NOW }, NOW)).toBe(0);
  });

  it("discounts a fast drop coming out of one wallet", () => {
    const many = trendScore({ perMin: 100, uniqueness: 1, lastT: NOW }, NOW);
    const one = trendScore({ perMin: 100, uniqueness: 0, lastT: NOW }, NOW);
    expect(one).toBeCloseTo(many / 2, 5);
  });

  it("treats an unmeasured wallet spread as neither clean nor washed", () => {
    const unknown = trendScore({ perMin: 100, uniqueness: null, lastT: NOW }, NOW);
    expect(unknown).toBeGreaterThan(trendScore({ perMin: 100, uniqueness: 0, lastT: NOW }, NOW));
    expect(unknown).toBeLessThan(trendScore({ perMin: 100, uniqueness: 1, lastT: NOW }, NOW));
  });

  it("decays as a drop goes quiet", () => {
    const now = trendScore({ perMin: 50, uniqueness: 1, lastT: NOW }, NOW);
    const stale = trendScore({ perMin: 50, uniqueness: 1, lastT: NOW - 1200 }, NOW);
    expect(stale).toBeLessThan(now / 5);
  });
});

describe("cumulativeFromSpark", () => {
  it("accumulates the buckets", () => {
    expect(cumulativeFromSpark([2, 0, 3, 5])).toEqual([2, 2, 5, 10]);
  });

  it("stays flat through a quiet stretch after a wall", () => {
    // The shape worth being able to see: everything in one bucket, nothing after.
    expect(cumulativeFromSpark([100, 0, 0, 0])).toEqual([100, 100, 100, 100]);
  });

  it("handles an empty sample", () => {
    expect(cumulativeFromSpark([])).toEqual([]);
  });
});

describe("the chosen window", () => {
  it("measures the rate over the span asked for, not a fixed one", () => {
    // Five mints in the last five minutes is one a minute over five minutes
    // and a third of that over fifteen. Both are true; only one answers
    // "what is happening right now".
    const recent = Array.from({ length: 5 }, (_, i) => ev({ t: NOW - i * 60, quantity: 1 }));
    expect(pulseOf(recent, NOW, { spanSec: 300 }).perMin).toBeCloseTo(1, 5);
    expect(pulseOf(recent, NOW, { spanSec: 900 }).perMin).toBeCloseTo(1 / 3, 5);
  });

  it("keeps the sparkline the same width whatever the span", () => {
    // Thirty bars of two minutes for an hour, thirty of ten seconds for five
    // minutes — the shape stays comparable across windows.
    for (const spanSec of [300, 900, 3600, 86_400]) {
      expect(pulseOf(spread(20), NOW, { spanSec }).spark).toHaveLength(30);
    }
  });

  it("puts a mint in the right bucket for a short window", () => {
    const p = pulseOf([ev({ t: NOW - 5, quantity: 3 })], NOW, { spanSec: 300 });
    expect(p.spark[29]).toBe(3);
    expect(p.spark.slice(0, 29).every((v) => v === 0)).toBe(true);
  });

  it("carries the window through to every collection", () => {
    const out = pulseByCollection(spread(5), NOW, { spanSec: 300 });
    expect(out[C].perMin).toBeCloseTo(1, 5);
  });
});
