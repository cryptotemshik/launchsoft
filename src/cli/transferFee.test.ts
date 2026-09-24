import { describe, expect, it } from "vitest";
import { parseEther, parseGwei } from "viem";
import { TRANSFER_FEE_FLOOR_WEI, transferFeeCaps } from "./transferFee";
import { NFT_TRANSFER_GAS } from "./nftSweep";

describe("transferFeeCaps", () => {
  it("pays what the chain charges, not the mint cap", () => {
    // Robinhood Chain as it was: 0.043 gwei base, no tip market, a 5 gwei mint cap.
    const base = parseGwei("0.043428");
    const f = transferFeeCaps(base, 0n, "5", "1");
    expect(f.maxFeePerGas).toBe(base * 2n + TRANSFER_FEE_FLOOR_WEI);
    expect(f.maxPriorityFeePerGas).toBe(0n);
    // An NFT transfer now needs well under 0.00002 ETH on hand, not 0.00075.
    expect(NFT_TRANSFER_GAS * f.maxFeePerGas < parseEther("0.00002")).toBe(true);
  });

  it("never offers more than the configured cap", () => {
    const f = transferFeeCaps(parseGwei("4"), parseGwei("2"), "5", "1");
    expect(f.maxFeePerGas).toBe(parseGwei("5"));
    expect(f.maxPriorityFeePerGas).toBe(parseGwei("1"));
  });

  it("keeps the tip within the max fee", () => {
    const f = transferFeeCaps(0n, parseGwei("3"), "0.5", "3");
    expect(f.maxFeePerGas).toBe(parseGwei("0.5"));
    expect(f.maxPriorityFeePerGas).toBe(parseGwei("0.5"));
  });

  it("refuses a cap under the base fee rather than sending what every node rejects", () => {
    expect(() => transferFeeCaps(parseGwei("6"), 0n, "5", "1")).toThrow(/below the current base fee/);
  });

  it("leaves room for a zero base fee", () => {
    expect(transferFeeCaps(0n, 0n, "5", "1").maxFeePerGas).toBe(TRANSFER_FEE_FLOOR_WEI);
  });
});
