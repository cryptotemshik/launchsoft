/**
 * What each drop cost, kept across restarts.
 *
 * Revenue can always be recovered from the chain — the tokens and the balances
 * are still there. Cost cannot: the gas a transaction burned is in a receipt
 * nobody will look up again, and once the queue is gone from memory so is the
 * knowledge that this wallet spent that much on this collection. So the run
 * writes it down as it happens.
 *
 * A flat JSONL file beside the config: append-only, one run per line, readable
 * with `cat`, and impossible to corrupt more than one line of.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MintRecord {
  at: number;
  collection: `0x${string}`;
  collectionName?: string;
  chainId: number;
  stage: string;
  /** Per wallet, so a later report can show who spent what. */
  wallets: {
    address: string;
    tokenIds: string[];
    gasWei: string;
    valueWei: string;
    status: string;
  }[];
}

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.mints.jsonl`;
}

/** Append one finished run. Failure here must never fail the run. */
export function recordMint(configPath: string, record: MintRecord): void {
  try {
    appendFileSync(pathFor(configPath), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // The ledger is a convenience; losing a line costs a profit figure, not a
    // mint.
  }
}

/**
 * Every recorded run, oldest first. A line that won't parse is skipped rather
 * than throwing: one bad line should not hide every good one behind it.
 */
export function loadMints(configPath: string): MintRecord[] {
  let text: string;
  try {
    text = readFileSync(pathFor(configPath), "utf8");
  } catch {
    return [];
  }
  const out: MintRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as MintRecord;
      if (r && typeof r.collection === "string" && Array.isArray(r.wallets)) out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

export interface CollectionCost {
  collection: `0x${string}`;
  collectionName?: string;
  gasWei: bigint;
  priceWei: bigint;
  /**
   * Gas burnt by wallets that came away with nothing — a reverted mint still
   * pays. The chain cannot be asked for this after the fact without knowing
   * which transactions were attempts, so it is the one cost only the ledger
   * knows, and the one it is read for once the rest comes from the chain.
   */
  failedGasWei: bigint;
  tokens: number;
  wallets: number;
  runs: number;
  firstAt: number;
  lastAt: number;
}

/** Roll the ledger up per collection. */
export function costByCollection(records: readonly MintRecord[]): Map<string, CollectionCost> {
  const out = new Map<string, CollectionCost>();
  for (const r of records) {
    const key = r.collection.toLowerCase();
    const acc =
      out.get(key) ??
      ({
        collection: r.collection,
        collectionName: r.collectionName,
        gasWei: 0n,
        priceWei: 0n,
        failedGasWei: 0n,
        tokens: 0,
        wallets: 0,
        runs: 0,
        firstAt: r.at,
        lastAt: r.at,
      } satisfies CollectionCost);

    const walletsThatSpent = new Set<string>();
    for (const w of r.wallets) {
      acc.gasWei += BigInt(w.gasWei || "0");
      acc.priceWei += BigInt(w.valueWei || "0");
      acc.tokens += w.tokenIds.length;
      if (w.tokenIds.length === 0) acc.failedGasWei += BigInt(w.gasWei || "0");
      if (w.gasWei && w.gasWei !== "0") walletsThatSpent.add(w.address.toLowerCase());
    }
    acc.wallets = Math.max(acc.wallets, walletsThatSpent.size);
    acc.runs += 1;
    acc.firstAt = Math.min(acc.firstAt, r.at);
    acc.lastAt = Math.max(acc.lastAt, r.at);
    if (!acc.collectionName && r.collectionName) acc.collectionName = r.collectionName;
    out.set(key, acc);
  }
  return out;
}
