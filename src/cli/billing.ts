/**
 * The money side of an account: a balance, and an honest record of every
 * movement through it.
 *
 * The product charges a flat fee per snipe and sells a monthly Pro plan, both
 * priced in dollars but paid in ETH — so the balance is kept in wei (the only
 * unit that never rounds) and each charge records the USD it stood for at the
 * time, because "you were charged $2" is what a user needs to see even after
 * the rate has moved. Nothing here fetches a price or a balance from a chain;
 * the caller passes the wei amount already worked out, so this stays pure and
 * testable and the one place that decides a debit is the one place that writes
 * the ledger.
 *
 * A ledger, not just a number: the balance is derived truth, but the trail of
 * how it got there is what answers a dispute, feeds the admin dashboard, and
 * proves we did not charge for a snipe that never fired. Append-only in spirit
 * — entries are only ever added — and stored per account, beside its config,
 * so it is as isolated as everything else a wallet owns.
 *
 * Free snipes are a separate small counter, not a fake balance: an admin hands
 * them out (a giveaway prize), and a snipe spends one before it spends money,
 * so a gift never has to be priced in ETH to be given.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type EntryKind =
  | "deposit"
  | "snipe"
  | "subscription"
  | "refund"
  | "admin-credit"
  | "admin-debit";

export interface LedgerEntry {
  at: number;
  kind: EntryKind;
  /**
   * Signed wei: positive adds to the balance (deposit, credit, refund),
   * negative takes from it (snipe, subscription, debit). A free snipe writes a
   * zero-wei entry so the count of snipes is still honest.
   */
  wei: string;
  /** What that stood for in US cents, when the entry is a priced charge. */
  usdCents?: number;
  /** Free-text: a drop label, a payment reference, why an admin adjusted it. */
  note?: string;
}

export interface BillingState {
  balanceWei: string;
  /** Snipes an admin gave; spent before money is. */
  freeSnipes: number;
  entries: LedgerEntry[];
}

