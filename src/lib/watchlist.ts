/**
 * Wallet watchlist — bulk parse, validate, dedupe, and persist the set of
 * addresses the tracker watches. Addresses only; no keys, ever. Stored in
 * localStorage so the list survives reloads (per-browser, client-side).
 */
import { isAddress } from "./convert";

export interface WatchedWallet {
  address: `0x${string}`;
  /** Optional user label (from "0xabc… Alice" or "Alice,0xabc…" lines). */
  label?: string;
  addedAt: number;
}

const KEY = "launchpad.watchlist.v1";

export interface ParseResult {
  wallets: { address: `0x${string}`; label?: string }[];
  invalid: string[];
}

/**
 * Pull wallets out of a bulk blob: one per line, or comma/space/semicolon
 * separated. A line may carry a label alongside the address in any order
 * ("0xabc… whale", "Alice: 0xabc…"). Deduped by address (first label wins).
 */
export function parseWalletBlob(text: string): ParseResult {
  const seen = new Set<string>();
  const wallets: { address: `0x${string}`; label?: string }[] = [];
  const invalid: string[] = [];

  for (const rawLine of text.split(/[\n\r]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/[\s,;|]+/).filter(Boolean);
    const addrTokens = tokens.filter((t) => isAddress(t));
    if (addrTokens.length === 0) {
      invalid.push(line);
      continue;
    }
    // Any non-address text on the line is a shared label for its address(es).
    const label =
      tokens
        .filter((t) => !isAddress(t))
        .join(" ")
        .replace(/[:]+$/, "")
        .trim() || undefined;
    for (const at of addrTokens) {
      const address = at.toLowerCase() as `0x${string}`;
      if (seen.has(address)) continue;
      seen.add(address);
      wallets.push({ address, label });
    }
  }
  return { wallets, invalid };
}

export function loadWatchlist(): WatchedWallet[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WatchedWallet[];
    return Array.isArray(parsed) ? parsed.filter((w) => isAddress(w.address)) : [];
  } catch {
    return [];
  }
}

function save(list: WatchedWallet[]): WatchedWallet[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full / unavailable — keep the in-memory list working.
  }
  return list;
}

/** Merge parsed wallets into the stored set; returns the new list. */
export function addWallets(
  incoming: { address: `0x${string}`; label?: string }[],
): WatchedWallet[] {
  const list = loadWatchlist();
  const byAddr = new Map(list.map((w) => [w.address.toLowerCase(), w]));
  const now = Date.now();
  for (const w of incoming) {
    const key = w.address.toLowerCase();
    const existing = byAddr.get(key);
    if (existing) {
      if (w.label && !existing.label) existing.label = w.label;
    } else {
      byAddr.set(key, {
        address: key as `0x${string}`,
        label: w.label,
        addedAt: now,
      });
    }
  }
  return save([...byAddr.values()]);
}

export function removeWallet(address: string): WatchedWallet[] {
  const key = address.toLowerCase();
  return save(loadWatchlist().filter((w) => w.address.toLowerCase() !== key));
}

export function clearWatchlist(): WatchedWallet[] {
  return save([]);
}
