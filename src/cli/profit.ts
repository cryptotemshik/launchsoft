/**
 * What a drop actually made, worked out from the chain alone.
 *
 * No marketplace API is involved, and that is deliberate: OpenSea's would need
 * a key, would only know about OpenSea, and would stop working the day they
 * changed it. Everything here is visible on-chain to anyone.
 *
 * Cost is the easy half — the runner watched the mint happen and recorded what
 * each transaction spent, in gas and in mint price.
 *
 * Revenue is the interesting half. A sale is not a distinct on-chain event, so
 * it is inferred from its two halves happening together: a token leaves one of
 * our wallets, and in that same block that wallet's balance goes up. The rise
 * is the proceeds. Reading it takes two `eth_getBalance` calls per sale — at
 * the block and the one before — which batch cheaply.
 *
 * Where this is approximate, and honestly so:
 *   - a wallet doing something else in the same block mixes into the delta, so
 *     each sale carries the block it came from and can be checked;
 *   - a token given away shows as a sale worth nothing, which is what it is;
 *   - a sale paid in something other than the chain's own coin is invisible
 *     here, and is reported as an unpriced transfer rather than as zero.
 */
import { formatEther, getAddress, type PublicClient } from "viem";
import { mapWithLimit } from "../lib/rpcRead";

/**
 * Caches for facts that cannot change.
 *
 * A block's timestamp, a transaction's cost and a wallet's balance at a block
 * in the past are all settled history: once read, re-reading them can only
 * return the same answer. Yet the profit report re-read every one of them on
 * every load — several hundred round trips, on a single-threaded server, while
 * every other request waited behind them. That is what made the panel feel
 * like it had stopped connecting.
 *
 * So they are remembered for the life of the process. A first load still pays
 * in full; every load after it pays only for what has happened since. The caps
 * are there so a very long history cannot grow the process without bound —
 * they are far above a realistic drop's worth of blocks.
 */
const blockTimeCache = new Map<string, number>();
const txCostCache = new Map<string, { valueWei: bigint; gasWei: bigint }>();
const balanceRiseCache = new Map<string, { rise: bigint; priced: boolean }>();
const CACHE_CAP = 50_000;

/** Forget the oldest entries once a cache grows past its cap. */
function trim<K, V>(cache: Map<K, V>): void {
  if (cache.size <= CACHE_CAP) return;
  const over = cache.size - CACHE_CAP;
  let i = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (++i >= over) break;
  }
}

/**
 * Empty every cache.
 *
 * The server calls this when someone asks for a genuinely fresh report, and
 * the tests call it between cases — the caches are keyed by real hashes and
 * block numbers, which never repeat with different contents in the wild, but
 * a fixture reusing `0xtx1` for two different transactions certainly does.
 */
export function clearProfitCaches(): void {
  blockTimeCache.clear();
  txCostCache.clear();
  balanceRiseCache.clear();
}

export interface MintCost {
  /** Wei spent on gas across every mint transaction. */
  gasWei: bigint;
  /** Wei paid to the contract as the mint price. */
  priceWei: bigint;
  tokens: number;
  wallets: number;
}

export interface SaleEvent {
  wallet: `0x${string}`;
  /** Which contract the token belongs to — one scan covers many. */
  collection: `0x${string}`;
  tokenId: string;
  blockNumber: bigint;
  txHash: string;
  /** Wei the wallet's balance rose by in that block. Zero for a gift. */
  proceedsWei: bigint;
  /**
   * False when the node could not be asked what the balance was then, so the
   * zero above means "unknown", not "free". Pricing a sale needs the balance
   * at a historical block, which only an archive node keeps — Robinhood
   * Chain's public RPC answers `metadata is not found` for anything old.
   */
  priced: boolean;
}

export interface ProfitReport {
  collection: `0x${string}`;
  collectionName?: string;
  cost: MintCost;
  sales: SaleEvent[];
  soldTokens: number;
  revenueWei: bigint;
  /** revenue − cost. Negative until enough has sold to cover the mint. */
  netWei: bigint;
  /** Still held, so still unrealised. */
  heldTokens: number;
  /**
   * Sales the node would not price. Revenue excludes them, so the figure is a
   * floor rather than a guess — and saying how many are missing is the
   * difference between an underestimate and a wrong number.
   */
  unpricedSales: number;
}

/** A token leaving one of our wallets — the half of a sale we can see in logs. */
export interface OutgoingTransfer {
  wallet: `0x${string}`;
  collection: `0x${string}`;
  tokenId: string;
  blockNumber: bigint;
  txHash: string;
  /** Where it went. A transfer to another of our own wallets is not a sale. */
  to: `0x${string}`;
}

/**
 * Turn outgoing transfers into sales by pricing each one from the seller's
 * balance change in that block.
 *
 * Transfers between our own wallets are dropped first — moving a token to the
 * wallet you list from is not a sale, and counting it as one would invent
 * revenue out of a gas fee.
 */
