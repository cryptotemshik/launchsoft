import { describe, expect, it } from "vitest";
import { waitUntil } from "./snipeTimer";

describe("waitUntil", () => {
  it("resolves fired once the target instant passes", async () => {
    const start = Date.now();
    const outcome = await waitUntil(start + 60);
    expect(outcome).toBe("fired");
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  it("returns fired immediately for a target already in the past", async () => {
    const outcome = await waitUntil(Date.now() - 1000);
    expect(outcome).toBe("fired");
  });

  it("aborts promptly when the signal fires before the target", async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 20);
    const outcome = await waitUntil(start + 5000, { signal: controller.signal });
    expect(outcome).toBe("aborted");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("aborts immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await waitUntil(Date.now() + 5000, { signal: controller.signal });
    expect(outcome).toBe("aborted");
  });

  it("fires onApproach once, before the target", async () => {
    let calls = 0;
    const start = Date.now();
    // Target inside the approach window, so it should fire on the first pass.
    await waitUntil(start + 120, { onApproach: () => calls++ });
    expect(calls).toBe(1);
  });

  it("does not call onApproach when aborted early", async () => {
    const controller = new AbortController();
    let calls = 0;
    controller.abort();
    await waitUntil(Date.now() + 5000, { signal: controller.signal, onApproach: () => calls++ });
    expect(calls).toBe(0);
  });

  it("calls onTick with a decreasing countdown", async () => {
    const ticks: number[] = [];
    await waitUntil(Date.now() + 80, { onTick: (ms) => ticks.push(ms) });
    expect(ticks.length).toBeGreaterThan(0);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeLessThanOrEqual(ticks[i - 1]);
    }
  });
});
