import { describe, expect, it } from "vitest";
import { costByCollection, type MintRecord } from "./ledger";

const COLL = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const GWEI = 1_000_000_000n;

const record = (over: Partial<MintRecord> = {}): MintRecord => ({
  at: 1_000,
  collection: COLL,
  collectionName: "Test Drop",
  chainId: 4663,
  stage: "public",
  wallets: [
    { address: "0xa", tokenIds: ["1", "2"], gasWei: String(100n * GWEI), valueWei: "0", status: "mined" },
  ],
  ...over,
});

describe("costByCollection", () => {
  it("sums gas and mint price across wallets", () => {
    const out = costByCollection([
      record({
        wallets: [
          { address: "0xa", tokenIds: ["1"], gasWei: String(100n * GWEI), valueWei: String(5n * GWEI), status: "mined" },
          { address: "0xb", tokenIds: ["2"], gasWei: String(200n * GWEI), valueWei: String(5n * GWEI), status: "mined" },
        ],
      }),
    ]);
    const c = out.get(COLL.toLowerCase())!;
    expect(c.gasWei).toBe(300n * GWEI);
    expect(c.priceWei).toBe(10n * GWEI);
    expect(c.tokens).toBe(2);
    expect(c.wallets).toBe(2);
  });

  it("counts gas from a reverted wallet — it was still spent", () => {
    const out = costByCollection([
      record({
        wallets: [
          { address: "0xa", tokenIds: [], gasWei: String(80n * GWEI), valueWei: "0", status: "reverted" },
        ],
      }),
    ]);
    const c = out.get(COLL.toLowerCase())!;
    expect(c.gasWei).toBe(80n * GWEI);
    expect(c.tokens).toBe(0);
  });

  it("adds up several runs of the same collection", () => {
    const out = costByCollection([record({ at: 100 }), record({ at: 200 })]);
    const c = out.get(COLL.toLowerCase())!;
    expect(c.runs).toBe(2);
    expect(c.tokens).toBe(4);
    expect(c.firstAt).toBe(100);
    expect(c.lastAt).toBe(200);
  });

  it("keeps collections apart", () => {
    const out = costByCollection([record(), record({ collection: OTHER, collectionName: "Other" })]);
    expect(out.size).toBe(2);
    expect(out.get(OTHER.toLowerCase())!.collectionName).toBe("Other");
  });

  it("matches a collection whatever case it was written in", () => {
    const out = costByCollection([
      record(),
      record({ collection: COLL.toUpperCase().replace("0X", "0x") as `0x${string}` }),
    ]);
    expect(out.size).toBe(1);
    expect(out.get(COLL.toLowerCase())!.runs).toBe(2);
  });

  it("survives a record with missing amounts", () => {
    const out = costByCollection([
      record({
        wallets: [{ address: "0xa", tokenIds: [], gasWei: "", valueWei: "", status: "timeout" }],
      }),
    ]);
    expect(out.get(COLL.toLowerCase())!.gasWei).toBe(0n);
  });

  it("is empty for an empty ledger", () => {
    expect(costByCollection([]).size).toBe(0);
  });
});
