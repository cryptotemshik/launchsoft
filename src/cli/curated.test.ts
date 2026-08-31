import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  addInfluencer,
  addWhale,
  loadCurated,
  removeInfluencer,
  removeWhale,
} from "./curated";

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
  it("adds, dedupes and removes", () => {
    addWhale(cfg, A, "big one");
    addWhale(cfg, A.toUpperCase().replace("0X", "0x")); // same address, different case
    expect(loadCurated(cfg).whales).toHaveLength(1);
    addWhale(cfg, B);
    expect(loadCurated(cfg).whales.map((w) => w.address).sort()).toEqual([A, B].sort());
    removeWhale(cfg, A);
    expect(loadCurated(cfg).whales.map((w) => w.address)).toEqual([B]);
  });

  it("rejects a non-address", () => {
    expect(() => addWhale(cfg, "nope")).toThrow(/not a wallet/);
  });
});

describe("influencers", () => {
  it("adds with a name and twitter, updates on re-add, removes", () => {
    addInfluencer(cfg, A, "Ace", "@ace_x");
    let list = loadCurated(cfg).influencers;
    expect(list[0]).toMatchObject({ address: A, name: "Ace", twitter: "ace_x" });
    // Re-adding the same address updates rather than duplicates.
    addInfluencer(cfg, A, "Ace II", "ace2");
    list = loadCurated(cfg).influencers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Ace II", twitter: "ace2" });
    removeInfluencer(cfg, A);
    expect(loadCurated(cfg).influencers).toHaveLength(0);
  });

  it("requires a name", () => {
    expect(() => addInfluencer(cfg, A, "   ")).toThrow(/name/);
  });
});
