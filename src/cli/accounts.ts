/**
 * One account per wallet, and the private little world each one owns.
 *
 * The single-tenant server kept everything under one config file: one set of
 * wallets, one job queue, one watchlist. Going public means many people share
 * the box, and none of them may ever see — let alone touch — another's wallets
 * or drops. The neat part is that the stores were already written to hang off a
 * config *path*: jobs live at `<config>.jobs.json`, the watchlist at
 * `<config>.upcoming.json`, sessions at `<config>.sessions.json`, and the keys
 * file resolves next to the config. So isolation is not a rewrite of those
 * stores at all — it is giving each account its own config path and letting the
 * rest follow. This module owns that mapping and the small registry of who
 * exists.
 *
 * The address is the identity, proven at login (auth.ts). Everything here is
 * keyed by it, lower-cased, so the same wallet always lands in the same world
 * however it was typed.
 *
 * Deliberately not here yet: balances, the per-snipe ledger, deposit addresses.
 * Those are billing, and billing is its own step — this is only the ground it
 * will stand on.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

/** What a wallet may reveal about itself. All optional, all self-served. */
export interface AccountProfile {
  /** Display name; falls back to the short address when unset. */
  nickname?: string;
  /** An avatar — an NFT the wallet holds, or an uploaded image URL. */
  avatarUrl?: string;
  /** A Twitter/X handle, without the @. */
  twitter?: string;
}

export interface AccountRecord {
  /** The login address, lower-cased. This is the account's identity. */
  address: `0x${string}`;
  createdAt: number;
  /**
   * Pro is a subscription with an end date rather than a flag, so it can lapse
   * on its own and an admin can grant a free month by pushing the date out.
   * Absent (or past) means the free tier. See {@link tierOf}.
   */
  proUntil?: number;
  profile: AccountProfile;
}

export type Tier = "free" | "pro";

/** The address regex used everywhere here: 0x + 40 hex, lower-cased. */
const ADDRESS = /^0x[0-9a-f]{40}$/;

function normAddress(address: string): `0x${string}` {
  const lower = address.toLowerCase();
  if (!ADDRESS.test(lower)) throw new Error(`not a wallet address: ${address}`);
  return lower as `0x${string}`;
}

/** Where all accounts live. One directory per address underneath. */
export function accountsRoot(env = process.env): string {
  return resolve(env.SNIPE_ACCOUNTS_DIR?.trim() || "data/accounts");
}

/** This account's own directory. */
export function accountDir(root: string, address: string): string {
  return resolve(root, normAddress(address));
}

/**
 * The config path for an account — the keystone. Every other store (jobs,
 * watchlist, sessions, keys) derives its own path from this one, so handing a
 * route this path in place of the global config is the whole of isolation.
 */
export function accountConfigPath(root: string, address: string): string {
  return resolve(accountDir(root, address), "snipe.config.json");
}

const REGISTRY = "registry.json";

function registryPath(root: string): string {
  return resolve(root, REGISTRY);
}

/** Read the whole registry as a map, address → record. Empty when none. */
export function readRegistry(root: string): Map<string, AccountRecord> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(registryPath(root), "utf8"));
  } catch {
    return new Map();
  }
  const map = new Map<string, AccountRecord>();
  if (raw && typeof raw === "object") {
    for (const [addr, rec] of Object.entries(raw as Record<string, unknown>)) {
      const r = rec as Partial<AccountRecord>;
      if (!ADDRESS.test(addr) || typeof r?.createdAt !== "number") continue;
      map.set(addr, {
        address: addr as `0x${string}`,
        createdAt: r.createdAt,
        proUntil: typeof r.proUntil === "number" ? r.proUntil : undefined,
        profile: sanitiseProfile(r.profile),
      });
    }
  }
  return map;
}

function sanitiseProfile(p: unknown): AccountProfile {
  const q = (p ?? {}) as Partial<AccountProfile>;
  const out: AccountProfile = {};
  if (typeof q.nickname === "string" && q.nickname.trim()) out.nickname = q.nickname.trim();
  if (typeof q.avatarUrl === "string" && q.avatarUrl.trim()) out.avatarUrl = q.avatarUrl.trim();
  if (typeof q.twitter === "string" && q.twitter.trim()) {
    out.twitter = q.twitter.trim().replace(/^@+/, "");
  }
  return out;
}

