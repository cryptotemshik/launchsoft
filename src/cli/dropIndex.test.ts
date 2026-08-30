import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexDbPath, openDropIndex, type DropIndex } from "./dropIndex";
import type { ScannedDrop } from "../lib/dropScan";

const open = () => openDropIndex(indexDbPath(join(mkdtempSync(join(tmpdir(), "idx-")), "snipe.config.json")));
let db: DropIndex | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

const drop = (over: Partial<ScannedDrop> = {}): ScannedDrop => ({
  contract: "0x0000000000000000000000000000000000000001",
  name: "One",
  priceWei: "0",
  startTime: 1_000_000,
  endTime: 1_100_000,
  maxPerWallet: 5,
  maxSupply: 1000,
  minted: 10,
  feeBps: 500,
  block: 42,
  ...over,
});

describe("keeping drops on disk", () => {
  it("has nothing before anything is written", () => {
    db = open();
    expect(db.count()).toBe(0);
    expect(db.sinceBlock(0)).toEqual([]);
  });

  it("keeps what it was given", () => {
    db = open();
    db.put([drop()], 99);
    const [back] = db.sinceBlock(0);
    expect(back.contract).toBe("0x0000000000000000000000000000000000000001");
    expect(back.priceWei).toBe("0");
    expect(back.maxSupply).toBe(1000);
    expect(back.seenAt).toBe(99);
  });

  it("keeps a price exactly, however large", () => {
    // Wei does not fit a double, so the column is text and stays text.
    db = open();
    db.put([drop({ priceWei: "123456789012345678901234567890" })], 1);
    expect(db.sinceBlock(0)[0].priceWei).toBe("123456789012345678901234567890");
  });

  it("refreshes a collection rather than duplicating it", () => {
    // The same contract is seen again whenever the creator edits the stage.
    db = open();
    db.put([drop({ priceWei: "0", minted: 10 })], 1);
    db.put([drop({ priceWei: "5000", minted: 900, block: 77 })], 2);
    expect(db.count()).toBe(1);
    const [back] = db.sinceBlock(0);
    expect(back.priceWei).toBe("5000");
    expect(back.minted).toBe(900);
    expect(back.block).toBe(77);
    expect(back.seenAt).toBe(2);
  });

  it("returns soonest first", () => {
    db = open();
    db.put(
      [
        drop({ contract: "0x0000000000000000000000000000000000000003", startTime: 3000 }),
        drop({ contract: "0x0000000000000000000000000000000000000001", startTime: 1000 }),
        drop({ contract: "0x0000000000000000000000000000000000000002", startTime: 2000 }),
      ],
      1,
    );
    expect(db.sinceBlock(0).map((d) => d.startTime)).toEqual([1000, 2000, 3000]);
  });

  it("selects by the block a stage was configured in, not by when it opens", () => {
    // A scan window means "collections someone touched in the last N hours".
    // A drop configured today for next month belongs in today's scan.
    db = open();
    db.put(
      [
        drop({ contract: "0x0000000000000000000000000000000000000001", block: 100, startTime: 9_000_000 }),
        drop({ contract: "0x0000000000000000000000000000000000000002", block: 900, startTime: 1000 }),
      ],
      1,
    );
    expect(db.sinceBlock(500).map((d) => d.block)).toEqual([900]);
    expect(db.sinceBlock(0).map((d) => d.block)).toEqual([900, 100]);
  });

  it("keeps a missing name and supply missing rather than inventing zero", () => {
    // A drop found before enrichment has neither, and a zero supply would read
    // as a sold-out collection.
    db = open();
    db.put([drop({ name: undefined, maxSupply: undefined, minted: undefined, owner: undefined })], 1);
    const [back] = db.sinceBlock(0);
    expect(back.name).toBeUndefined();
    expect(back.maxSupply).toBeUndefined();
    expect(back.minted).toBeUndefined();
    expect(back.owner).toBeUndefined();
  });

  it("forgets what has aged out of the window", () => {
    db = open();
    db.put(
      [
        drop({ contract: "0x0000000000000000000000000000000000000001", startTime: 1000 }),
        drop({ contract: "0x0000000000000000000000000000000000000002", startTime: 9000 }),
      ],
      1,
    );
    expect(db.prune(5000)).toBe(1);
    expect(db.sinceBlock(0).map((d) => d.startTime)).toEqual([9000]);
  });

  it("remembers where the reader got to, across reopening", () => {
    const path = indexDbPath(join(mkdtempSync(join(tmpdir(), "idx-")), "snipe.config.json"));
    const first = openDropIndex(path);
    first.set("lastBlock", "12345");
    first.put([drop()], 1);
    first.close();

    db = openDropIndex(path);
    expect(db.get("lastBlock")).toBe("12345");
    expect(db.count()).toBe(1);
    expect(db.get("nothing")).toBeUndefined();
  });

  it("writes a batch all at once or not at all", () => {
    db = open();
    const bad = [drop(), { ...drop({ contract: "0x02" }), priceWei: null as unknown as string }];
    expect(() => db!.put(bad, 1)).toThrow();
    expect(db.count()).toBe(0);
  });
});
