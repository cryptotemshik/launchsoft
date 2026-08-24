import { describe, expect, it } from "vitest";
import {
  computeMintRevenue,
  computeProfit,
  formatEthShort,
  formatUsdApprox,
  sumSeaportPayouts,
  type InternalTxItem,
} from "./profit";

const ETH = 10n ** 18n;

describe("computeMintRevenue", () => {
  it("sums quantity × price and splits OpenSea's feeBps out", () => {
    // 3 mints @ 0.1 ETH and 2 mints @ 0.05 ETH, 10% fee
    const r = computeMintRevenue([
      { quantity: 3n, unitPrice: ETH / 10n, feeBps: 1000n },
      { quantity: 2n, unitPrice: ETH / 20n, feeBps: 1000n },
    ]);
    expect(r.gross).toBe((3n * ETH) / 10n + (2n * ETH) / 20n); // 0.4 ETH
    expect(r.openSeaFee).toBe(r.gross / 10n); // 10%
    expect(r.creator).toBe(r.gross - r.openSeaFee);
    expect(r.mintedViaSeaDrop).toBe(5n);
  });

  it("handles free mints and empty history", () => {
    expect(computeMintRevenue([]).gross).toBe(0n);
    const free = computeMintRevenue([{ quantity: 10n, unitPrice: 0n, feeBps: 1000n }]);
    expect(free.creator).toBe(0n);
    expect(free.mintedViaSeaDrop).toBe(10n);
  });

  it("respects per-mint feeBps (fee can change between mints)", () => {
    const r = computeMintRevenue([
      { quantity: 1n, unitPrice: ETH, feeBps: 1000n }, // 0.1 fee
      { quantity: 1n, unitPrice: ETH, feeBps: 500n }, // 0.05 fee
    ]);
    expect(r.openSeaFee).toBe((ETH * 1000n) / 10_000n + (ETH * 500n) / 10_000n);
  });
});

describe("sumSeaportPayouts", () => {
  const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
  const ME = "0xAAAA027A9B2802E1ddf7000061001e5c005ABBBB";
  const items: InternalTxItem[] = [
    { value: "1000", from: { hash: SEAPORT }, to: { hash: ME } },
    { value: "500", from: { hash: SEAPORT.toLowerCase() }, to: { hash: ME.toLowerCase() } },
    { value: "9999", from: { hash: "0x1234000000000000000000000000000000000000" }, to: { hash: ME } }, // not Seaport
    { value: "777", from: { hash: SEAPORT }, to: { hash: "0xdead000000000000000000000000000000000000" } }, // not me
    { value: "0", from: { hash: SEAPORT }, to: { hash: ME } }, // zero-value
    { value: "42", from: { hash: SEAPORT }, to: null }, // contract creation edge
  ];

  it("sums only Seaport → receiver transfers, case-insensitively", () => {
    expect(sumSeaportPayouts(items, SEAPORT, ME)).toBe(1500n);
  });
});

describe("computeProfit", () => {
  const mint = computeMintRevenue([{ quantity: 4n, unitPrice: ETH / 4n, feeBps: 1000n }]); // creator 0.9

  it("adds royalties and subtracts launch cost", () => {
    const b = computeProfit({
      mint,
      royalties: ETH / 10n,
      royaltiesTruncated: false,
      launchCost: ETH / 100n,
      launchCostComplete: true,
    });
    expect(b.profit).toBe(mint.creator + ETH / 10n - ETH / 100n);
    expect(b.profit > 0n).toBe(true);
  });

  it("goes negative when costs exceed income", () => {
    const b = computeProfit({
      mint: computeMintRevenue([]),
      royalties: 0n,
      royaltiesTruncated: false,
      launchCost: ETH / 100n,
      launchCostComplete: true,
    });
    expect(b.profit).toBe(-(ETH / 100n));
  });
});

describe("formatEthShort", () => {
  it("formats", () => {
    expect(formatEthShort(0n)).toBe("0");
    expect(formatEthShort(ETH)).toBe("1");
    expect(formatEthShort(ETH / 2n)).toBe("0.5");
    expect(formatEthShort((3n * ETH) / 1000n)).toBe("0.003");
    expect(formatEthShort(-(ETH / 4n))).toBe("-0.25");
    expect(formatEthShort(12n * ETH + ETH / 2n)).toBe("12.5");
    // Truncated to maxDecimals, trailing zeros stripped
    expect(formatEthShort(123456789n * 10n ** 9n)).toBe("0.123456");
    // Tiny amounts extend to 9 decimals instead of showing "0"
    expect(formatEthShort(2n * 10n ** 13n)).toBe("0.00002");
    expect(formatEthShort(5n * 10n ** 12n, 4)).toBe("0.000005");
  });
});

describe("formatUsdApprox", () => {
  it("returns null without a price and formats with one", () => {
    expect(formatUsdApprox(ETH, null)).toBeNull();
    expect(formatUsdApprox(ETH, 2000)).toBe("≈ $2000");
    expect(formatUsdApprox(ETH / 100n, 2000)).toBe("≈ $20.00");
    expect(formatUsdApprox(-(ETH / 100n), 2000)).toBe("≈ -$20.00");
  });
});
