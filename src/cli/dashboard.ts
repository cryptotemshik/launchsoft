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
import { appendFileSync, readFileSync } from "node:fs";
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
