import type { WalletEvent } from "./activity";

/**
 * Turn a pile of whale wallet-events into "several whales just went into the
 * same thing" signals.
 *
 * The rule the product wants: when three or more distinct whales acquire the
 * same collection inside a window, that is worth shouting about — and every
 * further whale after the third is its own new shout ("a fourth whale just
 * aped in"). So the grouping keeps the ordered list of distinct whales per
 * collection, and the component decides which of those crossings it has
 * already told the user about.
 *
 * Pure: it takes events and returns groups. Fetching the events and firing the
 * notifications belongs to the component; the counting rule lives here where it
 * can be tested.
 */
export interface WhaleGroup {
  /** The collection contract, lower-cased — the stable key. */
  contract: string;
  /** A human name for it, best-effort from the transfers. */
  collection: string;
  /** Distinct whales who acquired it, in the order they first did. */
  whales: string[];
  count: number;
  firstAt: number;
  lastAt: number;
}

/** An acquisition is a mint or a buy — receiving as a gift is not a signal. */
function isAcquisition(e: WalletEvent): boolean {
  return e.kind === "mint" || e.kind === "buy";
}

export interface GroupOptions {
  /** How many distinct whales make a signal. */
  minWhales?: number;
  /** Only count acquisitions this recent (unix seconds). 0 = no window. */
  sinceT?: number;
}

/**
 * Group whale acquisitions by collection, keeping only those that reached the
 * threshold, newest activity first.
 */
export function groupWhaleEntries(
  events: readonly WalletEvent[],
  opts: GroupOptions = {},
): WhaleGroup[] {
  const minWhales = opts.minWhales ?? 3;
  const sinceT = opts.sinceT ?? 0;

  // contract → { name, whales in first-seen order, times }
  const byContract = new Map<
    string,
    { collection: string; order: string[]; seen: Set<string>; firstAt: number; lastAt: number }
  >();

  // Oldest first, so "order of distinct whales" is the order they actually
  // entered — the fourth whale really is the fourth.
  const chron = [...events].filter(isAcquisition).sort((a, b) => a.t - b.t);
  for (const e of chron) {
    const contract = (e.contract ?? e.collection).toLowerCase();
    if (!contract) continue;
    if (sinceT && e.t < sinceT) continue;
    let g = byContract.get(contract);
    if (!g) {
      g = { collection: e.collection, order: [], seen: new Set(), firstAt: e.t, lastAt: e.t };
      byContract.set(contract, g);
    }
    const whale = e.wallet.toLowerCase();
    if (!g.seen.has(whale)) {
      g.seen.add(whale);
      g.order.push(whale);
    }
    g.firstAt = Math.min(g.firstAt, e.t);
    g.lastAt = Math.max(g.lastAt, e.t);
    if (e.collection && g.collection === "NFT") g.collection = e.collection;
  }

  return [...byContract.entries()]
    .map(([contract, g]) => ({
      contract,
      collection: g.collection,
      whales: g.order,
      count: g.order.length,
      firstAt: g.firstAt,
      lastAt: g.lastAt,
    }))
    .filter((g) => g.count >= minWhales)
    .sort((a, b) => b.lastAt - a.lastAt);
}
