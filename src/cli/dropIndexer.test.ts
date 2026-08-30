import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexDbPath, openDropIndex, type DropIndex } from "./dropIndex";
import { coverageHours, indexOnce } from "./dropIndexer";

vi.mock("./dropScanner", () => ({
  // Every range yields one drop, named after the range, so a test can see
  // exactly which blocks were read.
  scanPublicDrops: vi.fn(async (_c: unknown, o: { fromBlock: bigint; toBlock: bigint }) => ({
    drops: [
      {
        contract: `0x${o.fromBlock.toString(16).padStart(40, "0")}`,
        priceWei: "0",
        startTime: Math.floor(Date.now() / 1000) + 3600,
        endTime: 0,
        maxPerWallet: 1,
        feeBps: 0,
        block: Number(o.fromBlock),
      },
    ],
    fromBlock: Number(o.fromBlock),
    toBlock: Number(o.toBlock),
    events: 1,
  })),
  enrichDrops: vi.fn(async (_c: unknown, d: unknown[]) => d),
}));

const open = () => openDropIndex(indexDbPath(join(mkdtempSync(join(tmpdir(), "ixr-")), "snipe.config.json")));
let db: DropIndex | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

const client = (head: bigint) => ({ getBlockNumber: async () => head }) as never;
const opts = { keepDays: 30, blocksPerHour: 36_000, stepBlocks: 1_000n };

describe("filling the index", () => {
  it("reads a first step and records where it started", async () => {
    db = open();
    const r = await indexOnce(client(10_000n), db, opts);
    expect(r.head).toBe(10_000n);
    expect(r.keptUp).toEqual({ fromBlock: 9_000n, toBlock: 10_000n, found: 1 });
    expect(r.reachedBack).toBeNull();
    expect(db.get("lastBlock")).toBe("10000");
    expect(db.get("oldestBlock")).toBe("9000");
    expect(r.catchingUp).toBe(true);
  });

  it("walks backwards one step per pass", async () => {
    db = open();
    await indexOnce(client(10_000n), db, opts);
    await indexOnce(client(10_000n), db, opts);
    expect(db.get("oldestBlock")).toBe("8000");
    await indexOnce(client(10_000n), db, opts);
    expect(db.get("oldestBlock")).toBe("7000");
  });

  it("stops walking once the window is covered", async () => {
    // A window of one day at 36,000 blocks/hour is 864,000 blocks, so with a
    // head of 2,000 the floor is 0 and two steps reach it.
    db = open();
    const day = { ...opts, keepDays: 1 };
    await indexOnce(client(2_000n), db, day);
    let r = await indexOnce(client(2_000n), db, day);
    expect(db.get("oldestBlock")).toBe("0");
    expect(r.catchingUp).toBe(false);
    r = await indexOnce(client(2_000n), db, day);
    expect(r.catchingUp).toBe(false);
  });

  it("keeps up with the head before reaching further back", async () => {
    // Missing a drop about to open is worse than a shorter view of history,
    // so forward progress is committed first.
    db = open();
    await indexOnce(client(10_000n), db, opts);
    await indexOnce(client(10_500n), db, opts);
    expect(db.get("lastBlock")).toBe("10500");
  });

  it("does not re-read blocks it already has", async () => {
    const { scanPublicDrops } = await import("./dropScanner");
    db = open();
    await indexOnce(client(10_000n), db, opts);
    vi.mocked(scanPublicDrops).mockClear();
    await indexOnce(client(10_050n), db, opts);
    const ranges = vi.mocked(scanPublicDrops).mock.calls.map((c) => [
      (c[1] as { fromBlock: bigint }).fromBlock,
      (c[1] as { toBlock: bigint }).toBlock,
    ]);
    expect(ranges).toContainEqual([10_001n, 10_050n]);
  });

  it("drops what has aged out of the window", async () => {
    db = open();
    const now = Math.floor(Date.now() / 1000);
    db.put(
      [
        {
          contract: "0x00000000000000000000000000000000000000ff",
          priceWei: "0",
          startTime: now - 40 * 86_400,
          endTime: 0,
          maxPerWallet: 1,
          feeBps: 0,
          block: 1,
        },
      ],
      now,
    );
    const r = await indexOnce(client(10_000n), db, opts);
    expect(r.pruned).toBe(1);
  });
});

describe("saying how far back the index reaches", () => {
  it("knows nothing before the first pass", () => {
    db = open();
    expect(coverageHours(db, 10_000n, 36_000)).toBeNull();
  });

  it("reports the span it has walked", async () => {
    db = open();
    await indexOnce(client(100_000n), db, { ...opts, stepBlocks: 36_000n });
    expect(coverageHours(db, 100_000n, 36_000)).toBeCloseTo(1, 5);
  });
});
