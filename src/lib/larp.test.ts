import { describe, expect, it } from "vitest";
import { computeLarpScore, larpChecks, larpReport, riskBand, type LarpInput } from "./larp";

const NOW = 1_800_000_000;
const DAY = 86_400_000;

const input = (over: Partial<LarpInput> = {}): LarpInput => ({
  priceWei: "1000000000000000",
  maxPerWallet: 3,
  feeBps: 500,
  maxSupply: 5000,
  now: NOW,
  ...over,
});

const find = (d: Partial<LarpInput>, id: string) =>
  larpChecks(input(d)).find((c) => c.id === id)!;

describe("computeLarpScore", () => {
  it("averages by weight, not by count", () => {
    const r = computeLarpScore([
      { id: "a", label: "a", status: "ok", detail: "", weight: 3 },
      { id: "b", label: "b", status: "bad", detail: "", weight: 1 },
    ]);
    expect(r.score).toBe(75);
  });

  it("lets an unknown carry no weight, so it never reads as a pass", () => {
    const r = computeLarpScore([
      { id: "a", label: "a", status: "ok", detail: "", weight: 1 },
      { id: "b", label: "b", status: "info", detail: "", weight: 3 },
    ]);
    expect(r.score).toBe(100);
    // …but it does cost confidence, which is how the reader learns the 100
    // was decided on a quarter of the evidence.
    expect(r.confidence).toBeCloseTo(0.25, 5);
  });

  it("returns no score at all when nothing could be graded", () => {
    // Rather than the 50 the original invented: a made-up middle is the one
    // number a reader would trust without asking where it came from.
    const r = computeLarpScore([{ id: "a", label: "a", status: "info", detail: "" }]);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("handles an empty check list", () => {
    expect(computeLarpScore([])).toMatchObject({ score: null, confidence: 0 });
  });
});

describe("the account check", () => {
  it("marks a drop with no account attached", () => {
    expect(find({ twitter: null }, "twitter").status).toBe("bad");
  });

  it("holds off while the follower count is still being read", () => {
    expect(find({ twitter: "someone" }, "twitter").status).toBe("info");
  });

  it("fails a small following on a brand-new account", () => {
    // The live shape of this: three followers on an account opened last week.
    const c = find({ twitter: "new", followers: 3, joinedMs: NOW * 1000 - 8 * DAY }, "twitter");
    expect(c.status).toBe("bad");
    expect(c.detail).toContain("3 followers");
    expect(c.detail).toContain("8d old");
  });

  it("only warns when one half of the pair is fine", () => {
    expect(find({ twitter: "a", followers: 40, joinedMs: NOW * 1000 - 900 * DAY }, "twitter").status)
      .toBe("warn");
    expect(find({ twitter: "a", followers: 90_000, joinedMs: NOW * 1000 - 3 * DAY }, "twitter").status)
      .toBe("warn");
  });

  it("passes an established account", () => {
    expect(find({ twitter: "a", followers: 5_000, joinedMs: NOW * 1000 - 900 * DAY }, "twitter").status)
      .toBe("ok");
  });
});

describe("the floor check", () => {
  it("fails a floor well under the mint price", () => {
    // 0.0002 against a 0.001 mint: the market is already selling it at a loss.
    const c = find(
      { priceWei: "1000000000000000", floorUnit: 0.0002, floorSymbol: "ETH", nativeSymbol: "ETH" },
      "floor",
    );
    expect(c.status).toBe("bad");
    expect(c.detail).toContain("20%");
  });

  it("refuses to compare two different coins by their face numbers", () => {
    // The nonsense this replaced, straight off the live chain: a 0.25 USDG
    // floor against a 0.00001 ETH mint reported as "2,500,000% of the mint".
    const c = find(
      { priceWei: "10000000000000", floorUnit: 0.25, floorSymbol: "USDG", nativeSymbol: "ETH" },
      "floor",
    );
    expect(c.status).toBe("info");
    expect(c.detail).toContain("USDG");
  });

  it("compares different coins through dollars when both sides have one", () => {
    // 0.001 ETH at $2,500 is $2.50 to mint; a $0.25 floor is a tenth of that.
    const c = find(
      {
        priceWei: "1000000000000000",
        floorUnit: 0.25, floorSymbol: "USDG", floorUsd: 0.25,
        nativeSymbol: "ETH", nativeUsd: 2500,
      },
      "floor",
    );
    expect(c.status).toBe("bad");
    expect(c.detail).toContain("$0.25");
    expect(c.detail).toContain("$2.50");
  });

  it("passes a floor at or above the mint price", () => {
    expect(find({ priceWei: "1000000000000000", floorUnit: 0.002 }, "floor").status).toBe("ok");
  });

  it("stays silent on a free mint, where the ratio means nothing", () => {
    expect(find({ priceWei: "0", floorUnit: 0.5 }, "floor").status).toBe("info");
  });

  it("stays silent when nothing is listed", () => {
    expect(find({ floorUnit: null }, "floor").status).toBe("info");
  });
});

describe("the minting checks", () => {
  it("fails one wallet looping", () => {
    const c = find({ uniqueness: 0.05, mintTxs: 200 }, "uniqueness");
    expect(c.status).toBe("bad");
    expect(c.detail).toContain("5% of 200");
  });

  it("passes many wallets", () => {
    expect(find({ uniqueness: 0.92, mintTxs: 120 }, "uniqueness").status).toBe("ok");
  });

  it("says too-few rather than guessing", () => {
    const c = find({ uniqueness: null, mintTxs: 3 }, "uniqueness");
    expect(c.status).toBe("info");
    expect(c.detail).toContain("3 mint txs");
  });

  it("leaves the top-wallet check out below a usable sample", () => {
    expect(larpChecks(input({ top1: 0.9, mintTxs: 2 })).some((c) => c.id === "top1")).toBe(false);
    expect(larpChecks(input({ top1: 0.9, mintTxs: 40 })).some((c) => c.id === "top1")).toBe(true);
  });
});

describe("the art check", () => {
  it("passes content-addressed storage", () => {
    expect(find({ baseURI: "ipfs://bafkreiabc" }, "art").status).toBe("ok");
  });

  it("warns about art served from a host somebody controls", () => {
    const c = find({ baseURI: "https://cdn.example.com/meta/" }, "art");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("cdn.example.com");
  });

  it("fails an unrevealed drop with nothing committed", () => {
    expect(find({ baseURI: "", provenanceHash: "0x" + "0".repeat(64) }, "art").status).toBe("bad");
  });

  it("softens once the art is committed to on-chain", () => {
    expect(find({ baseURI: "", provenanceHash: "0xdead" + "0".repeat(60) }, "art").status).toBe("warn");
  });
});

describe("the stage's terms", () => {
  it("grades the marketplace fee", () => {
    expect(find({ feeBps: 500 }, "fee").status).toBe("ok");
    expect(find({ feeBps: 1500 }, "fee").status).toBe("warn");
    expect(find({ feeBps: 3000 }, "fee").status).toBe("bad");
  });

  it("fails a stage with no per-wallet limit at all", () => {
    const c = find({ maxPerWallet: 0, maxSupply: 5000 }, "cap");
    expect(c.status).toBe("bad");
    expect(c.detail).toContain("no per-wallet limit");
  });

  it("fails a cap that lets one wallet take most of the supply", () => {
    expect(find({ maxPerWallet: 50, maxSupply: 100 }, "cap").status).toBe("bad");
    expect(find({ maxPerWallet: 10, maxSupply: 5000 }, "cap").status).toBe("ok");
  });

  it("skips the cap check when supply is unknown", () => {
    expect(larpChecks(input({ maxSupply: undefined })).some((c) => c.id === "cap")).toBe(false);
  });
});

describe("larpReport", () => {
  it("scores a drop with everything going for it near the top", () => {
    const r = larpReport(
      input({
        twitter: "real", followers: 12_000, joinedMs: NOW * 1000 - 800 * DAY,
        floorUnit: 0.004, floorSymbol: "ETH", nativeSymbol: "ETH", priceWei: "1000000000000000",
        uniqueness: 0.95, mintTxs: 300, top1: 0.04,
        baseURI: "ipfs://bafkrei", feeBps: 500, maxPerWallet: 5, maxSupply: 5000,
      }),
    );
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.confidence).toBe(1);
  });

  it("scores a wash-minted anonymous drop near the bottom", () => {
    const r = larpReport(
      input({
        twitter: null,
        floorUnit: 0.0001, floorSymbol: "ETH", nativeSymbol: "ETH", priceWei: "1000000000000000",
        uniqueness: 0.05, mintTxs: 400, top1: 0.8,
        baseURI: "", provenanceHash: "0x" + "0".repeat(64),
        feeBps: 2500, maxPerWallet: 0, maxSupply: 1000,
      }),
    );
    expect(r.score).toBeLessThanOrEqual(10);
  });

  it("keeps confidence honest when half of it could not be checked", () => {
    const r = larpReport(input({ twitter: "a", floorUnit: null }));
    expect(r.confidence).toBeLessThan(1);
    expect(r.score).not.toBeNull();
  });
});

describe("riskBand", () => {
  it("bands the score for the column's colour", () => {
    expect(riskBand(85)).toBe("ok");
    expect(riskBand(55)).toBe("warn");
    expect(riskBand(12)).toBe("bad");
    expect(riskBand(null)).toBe("unknown");
  });
});
