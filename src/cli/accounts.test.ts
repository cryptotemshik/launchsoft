import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  accountConfigPath,
  accountDir,
  accountDirs,
  ensureAccount,
  getAccount,
  isPro,
  listAccounts,
  readRegistry,
  tierOf,
  updateAccount,
} from "./accounts";
import { loadConfig } from "./config";

const A = `0x${"a1".repeat(20)}` as const;
const B = `0x${"b2".repeat(20)}` as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "accounts-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("provisioning an account", () => {
  it("creates a loadable config the first time and is idempotent after", () => {
    const rec = ensureAccount(root, A, 1000);
    expect(rec.address).toBe(A);
    expect(rec.createdAt).toBe(1000);
    // The seeded config is a real, loadable SnipeConfig.
    const cfg = loadConfig(accountConfigPath(root, A));
    expect(cfg.chainId).toBe(4663);
    expect(cfg.keysFile).toBe("keys.txt");

    // A second call must not move createdAt or touch the config.
    const again = ensureAccount(root, A, 9999);
    expect(again.createdAt).toBe(1000);
  });

  it("keeps each account's data under its own directory", () => {
    ensureAccount(root, A);
    ensureAccount(root, B);
    expect(accountDir(root, A)).not.toBe(accountDir(root, B));
    // The keys file resolves inside the account's own directory, so no account
    // can read another's wallets.
    expect(accountConfigPath(root, A).startsWith(accountDir(root, A))).toBe(true);
    expect(accountDirs(root).sort()).toEqual([A, B].sort());
  });

  it("treats the address case-insensitively — same wallet, same world", () => {
    ensureAccount(root, A.toUpperCase().replace("0X", "0x"), 5);
    expect(getAccount(root, A)?.createdAt).toBe(5);
    expect(readRegistry(root).size).toBe(1);
  });

  it("does not clobber an existing config when called again", () => {
    ensureAccount(root, A);
    const cfgPath = accountConfigPath(root, A);
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    raw.collection = `0x${"cd".repeat(20)}`;
    raw.quantity = 7;
    writeFileSync(cfgPath, JSON.stringify(raw));
    ensureAccount(root, A);
    expect(loadConfig(cfgPath).quantity).toBe(7);
  });

  it("rejects a non-address", () => {
    expect(() => ensureAccount(root, "not-an-address")).toThrow(/not a wallet/);
  });
});

describe("the registry", () => {
  it("returns null for an account that has never logged in", () => {
    expect(getAccount(root, A)).toBeNull();
  });

  it("survives being read fresh from disk", () => {
    ensureAccount(root, A, 100);
    ensureAccount(root, B, 200);
    // A brand-new read (no in-memory state) sees both.
    expect(readRegistry(root).size).toBe(2);
    expect(listAccounts(root).map((r) => r.address)).toEqual([B, A]); // newest first
  });

  it("ignores a corrupt registry rather than throwing", () => {
    ensureAccount(root, A);
    writeFileSync(resolve(root, "registry.json"), "{ not json");
    expect(readRegistry(root).size).toBe(0);
  });
});

describe("profile and tier", () => {
  it("merges profile fields and strips handles for twitter and telegram", () => {
    ensureAccount(root, A);
    updateAccount(root, A, { profile: { nickname: "  ace  ", twitter: "@ace_x" } });
    updateAccount(root, A, { profile: { avatarUrl: "https://x/y.png" } });
    updateAccount(root, A, { profile: { telegram: "https://t.me/ace_tg" } });
    const rec = getAccount(root, A)!;
    expect(rec.profile).toEqual({
      nickname: "ace",
      twitter: "ace_x",
      avatarUrl: "https://x/y.png",
      telegram: "ace_tg",
    });
  });

  it("is free by default and pro only while the subscription is in force", () => {
    ensureAccount(root, A);
    expect(isPro(getAccount(root, A)!, 1000)).toBe(false);
    updateAccount(root, A, { proUntil: 5000 });
    expect(tierOf(getAccount(root, A)!, 4000)).toBe("pro");
    expect(tierOf(getAccount(root, A)!, 6000)).toBe("free");
    // Clearing it drops back to free.
    updateAccount(root, A, { proUntil: null });
    expect(getAccount(root, A)!.proUntil).toBeUndefined();
  });

  it("provisions on update if the account is somehow missing", () => {
    const rec = updateAccount(root, A, { profile: { nickname: "late" } });
    expect(rec.profile.nickname).toBe("late");
    expect(existsSync(accountConfigPath(root, A))).toBe(true);
  });
});
