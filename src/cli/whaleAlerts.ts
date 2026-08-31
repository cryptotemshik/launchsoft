/**
 * The rolling tally behind Whale Alert: which whales entered which collection,
 * lately, and when that crosses "three or more" into a report.
 *
 * The server's poller feeds acquisitions in (whaleWatch.ts turns chain logs
 * into them); this keeps a per-collection set of whales seen inside a window,
 * forgets the stale, and answers "which collections now have N+ distinct
 * whales". It also remembers the highest count it has already announced per
 * collection, so a Telegram/report fires once when the third whale lands and
 * again for the fourth — never on every poll.
 *
 * Persisted beside the config (JSON), so a restart does not lose an alert that
 * is still inside its window, and the poller resumes from the last block it
 * scanned instead of re-reading the chain.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Acquisition } from "../lib/whaleWatch";

export const DEFAULT_MIN_WHALES = 3;
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Seen {
  at: number;
  minted: boolean;
}
interface Stored {
  lastBlock: number;
  /** contract → whale → last time that whale was seen entering it. */
  byCollection: Record<string, Record<string, Seen>>;
  /** contract → the whale-count we last announced, so we only report increases. */
  announced: Record<string, number>;
}

export interface WhaleAlert {
  contract: `0x${string}`;
  whales: string[];
  count: number;
  firstAt: number;
  lastAt: number;
  /** How many of those entries were mints rather than buys. */
  minted: number;
}

const EMPTY: Stored = { lastBlock: 0, byCollection: {}, announced: {} };

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.whalealerts.json`;
}

export function loadWhaleAlerts(configPath: string): Stored {
  try {
    const raw = JSON.parse(readFileSync(pathFor(configPath), "utf8")) as Partial<Stored>;
    return {
      lastBlock: typeof raw.lastBlock === "number" ? raw.lastBlock : 0,
      byCollection: raw.byCollection && typeof raw.byCollection === "object" ? raw.byCollection : {},
      announced: raw.announced && typeof raw.announced === "object" ? raw.announced : {},
    };
  } catch {
    return { ...EMPTY, byCollection: {}, announced: {} };
  }
}

function save(configPath: string, s: Stored): void {
  const target = pathFor(configPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, target);
}

export function getLastBlock(configPath: string): number {
  return loadWhaleAlerts(configPath).lastBlock;
}

export function setLastBlock(configPath: string, block: number): void {
  const s = loadWhaleAlerts(configPath);
  s.lastBlock = block;
  save(configPath, s);
}

/** Fold new acquisitions in, keeping each whale's latest sighting per collection. */
export function recordAcquisitions(
  configPath: string,
  acqs: readonly Acquisition[],
  nowMs = Date.now(),
): Stored {
  const s = loadWhaleAlerts(configPath);
  for (const a of acqs) {
    const coll = (s.byCollection[a.contract] ??= {});
    coll[a.whale] = { at: nowMs, minted: a.minted };
  }
  save(configPath, s);
  return s;
}

/** Drop whales (and empty collections) older than the window. Cheap; call on a timer. */
export function prune(configPath: string, windowMs = DEFAULT_WINDOW_MS, nowMs = Date.now()): void {
  const s = loadWhaleAlerts(configPath);
  for (const [coll, whales] of Object.entries(s.byCollection)) {
    for (const [whale, seen] of Object.entries(whales)) {
      if (nowMs - seen.at > windowMs) delete whales[whale];
    }
    if (Object.keys(whales).length === 0) {
      delete s.byCollection[coll];
      delete s.announced[coll];
    }
  }
  save(configPath, s);
}

function groupsFrom(s: Stored, minWhales: number, windowMs: number, nowMs: number): WhaleAlert[] {
  const out: WhaleAlert[] = [];
  for (const [contract, whales] of Object.entries(s.byCollection)) {
    const live = Object.entries(whales).filter(([, seen]) => nowMs - seen.at <= windowMs);
    if (live.length < minWhales) continue;
    const times = live.map(([, seen]) => seen.at);
    out.push({
      contract: contract as `0x${string}`,
      whales: live.map(([w]) => w),
      count: live.length,
      firstAt: Math.min(...times),
      lastAt: Math.max(...times),
      minted: live.filter(([, seen]) => seen.minted).length,
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/** Collections that currently have minWhales+ distinct whales, newest first. */
export function currentAlerts(
  configPath: string,
  opts: { minWhales?: number; windowMs?: number; nowMs?: number } = {},
): WhaleAlert[] {
  const minWhales = opts.minWhales ?? DEFAULT_MIN_WHALES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  return groupsFrom(loadWhaleAlerts(configPath), minWhales, windowMs, nowMs);
}

/**
 * The alerts worth announcing now: those whose whale-count has risen past what
 * was last announced for that collection (so the third whale fires once, then
 * the fourth, and a re-poll that changes nothing fires nothing). Records the
 * new high-water marks as a side effect.
 */
export function takeNewAlerts(
  configPath: string,
  opts: { minWhales?: number; windowMs?: number; nowMs?: number } = {},
): WhaleAlert[] {
  const minWhales = opts.minWhales ?? DEFAULT_MIN_WHALES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const s = loadWhaleAlerts(configPath);
  const groups = groupsFrom(s, minWhales, windowMs, nowMs);
  const fresh = groups.filter((g) => g.count > (s.announced[g.contract] ?? 0));
  if (fresh.length > 0) {
    for (const g of fresh) s.announced[g.contract] = g.count;
    save(configPath, s);
  }
  return fresh;
}

/** For tests. */
export function resetWhaleAlerts(configPath: string): void {
  save(configPath, { lastBlock: 0, byCollection: {}, announced: {} });
}
