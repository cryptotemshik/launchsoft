import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  adminAdjust,
  balanceOf,
  canSnipe,
  chargeSnipe,
  chargeSubscription,
  deposit,
  grantFreeSnipes,
  InsufficientBalance,
  loadBilling,
  refund,
  spendForFunding,
} from "./billing";

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "billing-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ETH = 10n ** 18n;

describe("balance and deposits", () => {
  it("starts empty and adds up deposits", () => {
    expect(balanceOf(cfg)).toBe(0n);
    deposit(cfg, ETH);
    deposit(cfg, ETH / 2n);
    expect(balanceOf(cfg)).toBe(ETH + ETH / 2n);
    expect(loadBilling(cfg).entries).toHaveLength(2);
  });

  it("refuses a non-positive deposit", () => {
    expect(() => deposit(cfg, 0n)).toThrow(/positive/);
  });
});

describe("charging for a snipe", () => {
  it("takes the fee from the balance and records the dollars", () => {
    deposit(cfg, ETH);
    const r = chargeSnipe(cfg, ETH / 1000n, { usdCents: 200, note: "BoredApes" });
    expect(r.charged).toBe("balance");
    expect(balanceOf(cfg)).toBe(ETH - ETH / 1000n);
    const last = loadBilling(cfg).entries.at(-1)!;
    expect(last.kind).toBe("snipe");
    expect(last.usdCents).toBe(200);
    expect(BigInt(last.wei)).toBe(-(ETH / 1000n));
  });

  it("refuses when the balance will not cover it and changes nothing", () => {
    deposit(cfg, ETH / 1_000_000n);
    expect(() => chargeSnipe(cfg, ETH / 1000n, { usdCents: 200 })).toThrow(InsufficientBalance);
    // Nothing was written beyond the deposit.
    expect(loadBilling(cfg).entries).toHaveLength(1);
  });

  it("spends a free snipe before any money, and records it at zero", () => {
    deposit(cfg, ETH);
    grantFreeSnipes(cfg, 2);
    const r = chargeSnipe(cfg, ETH / 1000n, { usdCents: 200 });
    expect(r.charged).toBe("free");
    expect(balanceOf(cfg)).toBe(ETH); // untouched
    expect(loadBilling(cfg).freeSnipes).toBe(1);
    const last = loadBilling(cfg).entries.at(-1)!;
    expect(BigInt(last.wei)).toBe(0n);
    expect(last.note).toMatch(/free/);
  });

  it("lets a free snipe go through even on an empty balance", () => {
    grantFreeSnipes(cfg, 1);
    expect(canSnipe(cfg, ETH)).toBe(true);
    expect(chargeSnipe(cfg, ETH, { usdCents: 200 }).charged).toBe("free");
    // Now nothing free left and no money: refused.
    expect(canSnipe(cfg, ETH)).toBe(false);
    expect(() => chargeSnipe(cfg, ETH, { usdCents: 200 })).toThrow(InsufficientBalance);
  });
});

describe("subscriptions, refunds, admin adjustments", () => {
  it("charges a subscription from the balance", () => {
    deposit(cfg, ETH);
    chargeSubscription(cfg, ETH / 100n, { usdCents: 2999, note: "Pro month" });
    expect(balanceOf(cfg)).toBe(ETH - ETH / 100n);
  });

  it("refuses a subscription the balance cannot cover", () => {
    expect(() => chargeSubscription(cfg, ETH, { usdCents: 2999 })).toThrow(InsufficientBalance);
  });

  it("puts money back on a refund", () => {
    deposit(cfg, ETH);
    chargeSnipe(cfg, ETH / 1000n, { usdCents: 200 });
    refund(cfg, ETH / 1000n, "reverted");
    expect(balanceOf(cfg)).toBe(ETH);
  });

  it("lets an admin credit and debit with a reason", () => {
    adminAdjust(cfg, ETH, "goodwill");
    expect(balanceOf(cfg)).toBe(ETH);
    adminAdjust(cfg, -ETH / 2n, "correction");
    expect(balanceOf(cfg)).toBe(ETH / 2n);
    expect(() => adminAdjust(cfg, -ETH, "too much")).toThrow(/negative balance/);
  });
});

describe("funding snipe wallets from the balance", () => {
  it("takes the outflow from the balance and books it as funding", () => {
    deposit(cfg, ETH);
    spendForFunding(cfg, ETH / 4n, "funded 3 wallets");
    expect(balanceOf(cfg)).toBe(ETH - ETH / 4n);
    const last = loadBilling(cfg).entries.at(-1)!;
    expect(last.kind).toBe("funding");
    expect(last.wei).toBe((-(ETH / 4n)).toString());
  });

  it("refuses to fund more than the balance holds", () => {
    deposit(cfg, ETH / 2n);
    expect(() => spendForFunding(cfg, ETH, "too much")).toThrow(InsufficientBalance);
    expect(balanceOf(cfg)).toBe(ETH / 2n);
  });

  it("refuses a non-positive funding spend", () => {
    deposit(cfg, ETH);
    expect(() => spendForFunding(cfg, 0n)).toThrow(/positive/);
  });
});