/** Write the registry via temp-and-rename, so a crash mid-write loses nothing. */
function writeRegistry(root: string, map: Map<string, AccountRecord>): void {
  mkdirSync(root, { recursive: true });
  const obj: Record<string, AccountRecord> = {};
  for (const [addr, rec] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) {
    obj[addr] = rec;
  }
  const target = registryPath(root);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * The default config a fresh account starts with — a valid file the runner can
 * load, with no drop chosen yet (the zero address is a placeholder the Snipe
 * tab overwrites the moment a real collection is queued). Keys sit next to it
 * in this account's own directory, so no account can read another's.
 */
function defaultConfig(): Record<string, unknown> {
  return {
    chainId: 4663,
    collection: "0x0000000000000000000000000000000000000000",
    keysFile: "keys.txt",
    stage: "public",
    quantity: 1,
    extraRpcs: [],
    gas: { maxFeeGwei: "2", tipGwei: "0.05", limit: 500_000 },
    timing: "wait",
  };
}

/**
 * Make sure an account exists, creating its world on first sight.
 *
 * Idempotent: an existing account is returned untouched (its config and keys
 * are left exactly as they are — this must never clobber wallets). Only the
 * missing pieces are created, so it is safe to call on every login.
 */
export function ensureAccount(
  root: string,
  address: string,
  nowMs = Date.now(),
): AccountRecord {
  const addr = normAddress(address);
  const dir = accountDir(root, addr);
  mkdirSync(dir, { recursive: true });

  const cfgPath = accountConfigPath(root, addr);
  if (!existsSync(cfgPath)) {
    const tmp = `${cfgPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, cfgPath);
  }

  const registry = readRegistry(root);
  const existing = registry.get(addr);
  if (existing) return existing;

  const record: AccountRecord = { address: addr, createdAt: nowMs, profile: {} };
  registry.set(addr, record);
  writeRegistry(root, registry);
  return record;
}

/** One account's record, or null when it has never logged in. */
export function getAccount(root: string, address: string): AccountRecord | null {
  return readRegistry(root).get(normAddress(address)) ?? null;
}

/** Every account, newest first — for the admin dashboard. */
export function listAccounts(root: string): AccountRecord[] {
  return [...readRegistry(root).values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Merge a patch into an account and persist it. The address and createdAt are
 * fixed — identity does not move — so they are ignored in the patch. A profile
 * patch is merged field by field and re-sanitised. Returns the saved record.
 */
export function updateAccount(
  root: string,
  address: string,
  patch: { proUntil?: number | null; profile?: AccountProfile },
): AccountRecord {
  const addr = normAddress(address);
  const registry = readRegistry(root);
  const current = registry.get(addr) ?? ensureAccount(root, addr);
  const next: AccountRecord = {
    ...current,
    proUntil:
      patch.proUntil === null
        ? undefined
        : typeof patch.proUntil === "number"
          ? patch.proUntil
          : current.proUntil,
    profile: patch.profile
      ? sanitiseProfile({ ...current.profile, ...patch.profile })
      : current.profile,
  };
  registry.set(addr, next);
  writeRegistry(root, registry);
  return next;
}

/** Free unless a Pro subscription is currently in force. */
export function tierOf(record: AccountRecord, nowMs = Date.now()): Tier {
  return record.proUntil != null && record.proUntil > nowMs ? "pro" : "free";
}

export function isPro(record: AccountRecord, nowMs = Date.now()): boolean {
  return tierOf(record, nowMs) === "pro";
}

/**
 * Every address that has an on-disk account directory, whether or not it is in
 * the registry — a belt-and-braces list for migration and repair. Cheap; the
 * registry is the source of truth for everything else.
 */
export function accountDirs(root: string): `0x${string}`[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((e) => ADDRESS.test(e.toLowerCase())).map((e) => e.toLowerCase() as `0x${string}`);
}