export async function priceTransfers(
  client: PublicClient,
  transfers: readonly OutgoingTransfer[],
  ourWallets: readonly `0x${string}`[],
): Promise<SaleEvent[]> {
  const ours = new Set(ourWallets.map((w) => w.toLowerCase()));
  const external = transfers.filter((t) => !ours.has(t.to.toLowerCase()));
  if (external.length === 0) return [];

  // One balance pair per (wallet, block): several tokens can sell in one
  // transaction, and the rise covers all of them together.
  const pairs = new Map<string, { wallet: `0x${string}`; blockNumber: bigint }>();
  for (const t of external) {
    pairs.set(`${t.wallet.toLowerCase()}@${t.blockNumber}`, {
      wallet: t.wallet,
      blockNumber: t.blockNumber,
    });
  }

  const keys = [...pairs.keys()];
  // The balance a wallet held at a block that has already passed does not
  // change, so a sale priced once stays priced.
  const unknown = keys.filter((k) => !balanceRiseCache.has(k));
  const deltas = await mapWithLimit(unknown, async (key) => {
    const { wallet, blockNumber } = pairs.get(key)!;
    try {
      const [after, before] = await Promise.all([
        client.getBalance({ address: wallet, blockNumber }),
        client.getBalance({ address: wallet, blockNumber: blockNumber - 1n }),
      ]);
      // Only a rise is proceeds. A fall means the wallet spent more on gas than
      // it took, which is a transfer out, not a sale.
      return { rise: after > before ? after - before : 0n, priced: true };
    } catch {
      // A node without archive state cannot say. Reporting that is honest;
      // reporting zero would quietly understate the drop.
      return { rise: 0n, priced: false };
    }
  });

  unknown.forEach((k, i) => {
    // An unpriced sale is not cached — a node with archive state may answer
    // next time, and caching "unknown" would make that permanent.
    if (deltas[i].priced) balanceRiseCache.set(k, deltas[i]);
  });
  trim(balanceRiseCache);
  const riseByKey = new Map(
    keys.map((k) => [k, balanceRiseCache.get(k) ?? { rise: 0n, priced: false }]),
  );
  const countByKey = new Map<string, number>();
  for (const t of external) {
    const k = `${t.wallet.toLowerCase()}@${t.blockNumber}`;
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1);
  }

  return external.map((t) => {
    const k = `${t.wallet.toLowerCase()}@${t.blockNumber}`;
    const entry = riseByKey.get(k) ?? { rise: 0n, priced: false };
    // Split evenly between tokens that left together — the chain does not say
    // which of them was worth what.
    const share = entry.rise / BigInt(countByKey.get(k) ?? 1);
    return {
      wallet: getAddress(t.wallet),
      collection: getAddress(t.collection),
      tokenId: t.tokenId,
      blockNumber: t.blockNumber,
      txHash: t.txHash,
      proceedsWei: share,
      priced: entry.priced,
    };
  });
}

/** A token arriving from the zero address — the visible half of a mint. */
export interface MintTransfer {
  wallet: `0x${string}`;
  collection: `0x${string}`;
  tokenId: string;
  blockNumber: bigint;
  txHash: string;
}

/** One transaction that minted, and what it cost. */
export interface MintTx {
  collection: `0x${string}`;
  wallet: `0x${string}`;
  txHash: string;
  blockNumber: bigint;
  /** How many tokens of this collection it minted. */
  tokens: number;
  gasWei: bigint;
  priceWei: bigint;
}

/**
 * What the mints themselves cost, read from their transactions.
 *
 * The local ledger only knows about runs this server made, so a drop minted
 * before it existed — or from another machine — showed a blank cost and a
 * profit equal to its revenue. The chain knows about all of them: every token
 * that arrived from the zero address came in a transaction, and that
 * transaction says what it paid the contract and what its gas cost.
 *
 * One transaction usually mints several tokens for one wallet, so the reads
 * are per transaction, not per token — reading per token would multiply a
 * drop's cost by its quantity. Where a single transaction touched two
 * collections its cost is split between them by token count, which is the only
 * split the chain supports.
 */
