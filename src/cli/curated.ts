/**
 * Two hand-curated lists the whole service shares: whales to watch, and
 * influencers worth following.
 *
 * Unlike a personal tracker, these are not per-account — they are the same for
 * everyone, maintained by the owner from the admin panel. A whale is just an
 * address the service considers big enough that its moves are a signal; an
 * influencer is a named, vouched-for account whose holdings other people want
 * to see. Both are Pro-only to read (the routes enforce that); this module is
 * only the store.
 *
 * Kept deliberately small and admin-seeded rather than auto-discovered: the
 * "portfolio over $N" crawl that would populate whales automatically is a data
 * pipeline of its own, and a curated list is the honest, working first form —
 * the alert engine that reads it does not care how the addresses got there.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Whale {
  address: `0x${string}`;
  /** An optional name — a known handle, or why it is watched. */
  label?: string;
  addedAt: number;
}

export interface Influencer {
  address: `0x${string}`;
  name: string;
  twitter?: string;
  addedAt: number;
}

export interface Curated {
  whales: Whale[];
  influencers: Influencer[];
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
    return { whales: [], influencers: [] };
  }
  const c = raw as Partial<Curated>;
  return {
    whales: Array.isArray(c.whales)
      ? c.whales.filter((w): w is Whale => Boolean(w && ADDRESS.test(String((w as Whale).address))))
      : [],
    influencers: Array.isArray(c.influencers)
      ? c.influencers.filter(
          (i): i is Influencer =>
            Boolean(i && ADDRESS.test(String((i as Influencer).address)) && (i as Influencer).name),
        )
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
  if (!c.whales.some((w) => w.address === addr)) {
    c.whales.push({ address: addr, label: label?.trim() || undefined, addedAt: nowMs });
    save(configPath, c);
  }
  return c;
}

export function removeWhale(configPath: string, address: string): Curated {
  const addr = norm(address);
  const c = loadCurated(configPath);
  const next = { ...c, whales: c.whales.filter((w) => w.address !== addr) };
  save(configPath, next);
  return next;
}

export function addInfluencer(
  configPath: string,
  address: string,
  name: string,
  twitter?: string,
  nowMs = Date.now(),
): Curated {
  const addr = norm(address);
  if (!name.trim()) throw new Error("an influencer needs a name");
  const c = loadCurated(configPath);
  const existing = c.influencers.find((i) => i.address === addr);
  if (existing) {
    existing.name = name.trim();
    existing.twitter = twitter?.trim().replace(/^@+/, "") || undefined;
  } else {
    c.influencers.push({
      address: addr,
      name: name.trim(),
      twitter: twitter?.trim().replace(/^@+/, "") || undefined,
      addedAt: nowMs,
    });
  }
  save(configPath, c);
  return c;
}

export function removeInfluencer(configPath: string, address: string): Curated {
  const addr = norm(address);
  const c = loadCurated(configPath);
  const next = { ...c, influencers: c.influencers.filter((i) => i.address !== addr) };
  save(configPath, next);
  return next;
}
