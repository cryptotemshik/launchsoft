import { afterEach, describe, expect, it } from "vitest";
import { recheckCadence, recheckDelayMs } from "./runner";

const ENV_KEYS = [
  "SNIPE_RECHECK_MS",
  "SNIPE_RECHECK_NEAR_MS",
  "SNIPE_RECHECK_NEAR_WINDOW_MS",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("recheckCadence", () => {
  it("defaults to a slow far cadence, a fast near one, and a one-minute window", () => {
    expect(recheckCadence()).toEqual({ farMs: 5_000, nearMs: 1_000, nearWindowMs: 60_000 });
  });

  it("takes overrides from the environment", () => {
    process.env.SNIPE_RECHECK_MS = "8000";
    process.env.SNIPE_RECHECK_NEAR_MS = "500";
    process.env.SNIPE_RECHECK_NEAR_WINDOW_MS = "120000";
    expect(recheckCadence()).toEqual({ farMs: 8_000, nearMs: 500, nearWindowMs: 120_000 });
  });

  it("floors the cadences so a misconfigured env can't spin a metered endpoint", () => {
    process.env.SNIPE_RECHECK_MS = "0";
    process.env.SNIPE_RECHECK_NEAR_MS = "10";
    expect(recheckCadence().farMs).toBe(500);
    expect(recheckCadence().nearMs).toBe(200);
  });
});

describe("recheckDelayMs", () => {
  const c = { farMs: 5_000, nearMs: 1_000, nearWindowMs: 60_000 };

  it("uses the far cadence while the start is beyond the window", () => {
    expect(recheckDelayMs(120_000, c)).toBe(5_000);
  });

  it("switches to the near cadence at the window boundary and inside it", () => {
    expect(recheckDelayMs(60_000, c)).toBe(1_000);
    expect(recheckDelayMs(5_000, c)).toBe(1_000);
  });

  it("keeps the near cadence in the final seconds — no blind spot at the boundary", () => {
    expect(recheckDelayMs(1_000, c)).toBe(1_000);
    expect(recheckDelayMs(0, c)).toBe(1_000);
    expect(recheckDelayMs(-500, c)).toBe(1_000);
  });
});
