import { describe, expect, it } from "vitest";
import {
  applyFilter,
  mergeScans,
  blocksForHours,
  classify,
  isSoldOut,
  latestPerContract,
  sortForScan,
  type ScannedDrop,
} from "./dropScan";

const NOW = 1_800_000_000;
const HOUR = 3600;

const drop = (over: Partial<ScannedDrop> = {}): ScannedDrop => ({
  contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  priceWei: "0",
  startTime: NOW + HOUR,
  endTime: NOW + 2 * HOUR,
  maxPerWallet: 3,
  feeBps: 500,
  block: 100,
  ...over,
});

describe("classify", () => {
  it("calls a stage live between its start and end", () => {
    expect(classify({ startTime: NOW - 60, endTime: NOW + 60 }, NOW)).toBe("live");
  });

  it("treats a missing end as open-ended rather than over", () => {
    expect(classify({ startTime: NOW - 60, endTime: 0 }, NOW)).toBe("live");
  });

  it("separates the next day from the rest of the future", () => {
    expect(classify({ startTime: NOW + 3 * HOUR, endTime: 0 }, NOW)).toBe("soon");
    expect(classify({ startTime: NOW + 40 * HOUR, endTime: 0 }, NOW)).toBe("upcoming");
  });

  it("calls a stage with no start pending, not upcoming", () => {
    // A configured-but-unscheduled stage is a real state on this contract, and
    // showing it as "upcoming" would imply a date nobody has set.
    expect(classify({ startTime: 0, endTime: 0 }, NOW)).toBe("pending");
  });

  it("calls a finished window ended", () => {
    expect(classify({ startTime: NOW - 2 * HOUR, endTime: NOW - HOUR }, NOW)).toBe("ended");
  });
});

describe("isSoldOut", () => {
  it("is true only when the count is known and has reached the cap", () => {
    expect(isSoldOut({ maxSupply: 100, minted: 100 })).toBe(true);
    expect(isSoldOut({ maxSupply: 100, minted: 99 })).toBe(false);
  });

  it("is false while supply is unknown — an unread drop is not a sold-out one", () => {
    expect(isSoldOut({})).toBe(false);
    expect(isSoldOut({ maxSupply: 100 })).toBe(false);
    expect(isSoldOut({ minted: 100 })).toBe(false);
  });
});

