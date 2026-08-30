import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRegistry,
  MATURE_MS,
  maturedAddresses,
  registerAddress,
  registryView,
  removeAddress,
} from "./withdrawRegistry";

const configIn = () => join(mkdtempSync(join(tmpdir(), "withdraw-")), "snipe.config.json");
const ADDR = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const T0 = 1_700_000_000_000;

describe("registering an address", () => {
  it("stores it lower-case with its clock started", () => {
    const cfg = configIn();
    registerAddress(cfg, ADDR.toUpperCase().replace("0X", "0x"), "cold wallet", T0);
    expect(loadRegistry(cfg)).toEqual([{ address: ADDR, label: "cold wallet", addedAt: T0 }]);
  });

  it("does not reset the clock on re-registration", () => {
    // Otherwise an attacker could keep an address perpetually one re-add away
    // from maturity — or worse, a victim re-adding their own address would
    // reset a countdown an attacker is waiting out.
    const cfg = configIn();
    registerAddress(cfg, ADDR, undefined, T0);
    const r = registerAddress(cfg, ADDR, undefined, T0 + MATURE_MS);
    expect(r.added).toBe(false);
    expect(loadRegistry(cfg)[0].addedAt).toBe(T0);
  });

  it("refuses anything that is not an address", () => {
    expect(() => registerAddress(configIn(), "not-an-address", undefined, T0)).toThrow(
      /not a 0x address/,
    );
  });
});

describe("the hour it has to wait", () => {
  it("does not count a fresh address", () => {
    const cfg = configIn();
    registerAddress(cfg, ADDR, undefined, T0);
    expect(maturedAddresses(cfg, T0 + MATURE_MS - 1).has(ADDR)).toBe(false);
  });

  it("counts it once the hour has passed", () => {
    const cfg = configIn();
    registerAddress(cfg, ADDR, undefined, T0);
    expect(maturedAddresses(cfg, T0 + MATURE_MS).has(ADDR)).toBe(true);
  });

  it("judges each entry on its own clock", () => {
    const cfg = configIn();
    registerAddress(cfg, ADDR, undefined, T0);
    registerAddress(cfg, OTHER, undefined, T0 + MATURE_MS);
    const at = T0 + MATURE_MS + 1;
    expect(maturedAddresses(cfg, at).has(ADDR)).toBe(true);
    expect(maturedAddresses(cfg, at).has(OTHER)).toBe(false);
  });
});

describe("removing", () => {
  it("takes the address out of the allowed set at once", () => {
    // Removal is the panic button; it must not have a delay of its own.
    const cfg = configIn();
    registerAddress(cfg, ADDR, undefined, T0);
    expect(removeAddress(cfg, ADDR).removed).toBe(true);
    expect(maturedAddresses(cfg, T0 + MATURE_MS * 2).size).toBe(0);
  });

  it("says so when there was nothing to remove", () => {
    expect(removeAddress(configIn(), ADDR).removed).toBe(false);
  });
});

describe("the panel's view", () => {
  it("says how long each entry still has to wait", () => {
    const cfg = configIn();
    registerAddress(cfg, ADDR, "main", T0);
    const [v] = registryView(cfg, T0 + MATURE_MS / 2);
    expect(v.matured).toBe(false);
    expect(v.readyInMs).toBe(MATURE_MS / 2);
  });

  it("reports a matured entry as ready now", () => {
    const cfg = configIn();
    registerAddress(cfg, ADDR, undefined, T0);
    const [v] = registryView(cfg, T0 + MATURE_MS + 5);
    expect(v.matured).toBe(true);
    expect(v.readyInMs).toBe(0);
  });
});