const EMPTY: BillingState = { balanceWei: "0", freeSnipes: 0, entries: [] };

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.billing.json`;
}

export function loadBilling(configPath: string): BillingState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pathFor(configPath), "utf8"));
  } catch {
    return { ...EMPTY, entries: [] };
  }
  const s = raw as Partial<BillingState>;
  return {
    balanceWei: typeof s.balanceWei === "string" && /^\d+$/.test(s.balanceWei) ? s.balanceWei : "0",
    freeSnipes: Number.isInteger(s.freeSnipes) && (s.freeSnipes as number) > 0 ? (s.freeSnipes as number) : 0,
    entries: Array.isArray(s.entries) ? (s.entries as LedgerEntry[]).filter(isEntry) : [],
  };
}

function isEntry(e: unknown): e is LedgerEntry {
  const x = e as Partial<LedgerEntry>;
  return Boolean(x && typeof x.at === "number" && typeof x.kind === "string" && typeof x.wei === "string");
}

function save(configPath: string, state: BillingState): void {
  const target = pathFor(configPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

export function balanceOf(configPath: string): bigint {
  return BigInt(loadBilling(configPath).balanceWei);
}

/** Append an entry and re-derive the balance from it. Returns the new state. */
function append(configPath: string, entry: LedgerEntry): BillingState {
  const state = loadBilling(configPath);
  const balance = BigInt(state.balanceWei) + BigInt(entry.wei);
  if (balance < 0n) {
    // Should never happen — callers check first — but a negative balance is a
    // corruption we refuse to write rather than paper over.
    throw new Error("refusing to write a negative balance");
  }
  const next: BillingState = {
    balanceWei: balance.toString(),
    freeSnipes: state.freeSnipes,
    entries: [...state.entries, entry],
  };
  save(configPath, next);
  return next;
}

/** Money in — a deposit seen at the account's address, or a manual credit. */
export function deposit(configPath: string, wei: bigint, note?: string, nowMs = Date.now()): BillingState {
  if (wei <= 0n) throw new Error("a deposit must be positive");
  return append(configPath, { at: nowMs, kind: "deposit", wei: wei.toString(), note });
}

export interface ChargeResult {
  charged: "free" | "balance";
  state: BillingState;
}

/**
 * Charge for one snipe.
 *
 * A free snipe is spent first when the account has any — a zero-wei "snipe"
 * entry records that it happened without money. Otherwise the wei amount is
 * taken from the balance, and if the balance will not cover it the charge is
 * refused (the caller must not queue the job): running a paid action on an
 * empty balance is the one thing this must never allow.
 */
export function chargeSnipe(
  configPath: string,
  amountWei: bigint,
  opts: { usdCents?: number; note?: string; nowMs?: number } = {},
): ChargeResult {
  const nowMs = opts.nowMs ?? Date.now();
  const state = loadBilling(configPath);
  if (state.freeSnipes > 0) {
    const next: BillingState = {
      ...state,
      freeSnipes: state.freeSnipes - 1,
      entries: [
        ...state.entries,
        { at: nowMs, kind: "snipe", wei: "0", usdCents: 0, note: opts.note ? `${opts.note} (free)` : "free snipe" },
      ],
    };
    save(configPath, next);
    return { charged: "free", state: next };
  }
  if (amountWei <= 0n) throw new Error("a snipe charge must be positive");
  if (BigInt(state.balanceWei) < amountWei) {
    throw new InsufficientBalance(amountWei, BigInt(state.balanceWei));
  }
  const next = append(configPath, {
    at: nowMs,
    kind: "snipe",
    wei: (-amountWei).toString(),
    usdCents: opts.usdCents,
    note: opts.note,
  });
  return { charged: "balance", state: next };
}

/** Charge a subscription period. Refused if the balance will not cover it. */
export function chargeSubscription(
  configPath: string,
  amountWei: bigint,
  opts: { usdCents?: number; note?: string; nowMs?: number } = {},
): BillingState {
  const nowMs = opts.nowMs ?? Date.now();
  if (amountWei <= 0n) throw new Error("a subscription charge must be positive");
  if (balanceOf(configPath) < amountWei) {
    throw new InsufficientBalance(amountWei, balanceOf(configPath));
  }
  return append(configPath, {
    at: nowMs,
    kind: "subscription",
    wei: (-amountWei).toString(),
    usdCents: opts.usdCents,
    note: opts.note,
  });
}

/** Give money back — a reverted snipe we had pre-charged, say. */
export function refund(configPath: string, wei: bigint, note?: string, nowMs = Date.now()): BillingState {
  if (wei <= 0n) throw new Error("a refund must be positive");
  return append(configPath, { at: nowMs, kind: "refund", wei: wei.toString(), note });
}

/** An admin adjusts a balance up or down, by hand, with a reason. */
export function adminAdjust(configPath: string, wei: bigint, note: string, nowMs = Date.now()): BillingState {
  if (wei === 0n) throw new Error("an adjustment must be non-zero");
  return append(configPath, {
    at: nowMs,
    kind: wei > 0n ? "admin-credit" : "admin-debit",
    wei: wei.toString(),
    note,
  });
}

/** Hand out free snipes — a giveaway prize. */
export function grantFreeSnipes(configPath: string, n: number): BillingState {
  if (!Number.isInteger(n) || n <= 0) throw new Error("grant a whole positive number of snipes");
  const state = loadBilling(configPath);
  const next = { ...state, freeSnipes: state.freeSnipes + n };
  save(configPath, next);
  return next;
}

export class InsufficientBalance extends Error {
  constructor(
    readonly needWei: bigint,
    readonly haveWei: bigint,
  ) {
    super("insufficient balance");
    this.name = "InsufficientBalance";
  }
}

/** True when a snipe would go through right now — a free one, or enough balance. */
export function canSnipe(configPath: string, amountWei: bigint): boolean {
  const state = loadBilling(configPath);
  return state.freeSnipes > 0 || BigInt(state.balanceWei) >= amountWei;
}
