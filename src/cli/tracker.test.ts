import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getScanBlock, loadTracker, setScanBlock, setTracker } from "./tracker";

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "tracker-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const A = `0x${"a".repeat(40)}` as const;
const B = `0x${"b".repeat(40)}` as const;
const C = `0x${"c".repeat(40)}` as const;

describe("tracker list", () => {
  it("starts empty", () => {
    expect(loadTracker(cfg)).toEqual([]);
  });

  it("stores, lower-cases and keeps labels", () => {
    const { stored } = setTracker(cfg, [{ address: A.toUpperCase(), label: "Alice" }], 10);
    expect(stored).toEqual([{ address: A, label: "Alice" }]);
    expect(loadTracker(cfg)).toEqual([{ address: A, label: "Alice" }]);
  });

  it("dedupes by address, first label wins", () => {
    const { stored } = setTracker(cfg, [
      { address: A, label: "one" },
      { address: A, label: "two" },
      { address: B },
    ], 10);
    expect(stored).toEqual([{ address: A, label: "one" }, { address: B }]);
  });

  it("caps at the tier limit and reports the drop", () => {
    const { stored, dropped } = setTracker(cfg, [{ address: A }, { address: B }, { address: C }], 2);
    expect(stored.map((w) => w.address)).toEqual([A, B]);
    expect(dropped).toBe(1);
  });

  it("ignores non-addresses", () => {
    const { stored } = setTracker(cfg, [{ address: "nope" }, { address: A }], 10);
    expect(stored).toEqual([{ address: A }]);
  });

  it("replacing wholesale drops what's gone", () => {
    setTracker(cfg, [{ address: A }, { address: B }], 10);
    setTracker(cfg, [{ address: C }], 10);
    expect(loadTracker(cfg).map((w) => w.address)).toEqual([C]);
  });
});

describe("scan checkpoint", () => {
  it("starts at zero and round-trips", () => {
    expect(getScanBlock(cfg)).toBe(0);
    setScanBlock(cfg, 12345);
    expect(getScanBlock(cfg)).toBe(12345);
  });
});
