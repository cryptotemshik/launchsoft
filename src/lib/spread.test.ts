import { describe, expect, it } from "vitest";
import {
  BURNED_SHOT_GAS,
  DEFAULT_AFTER,
  DEFAULT_BEFORE,
  DEFAULT_STEP_MS,
  gasNeededWei,
  planFor,
  shotTimes,
  spreadLabel,
  spreadPlan,
} from "./spread";

describe("laying a stream across the start of a stage", () => {
  it("covers both sides of the boundary at the defaults", () => {
    // A block here is 100-200ms under load, so 100ms steps put a transaction
    // in every block from four before the boundary to four after.
    const p = spreadPlan(DEFAULT_BEFORE, DEFAULT_AFTER, DEFAULT_STEP_MS);
    expect(p.shots).toBe(17);
    expect(p.offsets[0]).toBe(-800);
    expect(p.offsets[p.offsets.length - 1]).toBe(800);
    expect(p.offsets).toContain(0);
  });

  it("puts the shots a step apart, in order", () => {
    expect(spreadPlan(2, 2, 100).offsets).toEqual([-200, -100, 0, 100, 200]);
  });

  it("can lean entirely early", () => {
    // Every shot before the boundary: they revert unless the sequencer's
    // clock is ahead, which is exactly the bet a very early stream makes.
    expect(spreadPlan(3, 0, 100).offsets).toEqual([-300, -200, -100, 0]);
  });

  it("can lean entirely late", () => {
    expect(spreadPlan(0, 3, 100).offsets).toEqual([0, 100, 200, 300]);
  });

  it("is a single shot at the start when both sides are zero", () => {
    expect(spreadPlan(0, 0, 100).offsets).toEqual([0]);
  });

  it("treats negative counts as none", () => {
    expect(spreadPlan(-4, -4, 100).offsets).toEqual([0]);
  });

  it("has no negative zero in it", () => {
    // Harmless in arithmetic, confusing in a log line.
    expect(Object.is(spreadPlan(2, 2, 0).offsets[0], -0)).toBe(false);
  });
});

describe("choosing a plan from the style", () => {
  it("ignores the spread entirely for a single burst", () => {
    expect(planFor("single", 8, 8, 100)).toEqual({ shots: 1, offsets: [0] });
  });

  it("uses it for a spread", () => {
    expect(planFor("spread", 2, 1, 100).offsets).toEqual([-200, -100, 0, 100]);
  });
});

describe("what a wallet has to hold", () => {
  const gasLimit = 350_000n;
  const maxFee = 400_000_000n; // 0.4 gwei

  it("asks for one full reservation on a single shot", () => {
    expect(gasNeededWei(1, gasLimit, maxFee)).toBe(gasLimit * maxFee);
  });

  it("adds only what a burned shot costs, not another reservation", () => {
    // Seventeen full reservations would be 0.0024 ETH a wallet and would
    // refuse wallets that can mint perfectly well; a reverted shot gives back
    // everything except the gas it burned.
    const many = gasNeededWei(17, gasLimit, maxFee);
    expect(many).toBe(gasLimit * maxFee + 16n * BURNED_SHOT_GAS * maxFee);
    // Under a fifth of what naive per-shot reservations would demand.
    expect(many * 5n).toBeLessThan(17n * gasLimit * maxFee);
  });

  it("covers the worst revert measured on this chain", () => {
    // NotActive burned 25,046 gas; exceeding max supply burned 38,191.
    expect(BURNED_SHOT_GAS).toBeGreaterThan(38_191n);
  });
});

describe("turning offsets into moments", () => {
  it("hangs them off the start time", () => {
    expect(shotTimes(spreadPlan(1, 1, 150), 1_000_000)).toEqual([999_850, 1_000_000, 1_000_150]);
  });

  it("keeps a shot whose moment has already passed", () => {
    // A run armed late should still send everything it signed, in order,
    // rather than silently dropping what it was too slow for.
    expect(shotTimes(spreadPlan(1, 1, 150), 500)).toEqual([350, 500, 650]);
  });
});

describe("saying the schedule out loud", () => {
  it("names the window, the count and the step", () => {
    expect(spreadLabel(8, 8, 100)).toBe("-800 … +800 ms · 17 shots every 100ms");
  });

  it("says plainly when there is only one shot", () => {
    expect(spreadLabel(0, 0, 100)).toBe("one shot at the start");
  });
});
