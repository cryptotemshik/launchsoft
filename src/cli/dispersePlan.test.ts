import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { dispersePlan } from "./funding";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

const held = (m: Record<string, string>) =>
  new Map(Object.entries(m).map(([k, v]) => [k.toLowerCase(), parseEther(v as `${number}`)]));

describe("deciding how much each wallet gets", () => {
  it("tops each one up by its own shortfall, not a flat amount", () => {
    // The whole point: these three carry different leftovers from the last
    // drop, and one figure would be wrong for all of them.
    const plan = dispersePlan([A, B, C], held({ [A]: "0", [B]: "0.004", [C]: "0.011" }), {
      amountWei: 0n,
      topUpToWei: parseEther("0.011"),
    });
    expect(plan).toEqual([
      { to: A, value: parseEther("0.011") },
      { to: B, value: parseEther("0.007") },
      // C is exactly there and must be left alone, not sent a dust payment.
    ]);
  });

  it("leaves out a wallet already above the target", () => {
    const plan = dispersePlan([A], held({ [A]: "5" }), {
      amountWei: 0n,
      topUpToWei: parseEther("0.011"),
    });
    expect(plan).toEqual([]);
  });

  it("treats a wallet with no known balance as empty, not as funded", () => {
    // Erring the other way funds nothing and fails the mint.
    const plan = dispersePlan([A], new Map(), { amountWei: 0n, topUpToWei: parseEther("0.011") });
    expect(plan).toEqual([{ to: A, value: parseEther("0.011") }]);
  });

  it("still sends a flat amount when no top-up level is given", () => {
    const plan = dispersePlan([A, B], held({ [A]: "0", [B]: "9" }), {
      amountWei: parseEther("0.02"),
    });
    expect(plan).toEqual([
      { to: A, value: parseEther("0.02") },
      { to: B, value: parseEther("0.02") },
    ]);
  });

  it("honours skipIfAtLeast in the flat-amount mode", () => {
    const plan = dispersePlan([A, B], held({ [A]: "0", [B]: "9" }), {
      amountWei: parseEther("0.02"),
      skipIfAtLeastWei: parseEther("1"),
    });
    expect(plan).toEqual([{ to: A, value: parseEther("0.02") }]);
  });

  it("matches balances case-insensitively", () => {
    // Addresses arrive checksummed from one place and lower-cased from
    // another; missing the match would re-fund a wallet that is already full.
    const plan = dispersePlan([A.toUpperCase().replace("0X", "0x") as typeof A], held({ [A]: "5" }), {
      amountWei: 0n,
      topUpToWei: parseEther("0.011"),
    });
    expect(plan).toEqual([]);
  });
});
