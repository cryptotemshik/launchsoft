/**
 * Finding drops before anyone announces them.
 *
 * SeaDrop emits `PublicDropUpdated` every time a creator configures a public
 * stage, and — this is the whole trick — the struct rides along in the event
 * payload. One `eth_getLogs` therefore returns hundreds of collections with
 * price, start, end and per-wallet cap already attached, with no per-collection
 * read needed to decide which are worth looking at.
 *
 * Only the survivors of that filter get enriched with name and supply.
 *
 * Allow-list stages cannot leak in: this event, and `getPublicDrop`, describe
 * the public stage alone. Allow-list phases live behind a separate merkle-root
 * path on the same contract, so there is no filtering step that could pick the
 * wrong one — the wrong one is unreachable.
 *
 * Everything here is pure. The reads live in cli/dropScanner.ts.
 */

/** SeaDrop 1.0, same address on every chain it is deployed to. */
export const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5" as const;

/**
 * The event, as an ABI item. Written out rather than hand-decoded from topic
 * strings: viem computes the topic hash from this and decodes the struct, so a
 * change in the struct is a type error rather than four silently wrong words.
 */
export const PUBLIC_DROP_UPDATED =
  "event PublicDropUpdated(address indexed nftContract, (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)" as const;

export interface ScannedDrop {
  contract: `0x${string}`;
  /** Wei. The chain's own coin — never assume it is ETH-priced elsewhere. */
  priceWei: string;
  /** Unix seconds. Zero means the stage has no start configured. */
  startTime: number;
  endTime: number;
  maxPerWallet: number;
  feeBps: number;
  /** Block the configuration was seen in — the newest wins. */
  block: number;
  /** Filled in by enrichment, absent until then. */
  name?: string;
  maxSupply?: number;
  minted?: number;
}

/** What a drop is doing right now. */
export type DropState = "live" | "soon" | "upcoming" | "ended" | "pending";

/** `soon` is the hour class that deserves attention today. */
const SOON_WINDOW = 86_400;

export function classify(d: Pick<ScannedDrop, "startTime" | "endTime">, now: number): DropState {
  if (!d.startTime) return "pending";
  if (now < d.startTime) return d.startTime - now < SOON_WINDOW ? "soon" : "upcoming";
  if (!d.endTime || now < d.endTime) return "live";
  return "ended";
}

/**
 * Nothing left to mint.
 *
 * Worth its own concept because a drop can sell out through its allow-list
 * stages while its public start is still in the future — the chain then
 * reports a future time on a collection with nothing behind it, which is the
 * single most misleading row a scanner can show.
 */
export function isSoldOut(d: Pick<ScannedDrop, "maxSupply" | "minted">): boolean {
  return d.maxSupply !== undefined && d.minted !== undefined && d.minted >= d.maxSupply;
}

/** Sort order for a scan: what is happening, then what is about to. */
const RANK: Record<DropState, number> = { live: 0, soon: 1, upcoming: 2, pending: 3, ended: 4 };

export function sortForScan(drops: readonly ScannedDrop[], now: number): ScannedDrop[] {
  return [...drops].sort((a, b) => {
    const ra = RANK[classify(a, now)];
    const rb = RANK[classify(b, now)];
    if (ra !== rb) return ra - rb;
    // Within a class, soonest first for anything ahead of us, newest-configured
    // first for anything behind.
    if (ra <= 2) return (a.startTime || Infinity) - (b.startTime || Infinity);
    return b.block - a.block;
  });
}

/**
 * One entry per collection: the newest configuration wins.
 *
 * A creator who edits a stage three times emits three events; only the last
 * one describes what will actually happen.
 */
export function latestPerContract(
  events: readonly (Omit<ScannedDrop, "name" | "maxSupply" | "minted">)[],
): ScannedDrop[] {
  const by = new Map<string, ScannedDrop>();
  for (const e of events) {
    const key = e.contract.toLowerCase();
    const prev = by.get(key);
    if (!prev || e.block > prev.block) by.set(key, { ...e });
  }
  return [...by.values()];
}

/**
 * How many blocks cover a span of hours, from a measured rate.
 *
 * Deliberately not a constant: Robinhood Chain runs about 35,600 blocks an
 * hour today, which makes the tidy-looking "500,000 blocks" of the original
 * scanner a fourteen-hour window — a number nobody would have chosen on
 * purpose. Asking in hours and measuring the rate keeps the question in the
 * units a person actually thinks in.
 */
export function blocksForHours(hours: number, blocksPerHour: number): bigint {
  return BigInt(Math.max(1, Math.round(hours * blocksPerHour)));
}

/** Which drops a set of filters keeps. */
export interface ScanFilter {
  state?: DropState | "all";
  hideSoldOut?: boolean;
  freeOnly?: boolean;
  /** Wei, inclusive. */
  maxPriceWei?: bigint;
  minSupply?: number;
  /** Matches name or contract, case-insensitive. */
  search?: string;
}

export function applyFilter(
  drops: readonly ScannedDrop[],
  filter: ScanFilter,
  now: number,
): ScannedDrop[] {
  const q = filter.search?.trim().toLowerCase();
  return drops.filter((d) => {
    if (filter.state && filter.state !== "all" && classify(d, now) !== filter.state) return false;
    if (filter.hideSoldOut && isSoldOut(d)) return false;
    if (filter.freeOnly && BigInt(d.priceWei) !== 0n) return false;
    if (filter.maxPriceWei !== undefined && BigInt(d.priceWei) > filter.maxPriceWei) return false;
    if (filter.minSupply !== undefined && (d.maxSupply ?? 0) < filter.minSupply) return false;
    if (q && !`${d.name ?? ""} ${d.contract}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
