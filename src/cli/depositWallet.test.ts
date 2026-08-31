import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { depositAddress, depositKey, ensureDeposit, seenWei, setSeenWei } from "./depositWallet";
import { privateKeyToAccount } from "viem/accounts";

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "deposit-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deposit address", () => {
  it("generates once and never moves", () => {
    const a = ensureDeposit(cfg, "pass");
    expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(ensureDeposit(cfg, "pass")).toBe(a); // stable
    expect(depositAddress(cfg)).toBe(a);
  });

  it("the address is readable without a passphrase, the key is not", () => {
    ensureDeposit(cfg, "pass");
    expect(depositAddress(cfg)).toBeTruthy(); // no passphrase needed
    const key = depositKey(cfg, "pass")!;
    // The stored key really controls the address.
    expect(privateKeyToAccount(key).address.toLowerCase()).toBe(depositAddress(cfg));
    // Sealed: without the passphrase it will not open.
    expect(() => depositKey(cfg, null)).toThrow(/sealed/);
  });

  it("works with no passphrase (key stored plain)", () => {
    const a = ensureDeposit(cfg, null);
    expect(depositKey(cfg, null)).toBeTruthy();
    expect(privateKeyToAccount(depositKey(cfg, null)!).address.toLowerCase()).toBe(a);
  });

  it("tracks the last-seen balance for delta crediting", () => {
    ensureDeposit(cfg, "pass");
    expect(seenWei(cfg)).toBe(0n);
    setSeenWei(cfg, 10n ** 18n);
    expect(seenWei(cfg)).toBe(10n ** 18n);
  });
});
