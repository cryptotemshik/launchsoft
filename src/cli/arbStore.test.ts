import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { DatabaseSync } from "./nodeSqlite";
import { ArbStore, type StoredOpportunity } from "./arbStore";

const stores: ArbStore[] = [];
const open = () => {
  const s = new ArbStore(new DatabaseSync(join(mkdtempSync(join(tmpdir(), "arb-")), "arb.sqlite")));
  stores.push(s);
  return s;
};
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const opp = (over: Partial<StoredOpportunity> = {}): StoredOpportunity => ({
  collection: "0xaaa",
  tokenId: "1",
  paidWei: parseEther("0.01"),
  offerNetWei: parseEther("0.02"),
  gasWei: parseEther("0.0000175"),
  profitWei: parseEther("0.0099825"),
  buyBlock: 100,
  sellBlock: 150,
  at: 1_800_000_000,
  ...over,
});

describe("storing observed arbitrage", () => {
  it("keeps wei exactly, not as a float", () => {
    // A float loses the low digits of wei silently, and the stored number is
    // the one anyone would later reconcile against the chain.
    const s = open();
    const odd = 123456789012345678n;
    s.record([opp({ profitWei: odd, paidWei: odd })]);
    const row = s.recent()[0];
    expect(row.profit_wei).toBe(odd.toString());
    expect(row.paid_wei).toBe(odd.toString());
  });

  it("ignores the same opportunity seen twice", () => {
    // Every restart re-reads the last batch of blocks on purpose; that must
    // not double-count the spread.
    const s = open();
    expect(s.record([opp()])).toBe(1);
    expect(s.record([opp()])).toBe(0);
    expect(s.totals(0).trades).toBe(1);
  });

  it("separates two tokens of the same collection in one block", () => {
    const s = open();
    s.record([opp({ tokenId: "1" }), opp({ tokenId: "2" })]);
    expect(s.totals(0).trades).toBe(2);
  });

  it("totals only what falls inside the window", () => {
    const s = open();
    s.record([opp({ at: 1000, tokenId: "1" }), opp({ at: 5000, tokenId: "2" })]);
    expect(s.totals(0).trades).toBe(2);
    expect(s.totals(2000).trades).toBe(1);
  });

  it("rolls up by collection, biggest spread first", () => {
    const s = open();
    s.record([
      opp({ collection: "0xsmall", profitWei: parseEther("0.001") }),
      opp({ collection: "0xbig", profitWei: parseEther("0.05") }),
      opp({ collection: "0xbig", tokenId: "2", profitWei: parseEther("0.02") }),
    ]);
    const rows = s.byCollection(0);
    expect(rows[0].collection).toBe("0xbig");
    expect(rows[0].trades).toBe(2);
    expect(rows[0].profitEth).toBeCloseTo(0.07, 9);
  });

  it("groups by day for the history table", () => {
    const s = open();
    s.record([
      opp({ at: 1_800_000_000, tokenId: "1" }),
      opp({ at: 1_800_000_000 + 86_400, tokenId: "2" }),
    ]);
    const days = s.daily(14);
    expect(days).toHaveLength(2);
    expect(days[0].day > days[1].day).toBe(true);
  });

  it("remembers how far it has read across a reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "arb-")), "arb.sqlite");
    const a = new ArbStore(new DatabaseSync(path));
    a.setState("lastBlock", "47919103");
    a.close();
    const b = new ArbStore(new DatabaseSync(path));
    expect(b.getState("lastBlock")).toBe("47919103");
    expect(b.getState("nothing")).toBeNull();
    b.close();
  });

  it("filters the log by collection", () => {
    const s = open();
    s.record([opp({ collection: "0xaaa" }), opp({ collection: "0xbbb", tokenId: "2" })]);
    expect(s.recent(200, "0xBBB")).toHaveLength(1);
  });
});
