import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  currentAlerts,
  prune,
  recordAcquisitions,
  takeNewAlerts,
} from "./whaleAlerts";
import type { Acquisition } from "../lib/whaleWatch";

let dir: string;
let cfg: string;
const COLL = `0x${"cc".repeat(20)}` as `0x${string}`;
const w = (n: string) => `0x${n.repeat(20)}` as `0x${string}`;

function acq(whale: `0x${string}`, minted = false): Acquisition {
  return { contract: COLL, whale, minted, blockNumber: 1 };
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "whalealerts-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("whale-alert tally", () => {
  it("reports a collection only once three distinct whales enter it", () => {
    recordAcquisitions(cfg, [acq(w("11")), acq(w("22"))], 1000);
    expect(currentAlerts(cfg, { nowMs: 1000 })).toHaveLength(0);
    recordAcquisitions(cfg, [acq(w("33"))], 1000);
    const alerts = currentAlerts(cfg, { nowMs: 1000 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].count).toBe(3);
    expect(alerts[0].contract).toBe(COLL);
  });

  it("counts a whale once no matter how often it buys", () => {
    recordAcquisitions(cfg, [acq(w("11")), acq(w("11")), acq(w("22")), acq(w("33"))], 1000);
    expect(currentAlerts(cfg, { nowMs: 1000 })[0].count).toBe(3);
  });

  it("forgets whales outside the window", () => {
    recordAcquisitions(cfg, [acq(w("11")), acq(w("22"))], 1000);
    recordAcquisitions(cfg, [acq(w("33"))], 1000 + 2 * 3600_000);
    // With a 1h window, the first two have aged out — only one remains.
    prune(cfg, 3600_000, 1000 + 2 * 3600_000);
    expect(currentAlerts(cfg, { windowMs: 3600_000, nowMs: 1000 + 2 * 3600_000 })).toHaveLength(0);
  });

  it("announces the third whale once, then the fourth", () => {
    recordAcquisitions(cfg, [acq(w("11")), acq(w("22")), acq(w("33"))], 1000);
    expect(takeNewAlerts(cfg, { nowMs: 1000 }).map((a) => a.count)).toEqual([3]);
    // Nothing new on a re-poll.
    expect(takeNewAlerts(cfg, { nowMs: 1000 })).toHaveLength(0);
    // A fourth whale is a fresh report.
    recordAcquisitions(cfg, [acq(w("44"))], 1000);
    expect(takeNewAlerts(cfg, { nowMs: 1000 }).map((a) => a.count)).toEqual([4]);
  });
});
