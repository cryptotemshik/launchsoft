import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { gweiToWei, perWalletCost, planFunding, weiToEthString } from "./fundingPlan";

const GAS = { maxFeeGwei: "2", gasLimit: 500_000 };

describe("reading gwei off a text box", () => {
  it("handles whole and fractional gwei", () => {
    expect(gweiToWei("2")).toBe(2_000_000_000n);
    expect(gweiToWei("0.05")).toBe(50_000_000n);
    expect(gweiToWei("1.234567891")).toBe(1_234_567_891n);
  });

  it("refuses to guess at nonsense rather than funding against it", () => {
    expect(gweiToWei("")).toBe(0n);
    expect(gweiToWei("abc")).toBe(0n);
    expect(gweiToWei("-3")).toBe(0n);
  });

  it("does not lose precision past nine places, or round up", () => {
    expect(gweiToWei("1.9999999999")).toBe(1_999_999_999n);
  });
});

describe("what one wallet must hold", () => {
  it("is the mint plus the job's whole gas allowance", () => {
    // 0.01 × 3 = 0.03 ETH of mint, plus 2 gwei × 500k = 0.001 ETH of gas.
    const c = perWalletCost({ priceWei: parseEther("0.01"), quantity: 3, ...GAS });
    expect(c.mintWei).toBe(parseEther("0.03"));
    expect(c.gasWei).toBe(parseEther("0.001"));
    expect(c.totalWei).toBe(parseEther("0.031"));
  });

  it("still needs gas for a free mint", () => {
    // The failure this guards: a free drop looking like it costs nothing, so
    // wallets go in empty and every mint reverts for gas.
    const c = perWalletCost({ priceWei: 0n, quantity: 1, ...GAS });
    expect(c.mintWei).toBe(0n);
    expect(c.totalWei).toBe(parseEther("0.001"));
  });

  it("treats a nonsense quantity as one rather than zero", () => {
    expect(perWalletCost({ priceWei: parseEther("1"), quantity: 0, ...GAS }).mintWei).toBe(
      parseEther("1"),
    );
    expect(perWalletCost({ priceWei: parseEther("1"), quantity: NaN, ...GAS }).mintWei).toBe(
      parseEther("1"),
    );
  });
});

describe("planning a top-up across the job's wallets", () => {
  const cost = { priceWei: parseEther("0.01"), quantity: 1, ...GAS };
  // Each wallet must hold 0.011 ETH.

  it("asks only for the shortfall, wallet by wallet", () => {
    const plan = planFunding(
      [
        { address: "0xa", balanceWei: 0n },
        { address: "0xb", balanceWei: parseEther("0.005") },
        { address: "0xc", balanceWei: parseEther("0.011") },
        { address: "0xd", balanceWei: parseEther("5") },
      ],
      cost,
    );
    expect(plan.perWalletWei).toBe(parseEther("0.011"));
    expect(plan.rows[0].shortfallWei).toBe(parseEther("0.011"));
    expect(plan.rows[1].shortfallWei).toBe(parseEther("0.006"));
    // Exactly at the target needs nothing — not a wei more.
    expect(plan.rows[2].shortfallWei).toBe(0n);
    expect(plan.rows[3].shortfallWei).toBe(0n);
    expect(plan.needy).toBe(2);
    expect(plan.totalWei).toBe(parseEther("0.017"));
  });

  it("counts an unreadable balance as needing everything", () => {
    // Assuming it is fine funds nothing and fails the mint. The server tops up
    // against balances it reads itself, so over-asking here costs only a
    // larger number on screen.
    const plan = planFunding([{ address: "0xa", balanceWei: null }], cost);
    expect(plan.rows[0].shortfallWei).toBe(parseEther("0.011"));
    expect(plan.needy).toBe(1);
  });

  it("reports nothing to do when every wallet is ready", () => {
    const plan = planFunding(
      [
        { address: "0xa", balanceWei: parseEther("1") },
        { address: "0xb", balanceWei: parseEther("2") },
      ],
      cost,
    );
    expect(plan.needy).toBe(0);
    expect(plan.totalWei).toBe(0n);
  });
});

describe("writing wei back out as ETH", () => {
  it("round-trips through parseEther", () => {
    for (const s of ["0", "1", "0.011", "0.000000000000000001", "123.456"]) {
      expect(weiToEthString(parseEther(s as `${number}`))).toBe(s === "0" ? "0" : s);
    }
  });

  it("does not emit exponent notation the endpoint would reject", () => {
    // The endpoint validates against /^\d+(\.\d+)?$/, so "1e-7" is refused.
    expect(weiToEthString(100n)).toBe("0.0000000000000001");
    expect(weiToEthString(parseEther("0.0000001"))).toBe("0.0000001");
  });
});

describe("funding a spread run", () => {
  const base = { priceWei: 4_000_000_000_000_000n, quantity: 1, maxFeeGwei: "0.3", gasLimit: 300_000 };

  it("asks for one reservation when the job sends one shot", () => {
    const one = perWalletCost({ ...base, shots: 1 });
    expect(one.gasWei).toBe(90_000_000_000_000n); // 300000 × 0.3 gwei
    expect(one.totalWei).toBe(base.priceWei + 90_000_000_000_000n);
  });

  it("treats a missing shot count as one, so old jobs are unchanged", () => {
    expect(perWalletCost(base)).toEqual(perWalletCost({ ...base, shots: 1 }));
  });

  it("asks for more gas once the job spreads its shots", () => {
    // The failure this exists to prevent: on Chill Guys every wallet held
    // exactly one reservation, the first shot reverted, and every later shot
    // was refused before it reached a block.
    const many = perWalletCost({ ...base, shots: 17 });
    expect(many.gasWei).toBeGreaterThan(perWalletCost({ ...base, shots: 1 }).gasWei);
    expect(many.mintWei).toBe(base.priceWei);
  });

  it("charges the mint price once however many shots there are", () => {
    // Only one shot can mint; the rest revert and hand the value back.
    expect(perWalletCost({ ...base, shots: 17 }).mintWei).toBe(
      perWalletCost({ ...base, shots: 1 }).mintWei,
    );
  });

  it("counts a wallet funded for one shot as short for a spread", () => {
    const plan = planFunding([{ address: "0xa", balanceWei: 90_000_000_000_000n }], {
      ...base,
      priceWei: 0n,
      shots: 17,
    });
    expect(plan.needy).toBe(1);
    expect(plan.rows[0].shortfallWei).toBeGreaterThan(0n);
  });
});
