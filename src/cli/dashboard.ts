/**
 * The team dashboard: a read-only view of the main world for someone who is
 * not the operator — a partner who wants to watch the wallets, the queue and
 * the results without holding any power over them.
 *
 * Everything here is pure or append-only so it can be tested on its own; the
 * server wires it to the live world. The dashboard key opens only the
 * `/api/dashboard/*` routes, which only read. It is not an operator token and
 * never reaches `acting()`, so a leaked key cannot arm a snipe, move funds or
 * see a private key — the worst it does is show balances.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { MintRecord } from "./ledger";

/** Shortest key the dashboard will accept — the same floor as SNIPE_TOKEN. */
export const DASHBOARD_TOKEN_MIN = 16;

/** True when `header` carries the dashboard key, compared in constant time. */
export function dashboardTokenOk(header: string | undefined, token: string): boolean {
  if (token.length < DASHBOARD_TOKEN_MIN) return false;
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

export interface DashboardWallet {
  label: string;
  address: `0x${string}`;
}

/**
 * The wallets the dashboard names outright — the treasury, the funding wallet —
 * from `SNIPE_DASHBOARD_WALLETS`: `Main:0xabc…,Funding:0xdef…`, or bare
 * addresses. A malformed entry is skipped rather than failing the list, and a
 * repeated address is kept once.
 */
export function parseDashboardWallets(raw: string | undefined): DashboardWallet[] {
  const out: DashboardWallet[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const colon = item.lastIndexOf(":");
    const label = colon > 0 ? item.slice(0, colon).trim() : "";
    const address = (colon > 0 ? item.slice(colon + 1) : item).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label || `Wallet ${out.length + 1}`, address: address as `0x${string}` });
  }
  return out;
}

export interface RunRow {
  at: number;
  collection: `0x${string}`;
  name?: string;
  stage: string;
  /** Wallets that took part (anything but "skipped"). */
  tried: number;
  /** Wallets that came away with a token. */
  won: number;
  tokens: number;
  gasWei: string;
  valueWei: string;
  outcome: "won" | "partial" | "missed";
}

/**
 * The mint ledger as a feed: newest first, one row per run, with the numbers a
 * notification needs — "100 wallets tried, 30 won, 30 tokens".
 */
export function summariseRuns(records: readonly MintRecord[], limit = 100): RunRow[] {
  const rows = records.map((r): RunRow => {
    const inRun = r.wallets.filter((w) => w.status !== "skipped");
    const won = inRun.filter((w) => w.tokenIds.length > 0 || w.status === "mined").length;
    let gas = 0n;
    let value = 0n;
    let tokens = 0;
    for (const w of r.wallets) {
      gas += BigInt(w.gasWei || "0");
      value += BigInt(w.valueWei || "0");
      tokens += w.tokenIds.length;
    }
    return {
      at: r.at,
      collection: r.collection,
      name: r.collectionName,
      stage: r.stage,
      tried: inRun.length,
      won,
      tokens,
      gasWei: gas.toString(),
      valueWei: value.toString(),
      outcome: won === 0 ? "missed" : won === inRun.length ? "won" : "partial",
    };
  });
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, Math.max(0, limit));
}

/** One sample of what the world holds, for the balance-over-time line. */
export interface BalancePoint {
  /** Unix milliseconds. */
  at: number;
  /** Sum across the sniping wallets, in wei. */
  walletsWei: string;
  /** Sum across the named dashboard wallets, in wei. */
  mainWei: string;
}

export function balanceHistoryPath(configPath: string): string {
  return `${resolve(configPath)}.balances.jsonl`;
}

/**
 * Append one sample. Never throws: a full disk costs a point on a chart, never
 * the server — this box has run out of space before.
 */
export function appendBalancePoint(configPath: string, point: BalancePoint): void {
  try {
    appendFileSync(balanceHistoryPath(configPath), `${JSON.stringify(point)}\n`, { mode: 0o600 });
  } catch {
    /* a missed sample is a gap in the line, nothing more */
  }
}

