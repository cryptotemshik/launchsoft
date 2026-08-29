import { describe, expect, it } from "vitest";
import {
  BURNED_SHOT_GAS,
  spreadLabel,
  DEFAULT_SHOTS,
  DEFAULT_STEP_MS,
  gasNeededWei,
  planFor,
  shotTimes,
  spreadPlan,
} from "./spread";

describe("laying shots around the start of a stage", () => {
  it("puts one shot exactly on the start with the default five", () => {
    expect(spreadPlan(5, 150).offsets).toEqual([-300, -150, 0, 150, 300]);
  });

  it("centres three the same way", () => {
    expect(spreadPlan(3, 200).offsets).toEqual([-200, 0, 200]);
  });

  it("leans late on an even count", () => {
    // A shot before the start can only revert; a shot after it can mint. So
    // two shots are the start and one step past, never one step early.
    expect(spreadPlan(2, 200).offsets).toEqual([0, 200]);
    expect(spreadPlan(4, 100).offsets).toEqual([-100, 0, 100, 200]);
  });

  it("is the old single burst at one shot", () => {
    expect(spreadPlan(1, 150).offsets).toEqual([0]);
  });

  it("refuses to plan fewer than one shot", () => {
    expect(spreadPlan(0, 150).shots).toBe(1);
    expect(spreadPlan(-3, 150).offsets).toEqual([0]);
  });

  it("treats a zero step as every shot at once", () => {
    expect(spreadPlan(3, 0).offsets).toEqual([0, 0, 0]);
  });
});

describe("choosing a plan from the style", () => {
  it("ignores shots and step entirely for a single burst", () => {
    expect(planFor("single", 5, 150)).toEqual({ shots: 1, offsets: [0] });
  });

  it("uses them for a spread", () => {
    expect(planFor("spread", DEFAULT_SHOTS, DEFAULT_STEP_MS).offsets).toEqual([
      -300, -150, 0, 150, 300,
    ]);
  });
});

describe("what a wallet has to hold", () => {
  const gasLimit = 350_000n;
  const maxFee = 400_000_000n; // 0.4 gwei

  it("asks for one full reservation on a single shot", () => {
    expect(gasNeededWei(1, gasLimit, maxFee)).toBe(gasLimit * maxFee);
  });

  it("adds only what a burned shot actually costs, not another reservation", () => {
    // Five full reservations would be 0.0007 ETH a wallet and would refuse
    // wallets that can mint perfectly well; the reverted shots give back
    // everything except the gas they burned.
    const five = gasNeededWei(5, gasLimit, maxFee);
    expect(five).toBe(gasLimit * maxFee + 4n * BURNED_SHOT_GAS * maxFee);
    expect(five).toBeLessThan(5n * gasLimit * maxFee);
  });

  it("covers the worst revert measured on this chain", () => {
    // NotActive burned 25,046 gas; exceeding max supply burned 38,191.
    expect(BURNED_SHOT_GAS).toBeGreaterThan(38_191n);
  });
});

describe("turning offsets into moments", () => {
  it("hangs them off the start time", () => {
    expect(shotTimes(spreadPlan(3, 150), 1_000_000)).toEqual([999_850, 1_000_000, 1_000_150]);
  });

  it("keeps a shot whose moment has already passed", () => {
    // A run armed late should still send everything it signed, in order,
    // rather than silently dropping the transactions it was too slow for.
    const times = shotTimes(spreadPlan(3, 150), 500);
    expect(times).toEqual([350, 500, 650]);
  });
});

describe("saying the schedule out loud", () => {
  it("signs the offsets so early and late are unmistakable", () => {
    expect(spreadLabel(5, 150)).toBe("-300, -150, 0, +150, +300 ms");
  });

  it("reads sensibly for a single shot", () => {
    expect(spreadLabel(1, 150)).toBe("0 ms");
  });
});
