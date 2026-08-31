/**
 * The service-wide list of whales worth watching.
 *
 * Unlike a personal tracker, this is not per-account — it is the same for
 * everyone, maintained by the owner from the admin panel (which seeds it from a
 * collection's biggest holders). A whale is just an address the service
 * considers big enough that its moves are a signal. Reading it is a Pro feature
 * (the route enforces that); this module is only the store.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Whale {
  address: `0x${string}`;
  /** An optional name — a known handle, or why it is watched (e.g. "8.2 ETH"). */
  label?: string;
  addedAt: number;
}

export interface Curated {
  whales: Whale[];
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

function norm(address: string): `0x${string}` {
  const lower = address.toLowerCase();
  if (!ADDRESS.test(lower)) throw new Error(`not a wallet address: ${address}`);
  return lower as `0x${string}`;
}

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.curated.json`;
}

export function loadCurated(configPath: string): Curated {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pathFor(configPath), "utf8"));
  } catch {
    return { whales: [] };
  }
  const c = raw as Partial<Curated>;
  return {
    whales: Array.isArray(c.whales)
      ? c.whales.filter((w): w is Whale => Boolean(w && ADDRESS.test(String((w as Whale).address))))
      : [],
  };
}

function save(configPath: string, c: Curated): void {
  const target = pathFor(configPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, target);
}

export function addWhale(
  configPath: string,
  address: string,
  label?: string,
  nowMs = Date.now(),
): Curated {
  const addr = norm(address);
  const c = loadCurated(configPath);
  const existing = c.whales.find((w) => w.address === addr);
  if (existing) {
    // Re-adding with a fresh label (e.g. an updated balance) refreshes it.
    if (label?.trim()) existing.label = label.trim();
  } else {
    c.whales.push({ address: addr, label: label?.trim() || undefined, addedAt: nowMs });
  }
  save(configPath, c);
  return c;
}

export function removeWhale(configPath: string, address: string): Curated {
  const addr = norm(address);
  const c = loadCurated(configPath);
  const next = { whales: c.whales.filter((w) => w.address !== addr) };
  save(configPath, next);
  return next;
}
