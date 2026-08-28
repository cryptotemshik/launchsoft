import { describe, expect, it } from "vitest";
import { stageMove, type StageTerms } from "./runner";

const armed: StageTerms = { price: 0n, perWallet: 20, startTime: 1_787_932_080, endTime: 1_787_935_680 };
const at = armed.startTime - 60;

describe("what a re-read of the stage means for a run that already armed", () => {
  it("leaves an unchanged stage alone", () => {
    expect(stageMove(armed, { ...armed }, 20, at)).toEqual({
      retime: false,
      closed: false,
      resign: false,
      quantity: 20,
    });
  });

  it("demands a re-sign when the creator raises the price", () => {
    // The drop we lost: armed at price 0, the creator set 0.0002 ETH sixteen
    // seconds later, and twenty value-0 transactions reverted on arrival.
    const move = stageMove(armed, { ...armed, price: 200_000_000_000_000n }, 20, at);
    expect(move.resign).toBe(true);
    expect(move.quantity).toBe(20);
  });

  it("demands a re-sign when the per-wallet cap moves, because the call asks for a count", () => {
    expect(stageMove(armed, { ...armed, perWallet: 5 }, 20, at).resign).toBe(true);
  });

  it("clamps a requested quantity to the new cap", () => {
    expect(stageMove(armed, { ...armed, perWallet: 5 }, 20, at).quantity).toBe(5);
  });

  it("takes the new cap whole when the run asked for max", () => {
    expect(stageMove(armed, { ...armed, perWallet: 50 }, "max", at).quantity).toBe(50);
  });

  it("reports nothing mintable when the cap drops to zero", () => {
    expect(stageMove(armed, { ...armed, perWallet: 0 }, "max", at).quantity).toBe(0);
  });

  it("keeps the asked-for quantity when the stage declares no cap at all", () => {
    // A cap of 0 means "unstated" on some stages, and clamping to it would
    // silently turn a real order into a no-op.
    expect(stageMove(armed, { ...armed, perWallet: 0 }, 3, at).quantity).toBe(3);
  });

  it("asks for a re-time when the start moves", () => {
    expect(stageMove(armed, { ...armed, startTime: armed.startTime + 600 }, 20, at).retime).toBe(true);
  });

  it("calls the stage closed once its end is behind us", () => {
    expect(stageMove(armed, armed, 20, armed.endTime + 1).closed).toBe(true);
  });

  it("does not call an open-ended stage closed", () => {
    // endTime 0 is SeaDrop's "no end", not a stage that expired in 1970.
    expect(stageMove(armed, { ...armed, endTime: 0 }, 20, at).closed).toBe(false);
  });
});
