import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBalancePoint,
  balanceHistoryPath,
  cutProfitSince,
  dashboardTokenOk,
  downsample,
  loadBalanceHistory,
  parseDashboardWallets,
  summariseRuns,
} from "./dashboard";
import type { MintRecord } from "./ledger";

const A = "0x06d8c45f6CFfC08a249Cff1dac52b7d919322dad";
const B = "0x99B94e3E8F6566903b9516D987d28314B9754E1d";
const KEY = "a-dashboard-key-of-enough-length";

describe("dashboardTokenOk", () => {
  it("accepts the key as a bearer and alone", () => {
    expect(dashboardTokenOk(`Bearer ${KEY}`, KEY)).toBe(true);
    expect(dashboardTokenOk(KEY, KEY)).toBe(true);
  });

  it("refuses a wrong or missing key", () => {
    expect(dashboardTokenOk(`Bearer ${KEY}x`, KEY)).toBe(false);
    expect(dashboardTokenOk(undefined, KEY)).toBe(false);
    expect(dashboardTokenOk("Bearer ", KEY)).toBe(false);
  });

  it("is off when the configured key is unset or too short", () => {
    expect(dashboardTokenOk("Bearer ", "")).toBe(false);
    expect(dashboardTokenOk("Bearer short", "short")).toBe(false);
  });
});

describe("parseDashboardWallets", () => {
  it("reads labelled and bare addresses", () => {
    expect(parseDashboardWallets(`Main:${A}, ${B}`)).toEqual([
      { label: "Main", address: A },
      { label: "Wallet 2", address: B },
    ]);
  });

  it("skips junk and repeats", () => {
    expect(parseDashboardWallets(`x:0x123,Main:${A},Again:${A.toLowerCase()},,`)).toEqual([
      { label: "Main", address: A },
    ]);
  });

  it("is empty for nothing", () => {
    expect(parseDashboardWallets(undefined)).toEqual([]);
    expect(parseDashboardWallets("")).toEqual([]);
  });
});

function run(at: number, wallets: MintRecord["wallets"]): MintRecord {
  return { at, collection: A as `0x${string}`, collectionName: "Robinos", chainId: 4663, stage: "public", wallets };
}
const w = (status: string, tokens = 0, gasWei = "10", valueWei = "0") => ({
  address: B,
  tokenIds: Array.from({ length: tokens }, (_, i) => String(i)),
  gasWei,
  valueWei,
  status,
});

describe("summariseRuns", () => {
  it("counts tried, won, tokens and spend per run, newest first", () => {
    const rows = summariseRuns([
      run(1, [w("reverted"), w("reverted")]),
      run(2, [w("mined", 2, "5", "100"), w("reverted", 0, "7"), w("skipped", 0, "0")]),
    ]);
    expect(rows.map((r) => r.at)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ tried: 2, won: 1, tokens: 2, gasWei: "12", valueWei: "100", outcome: "partial" });
    expect(rows[1]).toMatchObject({ tried: 2, won: 0, tokens: 0, outcome: "missed" });
  });

  it("marks a clean sweep as won, and respects the limit", () => {
    const rows = summariseRuns([run(1, [w("mined", 1)]), run(2, [w("mined", 1)]), run(3, [w("mined", 1)])], 2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.outcome === "won")).toBe(true);
  });
});

describe("balance history", () => {
  const cfg = () => join(mkdtempSync(join(tmpdir(), "dash-")), "snipe.config.json");

  it("round-trips samples, oldest first", () => {
    const path = cfg();
    appendBalancePoint(path, { at: 20, walletsWei: "2", mainWei: "3" });
    appendBalancePoint(path, { at: 10, walletsWei: "1", mainWei: "1" });
    expect(loadBalanceHistory(path).map((p) => p.at)).toEqual([10, 20]);
  });

  it("skips lines that won't parse or carry junk", () => {
    const path = cfg();
    writeFileSync(balanceHistoryPath(path), "not json\n");
    appendFileSync(balanceHistoryPath(path), `${JSON.stringify({ at: 1, walletsWei: "x", mainWei: "1" })}\n`);
    appendBalancePoint(path, { at: 5, walletsWei: "9", mainWei: "0" });
    expect(loadBalanceHistory(path)).toEqual([{ at: 5, walletsWei: "9", mainWei: "0" }]);
  });

  it("is empty when nothing was recorded, and appending to a bad path never throws", () => {
    expect(loadBalanceHistory(cfg())).toEqual([]);
    expect(() => appendBalancePoint("/nonexistent/dir/cfg.json", { at: 1, walletsWei: "1", mainWei: "1" })).not.toThrow();
  });
});