describe("latestPerContract", () => {
  it("keeps the newest configuration when a creator edits a stage", () => {
    const out = latestPerContract([
      drop({ block: 10, priceWei: "1000" }),
      drop({ block: 30, priceWei: "3000" }),
      drop({ block: 20, priceWei: "2000" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].priceWei).toBe("3000");
  });

  it("keys on the address case-insensitively", () => {
    const out = latestPerContract([
      drop({ contract: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", block: 1 }),
      drop({ contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", block: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].block).toBe(2);
  });

  it("keeps distinct collections apart", () => {
    const out = latestPerContract([
      drop({ contract: "0x1111111111111111111111111111111111111111" }),
      drop({ contract: "0x2222222222222222222222222222222222222222" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("sortForScan", () => {
  it("puts live first, then what starts soonest, and ended last", () => {
    const rows = sortForScan(
      [
        drop({ contract: "0x4", startTime: NOW - 5 * HOUR, endTime: NOW - HOUR }),
        drop({ contract: "0x3", startTime: NOW + 40 * HOUR, endTime: 0 }),
        drop({ contract: "0x1", startTime: NOW - 60, endTime: NOW + 60 }),
        drop({ contract: "0x2", startTime: NOW + 2 * HOUR, endTime: 0 }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.contract)).toEqual(["0x1", "0x2", "0x3", "0x4"]);
  });

  it("orders finished drops by most recently configured", () => {
    const rows = sortForScan(
      [
        drop({ contract: "0xold", startTime: NOW - 99 * HOUR, endTime: NOW - 98 * HOUR, block: 5 }),
        drop({ contract: "0xnew", startTime: NOW - 99 * HOUR, endTime: NOW - 98 * HOUR, block: 50 }),
      ],
      NOW,
    );
    expect(rows[0].contract).toBe("0xnew");
  });
});

describe("blocksForHours", () => {
  it("converts by the measured rate", () => {
    expect(blocksForHours(24, 35_651)).toBe(855_624n);
    expect(blocksForHours(1, 35_651)).toBe(35_651n);
  });

  it("never asks for a zero-block range", () => {
    expect(blocksForHours(0, 35_651)).toBe(1n);
  });
});

describe("applyFilter", () => {
  const rows = [
    drop({ contract: "0x1", name: "Free Live", priceWei: "0", startTime: NOW - 60, endTime: NOW + 60, maxSupply: 1000, minted: 10 }),
    drop({ contract: "0x2", name: "Paid Soon", priceWei: "5000000000000000", startTime: NOW + 2 * HOUR, endTime: 0, maxSupply: 500, minted: 0 }),
    drop({ contract: "0x3", name: "Gone", priceWei: "0", startTime: NOW + 3 * HOUR, endTime: 0, maxSupply: 100, minted: 100 }),
  ];

  it("filters by state", () => {
    expect(applyFilter(rows, { state: "live" }, NOW).map((r) => r.contract)).toEqual(["0x1"]);
  });

  it("hides sold-out drops whose start is still in the future", () => {
    // The row this exists for: the chain says "starts in 3 hours" about a
    // collection that has nothing left.
    expect(applyFilter(rows, { hideSoldOut: true }, NOW).map((r) => r.contract)).toEqual(["0x1", "0x2"]);
  });

  it("filters free-only and by maximum price", () => {
    expect(applyFilter(rows, { freeOnly: true }, NOW)).toHaveLength(2);
    expect(applyFilter(rows, { maxPriceWei: 1_000_000_000_000_000n }, NOW)).toHaveLength(2);
    expect(applyFilter(rows, { maxPriceWei: 5_000_000_000_000_000n }, NOW)).toHaveLength(3);
  });

  it("filters by minimum supply, counting unknown supply as too small", () => {
    expect(applyFilter(rows, { minSupply: 600 }, NOW).map((r) => r.contract)).toEqual(["0x1"]);
    expect(applyFilter([drop({ maxSupply: undefined })], { minSupply: 1 }, NOW)).toHaveLength(0);
  });

  it("searches name and address alike", () => {
    expect(applyFilter(rows, { search: "paid" }, NOW).map((r) => r.contract)).toEqual(["0x2"]);
    expect(applyFilter(rows, { search: "0x3" }, NOW).map((r) => r.contract)).toEqual(["0x3"]);
  });

  it("combines filters", () => {
    const out = applyFilter(rows, { freeOnly: true, hideSoldOut: true }, NOW);
    expect(out.map((r) => r.contract)).toEqual(["0x1"]);
  });
});

describe("mergeScans", () => {
  it("adds collections the earlier scan had never seen", () => {
    const { drops, fresh } = mergeScans(
      [drop({ contract: "0x1", block: 100 })],
      [drop({ contract: "0x2", block: 110 })],
      0,
    );
    expect(drops.map((d) => d.contract).sort()).toEqual(["0x1", "0x2"]);
    expect(fresh).toEqual(["0x2"]);
  });

  it("replaces a stage that has been reconfigured since", () => {
    const { drops, fresh } = mergeScans(
      [drop({ contract: "0x1", block: 100, priceWei: "1000" })],
      [drop({ contract: "0x1", block: 200, priceWei: "9000" })],
      0,
    );
    expect(drops).toHaveLength(1);
    expect(drops[0].priceWei).toBe("9000");
    expect(fresh).toEqual(["0x1"]);
  });

  it("ignores an older configuration arriving late", () => {
    const { drops, fresh } = mergeScans(
      [drop({ contract: "0x1", block: 200, priceWei: "9000" })],
      [drop({ contract: "0x1", block: 100, priceWei: "1000" })],
      0,
    );
    expect(drops[0].priceWei).toBe("9000");
    expect(fresh).toEqual([]);
  });

  it("keeps what enrichment already learned about a reconfigured collection", () => {
    // The name doesn't change when a price does, and re-reading it on every
    // refresh would undo the point of merging.
    const { drops } = mergeScans(
      [drop({ contract: "0x1", block: 100, name: "Known", maxSupply: 500, minted: 12 })],
      [drop({ contract: "0x1", block: 200, priceWei: "77" })],
      0,
    );
    expect(drops[0]).toMatchObject({ name: "Known", maxSupply: 500, priceWei: "77" });
  });

  it("drops rows that have slid out of the window", () => {
    // A window measured backwards from now moves; without this, a 24h scan
    // refreshed for a week would still be showing last Tuesday.
    const { drops } = mergeScans(
      [drop({ contract: "0xold", block: 10 }), drop({ contract: "0xin", block: 500 })],
      [],
      100,
    );
    expect(drops.map((d) => d.contract)).toEqual(["0xin"]);
  });

  it("reports nothing fresh when the slice was empty", () => {
    const { drops, fresh } = mergeScans([drop({ contract: "0x1", block: 100 })], [], 0);
    expect(drops).toHaveLength(1);
    expect(fresh).toEqual([]);
  });
});

describe("applyFilter — the combinable bounds", () => {
  const rows = [
    drop({ contract: "0xsmall", maxSupply: 100, maxPerWallet: 1, priceWei: "0" }),
    drop({ contract: "0xmid", maxSupply: 5_000, maxPerWallet: 10, priceWei: "1000" }),
    drop({ contract: "0xhuge", maxSupply: 100_000, maxPerWallet: 0, priceWei: "9000" }),
  ];

  it("bounds supply from both ends", () => {
    expect(applyFilter(rows, { minSupply: 1_000, maxSupply: 10_000 }, NOW).map((r) => r.contract))
      .toEqual(["0xmid"]);
  });

  it("treats an unset supply cap as unbounded above, not as zero", () => {
    expect(applyFilter([drop({ maxSupply: undefined })], { maxSupply: 10 }, NOW)).toHaveLength(0);
  });

  it("counts a zero per-wallet cap as unlimited, so it passes any minimum", () => {
    // SeaDrop writes 0 for "as many as you like". Read literally it would be
    // the strictest limit on the chain instead of the loosest.
    expect(applyFilter(rows, { minPerWallet: 5 }, NOW).map((r) => r.contract)).toEqual([
      "0xmid",
      "0xhuge",
    ]);
    expect(applyFilter(rows, { maxPerWallet: 10 }, NOW).map((r) => r.contract)).toEqual([
      "0xsmall",
      "0xmid",
    ]);
  });

  it("stacks price, supply and per-wallet together", () => {
    const out = applyFilter(
      rows,
      { maxPriceWei: 5_000n, minSupply: 1_000, minPerWallet: 2 },
      NOW,
    );
    expect(out.map((r) => r.contract)).toEqual(["0xmid"]);
  });
});
