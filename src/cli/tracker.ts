/**
 * The wallets an account tracks, held server-side so alerts can be delivered
 * while nobody has the site open.
 *
 * The tracker itself has always lived in the browser: a watchlist in local
 * storage, polled against the explorer, with a desktop notification. That only
 * fires while the tab is open, and the explorer is Cloudflare-gated to a server
 * anyway — so to push a tracked wallet's moves to Telegram the server needs its
 * own copy of the list and its own way of watching, over RPC. This module is
 * that copy: one small file per account, addresses only, never a key.
 *
 * It is a mirror, not the source of truth — the browser owns the list a person
 * edits and replaces this wholesale when it changes — so it stays deliberately
 * simple: load, replace (deduped and capped), read the scan checkpoint.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface TrackedWallet {
  address: `0x${string}`;
  label?: string;
}

const ADDR = /^0x[0-9a-f]{40}$/;

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.tracker.json`;
}

export function loadTracker(configPath: string): TrackedWallet[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(pathFor(configPath), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTracked).map((w) => ({
      address: w.address.toLowerCase() as `0x${string}`,
      ...(w.label ? { label: String(w.label).slice(0, 60) } : {}),
    }));
  } catch {
    return [];
  }
}

function isTracked(v: unknown): v is TrackedWallet {
  const w = v as Partial<TrackedWallet>;
  return typeof w?.address === "string" && ADDR.test(w.address.toLowerCase());
}

function write(configPath: string, list: TrackedWallet[]): void {
  const target = pathFor(configPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Replace the tracked list, deduped by address and capped.
 *
 * The browser sends the whole list on every change, so this is a wholesale set
 * rather than an add/remove — simpler, and it can't drift from what the person
 * sees. The cap is the tier's limit; anything past it is dropped, first-come,
 * and reported so the caller can say so.
 */
export function setTracker(
  configPath: string,
  entries: readonly { address: string; label?: string }[],
  max: number,
): { stored: TrackedWallet[]; dropped: number } {
  const seen = new Set<string>();
  const clean: TrackedWallet[] = [];
  for (const e of entries) {
    const address = String(e.address ?? "").toLowerCase();
    if (!ADDR.test(address) || seen.has(address)) continue;
    seen.add(address);
    clean.push({
      address: address as `0x${string}`,
      ...(e.label ? { label: String(e.label).slice(0, 60) } : {}),
    });
  }
  const stored = clean.slice(0, Math.max(0, max));
  write(configPath, stored);
  return { stored, dropped: clean.length - stored.length };
}

// ── The scan checkpoint: the last block the tracker sweep has read ───────────
// One global figure, not per account, because the sweep reads every tracked
// wallet in one pass. Persisted so a restart resumes rather than re-scans.
function scanPath(path: string): string {
  return `${resolve(path)}.trackerscan.json`;
}

export function getScanBlock(path: string): number {
  try {
    const r = JSON.parse(readFileSync(scanPath(path), "utf8")) as { block?: number };
    return Number.isFinite(r.block) ? (r.block as number) : 0;
  } catch {
    return 0;
  }
}

export function setScanBlock(path: string, block: number): void {
  const target = scanPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ block })}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}
