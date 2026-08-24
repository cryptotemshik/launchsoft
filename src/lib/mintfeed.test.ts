import { describe, expect, it } from "vitest";
import {
  SEADROP_MINT_TOPIC,
  aggregateTrending,
  dataWord,
  decodeMintLog,
  feedStats,
  mergeMints,
  type MintEvent,
  type RawLog,
} from "./mintfeed";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addrTopic = (addr: string) => "0x" + addr.slice(2).padStart(64, "0");

const COLL_A = "0x00000000000000000000000000000000000000a1";
const COLL_B = "0x00000000000000000000000000000000000000b2";
const MINTER_1 = "0x0000000000000000000000000000000000000001";
const MINTER_2 = "0x0000000000000000000000000000000000000002";

function mintLog(over: {
  collection?: string;
  minter?: string;
  quantity?: bigint;
  unitPrice?: bigint;
  ts?: string;
  tx?: string;
  index?: number;
}): RawLog {
  const q = over.quantity ?? 1n;
  const price = over.unitPrice ?? 0n;
  return {
    topics: [
      SEADROP_MINT_TOPIC,
      addrTopic(over.collection ?? COLL_A),
      addrTopic(over.minter ?? MINTER_1),
      addrTopic("0x00000000000000000000000000000000000000fe"),
    ],
    // [payer, quantityMinted, unitMintPrice, feeBps, dropStageIndex]
    data: "0x" + word(0n) + word(q) + word(price) + word(1000n) + word(0n),
    block_timestamp: over.ts ?? "2026-08-19T10:00:00.000000Z",
    transaction_hash: over.tx ?? "0xtx1",
    block_number: 123,
    index: over.index ?? 0,
  };
}

describe("dataWord", () => {
  it("reads the n-th 32-byte word as an unsigned int", () => {
    const data = "0x" + word(11n) + word(22n) + word(33n);
    expect(dataWord(data, 0)).toBe(11n);
    expect(dataWord(data, 1)).toBe(22n);
    expect(dataWord(data, 2)).toBe(33n);
  });
  it("returns 0n past the end / for empty data", () => {
    expect(dataWord("0x", 0)).toBe(0n);
    expect(dataWord(null, 1)).toBe(0n);
  });
});

describe("decodeMintLog", () => {
  it("decodes collection, minter, quantity, and unit price", () => {
    const e = decodeMintLog(
      mintLog({ quantity: 3n, unitPrice: 10_000_000_000_000_000n }),
    );
    expect(e).not.toBeNull();
    expect(e!.collection).toBe(COLL_A);
    expect(e!.minter).toBe(MINTER_1);
    expect(e!.quantity).toBe(3);
    expect(e!.unitPriceWei).toBe(10_000_000_000_000_000n);
    expect(e!.t).toBe(Math.floor(Date.UTC(2026, 7, 19, 10, 0, 0) / 1000));
    expect(e!.id).toBe("0xtx1:0");
  });

  it("ignores logs with a different topic0", () => {
    const bad = mintLog({});
    bad.topics = ["0xdeadbeef", ...(bad.topics!.slice(1))];
    expect(decodeMintLog(bad)).toBeNull();
  });
});

describe("feedStats", () => {
  it("counts NFTs, txns, unique minters, and collections", () => {
    const events = [
      decodeMintLog(mintLog({ collection: COLL_A, minter: MINTER_1, quantity: 2n, index: 0 }))!,
      decodeMintLog(mintLog({ collection: COLL_A, minter: MINTER_2, quantity: 3n, index: 1 }))!,
      decodeMintLog(mintLog({ collection: COLL_B, minter: MINTER_1, quantity: 1n, index: 2 }))!,
    ];
    expect(feedStats(events)).toEqual({
      mints: 3,
      quantity: 6,
      minters: 2,
      collections: 2,
    });
  });
});

describe("aggregateTrending", () => {
  it("ranks by NFTs minted, sums volume, counts unique minters", () => {
    const events = [
      decodeMintLog(mintLog({ collection: COLL_A, minter: MINTER_1, quantity: 2n, unitPrice: 1_000n, index: 0 }))!,
      decodeMintLog(mintLog({ collection: COLL_A, minter: MINTER_2, quantity: 3n, unitPrice: 1_000n, index: 1 }))!,
      decodeMintLog(mintLog({ collection: COLL_B, minter: MINTER_1, quantity: 10n, unitPrice: 0n, index: 2 }))!,
    ];
    const rows = aggregateTrending(events);
    expect(rows[0].collection).toBe(COLL_B); // 10 minted > 5
    expect(rows[0].quantity).toBe(10);
    expect(rows[0].volumeWei).toBe(0n);
    expect(rows[1].collection).toBe(COLL_A);
    expect(rows[1].quantity).toBe(5);
    expect(rows[1].minters).toBe(2);
    expect(rows[1].volumeWei).toBe(5_000n); // (2+3) * 1000
  });
});

describe("mergeMints", () => {
  const mk = (id: string, t: number): MintEvent => ({
    id,
    collection: COLL_A as `0x${string}`,
    minter: MINTER_1 as `0x${string}`,
    quantity: 1,
    unitPriceWei: 0n,
    txHash: "0x",
    block: 1,
    t,
  });
  it("dedupes by id, newest first, capped", () => {
    const merged = mergeMints([mk("a", 1)], [mk("a", 1), mk("b", 2), mk("c", 3)], 2);
    expect(merged.map((e) => e.id)).toEqual(["c", "b"]);
  });
});
