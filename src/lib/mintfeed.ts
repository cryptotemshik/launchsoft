/**
 * Live mint feed — read recent SeaDropMint logs emitted by the canonical
 * SeaDrop contract from a Blockscout v2 API, decode them, and aggregate a
 * "what's minting right now" view (newest mints + trending collections).
 *
 * SeaDropMint(nftContract indexed, minter indexed, feeRecipient indexed,
 *             payer, quantityMinted, unitMintPrice, feeBps, dropStageIndex)
 * → indexed args live in topics[1..3]; the four non-indexed words live in data.
 */

import { fetchJson } from "./blockscout";

export const SEADROP_MINT_TOPIC =
  "0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6";

export interface RawLog {
  topics?: (string | null)[];
  data?: string | null;
  block_timestamp?: string | null;
  transaction_hash?: string | null;
  block_number?: number | string | null;
  index?: number | string | null;
}

export interface MintEvent {
  /** Stable dedupe key: tx + log index. */
  id: string;
  collection: `0x${string}`;
  minter: `0x${string}`;
  quantity: number;
  unitPriceWei: bigint;
  txHash: string;
  block: number;
  /** Unix seconds. */
  t: number;
}

/** Last 20 bytes of a 32-byte topic → an address. */
function topicToAddress(topic?: string | null): `0x${string}` | null {
  if (!topic) return null;
  const hex = topic.startsWith("0x") ? topic.slice(2) : topic;
  if (hex.length < 40) return null;
  return `0x${hex.slice(-40).toLowerCase()}` as `0x${string}`;
}

/** The N-th 32-byte word of a data blob as an unsigned integer. */
export function dataWord(data: string | null | undefined, index: number): bigint {
  if (!data) return 0n;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const word = hex.slice(index * 64, index * 64 + 64);
  if (word.length < 64) return 0n;
  try {
    return BigInt(`0x${word}`);
  } catch {
    return 0n;
  }
}

export function decodeMintLog(log: RawLog): MintEvent | null {
  const topics = log.topics ?? [];
  if ((topics[0] ?? "").toLowerCase() !== SEADROP_MINT_TOPIC) return null;
  const collection = topicToAddress(topics[1]);
  const minter = topicToAddress(topics[2]);
  if (!collection || !minter) return null;

  // data words: [0]=payer [1]=quantityMinted [2]=unitMintPrice [3]=feeBps [4]=dropStageIndex
  const quantity = Number(dataWord(log.data, 1));
  const unitPriceWei = dataWord(log.data, 2);
  const t = log.block_timestamp
    ? Math.floor(new Date(log.block_timestamp).getTime() / 1000)
    : 0;

  return {
    id: `${log.transaction_hash ?? ""}:${log.index ?? "0"}`,
    collection,
    minter,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
    unitPriceWei,
    txHash: log.transaction_hash ?? "",
    block: Number(log.block_number ?? 0),
    t,
  };
}

export interface FeedStats {
  /** Number of mint events (≈ mint transactions) in the window. */
  mints: number;
  /** Total NFTs minted. */
  quantity: number;
  /** Distinct minter wallets. */
  minters: number;
  /** Distinct collections. */
  collections: number;
}

export function feedStats(events: MintEvent[]): FeedStats {
  const minters = new Set<string>();
  const collections = new Set<string>();
  let quantity = 0;
  for (const e of events) {
    minters.add(e.minter);
    collections.add(e.collection);
    quantity += e.quantity;
  }
  return {
    mints: events.length,
    quantity,
    minters: minters.size,
    collections: collections.size,
  };
}

export interface TrendingRow {
  collection: `0x${string}`;
  /** Mint events for this collection. */
  mints: number;
  /** NFTs minted. */
  quantity: number;
  /** Distinct minters. */
  minters: number;
  /** Σ quantity × unit price. */
  volumeWei: bigint;
  /** Newest mint time (unix seconds). */
  lastT: number;
}

/**
 * Group mint events by collection, ranked by NFTs minted then unique minters —
 * "fastest / most minted" first.
 */
export function aggregateTrending(events: MintEvent[]): TrendingRow[] {
  const map = new Map<
    string,
    {
      collection: `0x${string}`;
      mints: number;
      quantity: number;
      minters: Set<string>;
      volumeWei: bigint;
      lastT: number;
    }
  >();
  for (const e of events) {
    const key = e.collection;
    let row = map.get(key);
    if (!row) {
      row = {
        collection: e.collection,
        mints: 0,
        quantity: 0,
        minters: new Set(),
        volumeWei: 0n,
        lastT: 0,
      };
      map.set(key, row);
    }
    row.mints += 1;
    row.quantity += e.quantity;
    row.minters.add(e.minter);
    row.volumeWei += BigInt(e.quantity) * e.unitPriceWei;
    if (e.t > row.lastT) row.lastT = e.t;
  }
  return [...map.values()]
    .map((r) => ({
      collection: r.collection,
      mints: r.mints,
      quantity: r.quantity,
      minters: r.minters.size,
      volumeWei: r.volumeWei,
      lastT: r.lastT,
    }))
    .sort(
      (a, b) =>
        b.quantity - a.quantity ||
        b.minters - a.minters ||
        b.lastT - a.lastT,
    );
}

/** Dedupe + sort a fetched batch, newest first. */
export function mergeMints(
  prior: MintEvent[],
  incoming: MintEvent[],
  cap = 120,
): MintEvent[] {
  const byId = new Map<string, MintEvent>();
  for (const e of prior) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.t - a.t).slice(0, cap);
}

export async function fetchMintFeed(
  api: string,
  seaDrop: string,
): Promise<MintEvent[]> {
  const url = `${api}/addresses/${seaDrop}/logs?topic=${SEADROP_MINT_TOPIC}`;
  const data = await fetchJson<{ items?: RawLog[] }>(url);
  return (data.items ?? [])
    .map(decodeMintLog)
    .filter((e): e is MintEvent => e !== null);
}
