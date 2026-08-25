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
  const deltas = await mapWithLimit(keys, async (key) => {
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

  const riseByKey = new Map(keys.map((k, i) => [k, deltas[i]]));
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
      tokenId: t.tokenId,
      blockNumber: t.blockNumber,
      txHash: t.txHash,
      proceedsWei: share,
      priced: entry.priced,
    };
  });
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