describe("downsample", () => {
  it("keeps short series whole", () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("thins long series but keeps both ends", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(xs, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(999);
  });

  it("handles degenerate sizes", () => {
    expect(downsample([1, 2, 3], 0)).toEqual([]);
    expect(downsample([1, 2, 3], 1)).toEqual([3]);
  });
});

describe("cutProfitSince", () => {
  const OLD = "0x1111111111111111111111111111111111111111";
  const NEW = "0x2222222222222222222222222222222222222222";
  const MIXED = "0x3333333333333333333333333333333333333333";
  const T = 1_800_000_000;
  const body = {
    collections: [
      { collection: OLD, heldTokens: 5, netWei: "-100" },
      { collection: NEW, heldTokens: 3, netWei: "-50" },
      { collection: MIXED, heldTokens: 10, netWei: "0" },
    ],
    events: [
      { collection: OLD.toLowerCase(), kind: "mint", at: T - 100, wei: "-100", tokens: 5, wallet: "0xa" },
      { collection: OLD.toLowerCase(), kind: "sale", at: T + 50, wei: "999", tokens: 1 },
      { collection: NEW.toLowerCase(), kind: "mint", at: T + 10, wei: "-30", tokens: 2, wallet: "0xb" },
      { collection: NEW.toLowerCase(), kind: "mint", at: T + 20, wei: "-20", tokens: 2, wallet: "0xc" },
      { collection: NEW.toLowerCase(), kind: "sale", at: T + 30, wei: "70", tokens: 1 },
      { collection: MIXED.toLowerCase(), kind: "mint", at: T - 5, wei: "-10", tokens: 8, wallet: "0xd" },
      { collection: MIXED.toLowerCase(), kind: "mint", at: T + 5, wei: "-10", tokens: 2, wallet: "0xd" },
    ],
  };

  it("leaves the report alone without a line", () => {
    expect(cutProfitSince(body, undefined)).toEqual({ ...body, profitSince: null });
    expect(cutProfitSince({}, undefined)).toEqual({ collections: [], events: [], profitSince: null });
  });

  it("drops collections minted before the line, sales of them included", () => {
    const cut = cutProfitSince(body, T);
    expect(cut.collections.map((c) => c.collection)).toEqual([NEW, MIXED]);
    expect(cut.events.every((e) => e.at >= T)).toBe(true);
    expect(cut.profitSince).toBe(T);
  });

  it("counts spend and revenue after the line, plus the ledger's failed gas", () => {
    const cut = cutProfitSince(body, T, [
      { collection: NEW, failedGasWei: 5n, runs: 2, lastAt: (T + 20) * 1000 },
    ]);
    const n = cut.collections.find((c) => c.collection === NEW)!;
    expect(n.cost).toEqual({ gasWei: "55", priceWei: "0", tokens: 4, wallets: 2 });
    expect(n.revenueWei).toBe("70");
    expect(n.netWei).toBe("15");
    expect(n.soldTokens).toBe(1);
    expect(n.heldTokens).toBe(3); // every mint came after the line: all of it counts
    expect(n.runs).toBe(2);
  });

  it("does not let old inventory back in as held", () => {
    const m = cutProfitSince(body, T).collections.find((c) => c.collection === MIXED)!;
    expect(m.heldTokens).toBe(2); // 10 held, but only 2 were minted after the line
  });
});