export async function readMintTxs(
  client: PublicClient,
  mints: readonly MintTransfer[],
): Promise<MintTx[]> {
  if (mints.length === 0) return [];

  const hashes = [...new Set(mints.map((m) => m.txHash).filter(Boolean))];
  // A mined transaction's value and gas are settled — read each hash once,
  // ever.
  const missing = hashes.filter((h) => !txCostCache.has(h));
  const costs = await mapWithLimit(missing, async (hash) => {
    try {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash: hash as `0x${string}` }),
        client.getTransactionReceipt({ hash: hash as `0x${string}` }),
      ]);
      const gasPrice = receipt.effectiveGasPrice ?? tx.gasPrice ?? 0n;
      return { valueWei: tx.value ?? 0n, gasWei: receipt.gasUsed * gasPrice, ok: true };
    } catch {
      // A pruned node may not have the transaction any more. Counting it as
      // free would overstate profit, but inventing a number is worse — so it
      // contributes nothing and the token still counts as minted.
      return { valueWei: 0n, gasWei: 0n, ok: false };
    }
  });
  missing.forEach((h, i) => {
    if (costs[i].ok) txCostCache.set(h, { valueWei: costs[i].valueWei, gasWei: costs[i].gasWei });
  });
  trim(txCostCache);
  const byHash = new Map(
    hashes.map((h) => [h, txCostCache.get(h) ?? { valueWei: 0n, gasWei: 0n }]),
  );

  // Group by transaction and collection: one row per (tx, collection).
  const rows = new Map<string, MintTx>();
  const perTx = new Map<string, number>();
  for (const m of mints) perTx.set(m.txHash, (perTx.get(m.txHash) ?? 0) + 1);

  for (const m of mints) {
    const key = `${m.txHash}#${m.collection.toLowerCase()}`;
    const row =
      rows.get(key) ??
      ({
        collection: getAddress(m.collection),
        wallet: getAddress(m.wallet),
        txHash: m.txHash,
        blockNumber: m.blockNumber,
        tokens: 0,
        gasWei: 0n,
        priceWei: 0n,
      } satisfies MintTx);
    row.tokens += 1;
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    const all = BigInt(perTx.get(row.txHash) ?? row.tokens);
    const cost = byHash.get(row.txHash) ?? { valueWei: 0n, gasWei: 0n };
    // This collection's share of a transaction that may have minted others.
    row.gasWei = (cost.gasWei * BigInt(row.tokens)) / all;
    row.priceWei = (cost.valueWei * BigInt(row.tokens)) / all;
  }
  return [...rows.values()].sort((a, b) => Number(a.blockNumber - b.blockNumber));
}

/** Roll mint transactions up per collection. */
export function costByMintTx(txs: readonly MintTx[]): Map<string, MintCost> {
  const out = new Map<string, MintCost>();
  const walletsPer = new Map<string, Set<string>>();
  for (const t of txs) {
    const key = t.collection.toLowerCase();
    const acc =
      out.get(key) ?? ({ gasWei: 0n, priceWei: 0n, tokens: 0, wallets: 0 } satisfies MintCost);
    acc.gasWei += t.gasWei;
    acc.priceWei += t.priceWei;
    acc.tokens += t.tokens;
    out.set(key, acc);
    const seen = walletsPer.get(key) ?? new Set<string>();
    seen.add(t.wallet.toLowerCase());
    walletsPer.set(key, seen);
  }
  for (const [key, acc] of out) acc.wallets = walletsPer.get(key)?.size ?? 0;
  return out;
}

/** What each collection's mints cost, straight from the chain. */
export async function priceMints(
  client: PublicClient,
  mints: readonly MintTransfer[],
): Promise<Map<string, MintCost>> {
  return costByMintTx(await readMintTxs(client, mints));
}

/**
 * When each of these blocks happened.
 *
 * A profit line needs a time axis, and a block number is not one. Interpolating
 * from an average block time would be cheaper and wrong — this chain produces
 * blocks on demand, so an hour of quiet and an hour of a drop cover very
 * different spans. So the timestamps are read, deduplicated and batched.
 */
export async function blockTimes(
  client: PublicClient,
  blocks: readonly bigint[],
): Promise<Map<string, number>> {
  const unique = [...new Set(blocks.map(String))];
  // Only the ones nobody has looked up yet — a block's timestamp is fixed the
  // moment the block exists, so a second read can only cost time.
  const missing = unique.filter((n) => !blockTimeCache.has(n));
  const times = await mapWithLimit(missing, async (n) => {
    try {
      const b = await client.getBlock({ blockNumber: BigInt(n) });
      return Number(b.timestamp);
    } catch {
      return 0;
    }
  });
  missing.forEach((n, i) => {
    // A failed read is not cached: it can succeed next time.
    if (times[i] > 0) blockTimeCache.set(n, times[i]);
  });
  trim(blockTimeCache);
  return new Map(unique.map((n) => [n, blockTimeCache.get(n) ?? 0]));
}

/** Assemble the report. Pure arithmetic — the reading already happened. */
export function summarise(
  collection: `0x${string}`,
  cost: MintCost,
  sales: readonly SaleEvent[],
  heldTokens: number,
  collectionName?: string,
): ProfitReport {
  const revenueWei = sales.reduce((n, s) => n + (s.priced ? s.proceedsWei : 0n), 0n);
  return {
    collection,
    collectionName,
    cost,
    sales: [...sales],
    soldTokens: sales.length,
    revenueWei,
    netWei: revenueWei - cost.gasWei - cost.priceWei,
    heldTokens,
    unpricedSales: sales.filter((s) => !s.priced).length,
  };
}

/** ETH with enough places to see a gas figure, without a wall of zeros. */
export function eth(wei: bigint, places = 6): string {
  const s = formatEther(wei);
  const [whole, frac = ""] = s.split(".");
  return frac ? `${whole}.${frac.slice(0, places).padEnd(places, "0")}` : whole;
}
