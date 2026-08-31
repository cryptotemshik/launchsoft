import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { addWhale, loadCurated, removeWhale } from "./curated";

let dir: string;
let cfg: string;
const A = `0x${"a1".repeat(20)}`;
const B = `0x${"b2".repeat(20)}`;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "curated-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("whales", () => {
  it("adds, dedupes (refreshing the label) and removes", () => {
    addWhale(cfg, A, "8 ETH");
    addWhale(cfg, A.toUpperCase().replace("0X", "0x"), "9 ETH"); // same address
    const whales = loadCurated(cfg).whales;
    expect(whales).toHaveLength(1);
    expect(whales[0].label).toBe("9 ETH");
    addWhale(cfg, B);
    expect(loadCurated(cfg).whales.map((w) => w.address).sort()).toEqual([A, B].sort());
    removeWhale(cfg, A);
    expect(loadCurated(cfg).whales.map((w) => w.address)).toEqual([B]);
  });

  it("rejects a non-address", () => {
    expect(() => addWhale(cfg, "nope")).toThrow(/not a wallet/);
  });

  it("is empty when nothing is stored", () => {
    expect(loadCurated(cfg).whales).toEqual([]);
  });
});
