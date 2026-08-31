import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  addCredited,
  addSwept,
  depositAddress,
  depositKey,
  ensureDeposit,
  uncreditedWei,
} from "./depositWallet";
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

  it("credits deposits once, and a sweep does not cause a double-credit", () => {
    ensureDeposit(cfg, "pass");
    const ETH = 10n ** 18n;
    // A 1 ETH deposit: balance 1, nothing swept/credited → 1 uncredited.
    expect(uncreditedWei(cfg, ETH)).toBe(ETH);
    addCredited(cfg, ETH); // credit it
    expect(uncreditedWei(cfg, ETH)).toBe(0n); // nothing new
    // Now we sweep ~all of it out; balance drops to a dust residual.
    addSwept(cfg, ETH - ETH / 100n);
    // The residual must NOT be seen as a fresh deposit.
    expect(uncreditedWei(cfg, ETH / 100n)).toBe(0n);
    // A second 2 ETH deposit lands on top of the residual → exactly 2 new.
    expect(uncreditedWei(cfg, ETH / 100n + 2n * ETH)).toBe(2n * ETH);
  });
});
