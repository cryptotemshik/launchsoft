import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBalancePoint,
  balanceHistoryPath,
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