/** Every sample, oldest first. A line that won't parse is skipped. */
export function loadBalanceHistory(configPath: string): BalancePoint[] {
  let text: string;
  try {
    text = readFileSync(balanceHistoryPath(configPath), "utf8");
  } catch {
    return [];
  }
  const out: BalancePoint[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as BalancePoint;
      if (
        typeof p.at === "number" &&
        /^\d+$/.test(String(p.walletsWei)) &&
        /^\d+$/.test(String(p.mainWei))
      ) {
        out.push(p);
      }
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * At most `max` points, evenly spaced, always keeping the first and the last —
 * a year of half-hourly samples is too many to draw and the endpoints are the
 * two a reader looks at.
 */
export function downsample<T>(points: readonly T[], max: number): T[] {
  if (max <= 0) return [];
  if (points.length <= max) return [...points];
  if (max === 1) return [points[points.length - 1]];
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// ── Counting profit from a chosen moment ───────────────────────────────────
//
// The owner can draw a line: "profit starts here". Everything before it —
// mints, their gas, sales of what they bought, the runs in the feed — drops
// out of the dashboard, so it shows a clean slate instead of history that no
// longer matters. The operator's own profit panel is untouched; this only
// cuts what the dashboard serves.

export interface DashboardSettings {
  /** Unix seconds. Profit and history before this are not shown. */
  profitSince?: number;
}

export function dashboardSettingsPath(configPath: string): string {
  return `${resolve(configPath)}.dashboard.json`;
}

export function loadDashboardSettings(configPath: string): DashboardSettings {
  try {
    const v = JSON.parse(readFileSync(dashboardSettingsPath(configPath), "utf8")) as DashboardSettings;
    return typeof v.profitSince === "number" && v.profitSince > 0 ? { profitSince: Math.floor(v.profitSince) } : {};
  } catch {
    return {};
  }
}

export function saveDashboardSettings(configPath: string, s: DashboardSettings): void {
  const target = dashboardSettingsPath(configPath);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

export interface ProfitEvent {
  collection: string;
  kind: "mint" | "sale";
  /** Unix seconds. */
  at: number;
  /** Signed wei: negative for a mint (gas + price), positive for a sale. */
  wei: string;
  tokens: number;
  wallet?: string;
}

export interface ProfitCollection {
  collection: string;
  heldTokens?: number;
  lastAt?: number;
  [k: string]: unknown;
}

/**
 * The profit report as if it began at `sinceSec`.
 *
 * A collection stays only if it was minted at or after the line. Its spend is
 * what those mints cost (plus the gas burned by reverted attempts the ledger
 * saw after the line), its revenue the sales after the line. What it still
 * holds counts in full when every mint of it came after the line; otherwise
 * only as many as were minted after it and not yet sold — old inventory does
 * not get to sneak back in as held value.
 */
export interface CutCollection extends ProfitCollection {
  cost?: { gasWei: string; priceWei: string; tokens: number; wallets: number };
  revenueWei?: string;
  netWei?: string;
  soldTokens?: number;
  runs?: number;
}

export function cutProfitSince<B extends { collections?: unknown; events?: unknown }>(
  body: B,
  sinceSec: number | undefined,
  ledger: { collection: string; failedGasWei: bigint; runs: number; lastAt: number }[] = [],
): Omit<B, "collections" | "events"> & {
  collections: CutCollection[];
  events: ProfitEvent[];
  profitSince: number | null;
} {
  if (!sinceSec) {
    return {
      ...body,
      collections: (Array.isArray(body.collections) ? body.collections : []) as CutCollection[],
      events: (Array.isArray(body.events) ? body.events : []) as ProfitEvent[],
      profitSince: null,
    };
  }
  const all = (Array.isArray(body.events) ? body.events : []) as ProfitEvent[];
  const events = all.filter((e) => e.at >= sinceSec);
  const firstMint = new Map<string, number>();
  for (const e of all) {
    if (e.kind !== "mint") continue;
    const k = e.collection.toLowerCase();
    firstMint.set(k, Math.min(firstMint.get(k) ?? Infinity, e.at));
  }
  const per = new Map<string, { spent: bigint; minted: number; wallets: Set<string>; revenue: bigint; sold: number }>();
  for (const e of events) {
    const k = e.collection.toLowerCase();
    const p = per.get(k) ?? { spent: 0n, minted: 0, wallets: new Set<string>(), revenue: 0n, sold: 0 };
    const wei = BigInt(e.wei || "0");
    if (e.kind === "mint") {
      p.spent += -wei;
      p.minted += e.tokens || 0;
      if (e.wallet) p.wallets.add(e.wallet.toLowerCase());
    } else {
      p.revenue += wei;
      p.sold += 1;
    }
    per.set(k, p);
  }
  const led = new Map(ledger.map((l) => [l.collection.toLowerCase(), l]));
  const collections = ((Array.isArray(body.collections) ? body.collections : []) as ProfitCollection[])
    .filter((c) => (per.get(c.collection.toLowerCase())?.minted ?? 0) > 0 || led.has(c.collection.toLowerCase()))
    .map((c) => {
      const k = c.collection.toLowerCase();
      const p = per.get(k) ?? { spent: 0n, minted: 0, wallets: new Set<string>(), revenue: 0n, sold: 0 };
      const l = led.get(k);
      const spent = p.spent + (l?.failedGasWei ?? 0n);
      const heldNow = c.heldTokens ?? 0;
      const allAfter = (firstMint.get(k) ?? Infinity) >= sinceSec;
      const held = allAfter ? heldNow : Math.min(heldNow, Math.max(0, p.minted - p.sold));
      return {
        ...c,
        // Mint events carry gas and price together, so the cut keeps them as
        // one figure; the dashboard only ever shows their sum.
        cost: { gasWei: spent.toString(), priceWei: "0", tokens: p.minted, wallets: p.wallets.size },
        revenueWei: p.revenue.toString(),
        netWei: (p.revenue - spent).toString(),
        soldTokens: p.sold,
        heldTokens: held,
        runs: l?.runs ?? 0,
        lastAt: l && l.lastAt >= sinceSec * 1000 ? l.lastAt : undefined,
      };
    });
  return { ...body, collections, events, profitSince: sinceSec };
}
