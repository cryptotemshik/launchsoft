/**
 * Shared on-chain / Blockscout data fetching for a SeaDrop collection.
 * Used by the Status tab and the Dashboard.
 */
import { parseAbiItem, zeroAddress, type PublicClient } from "viem";
import type { ChainInfo } from "../chains";
import { ipfsUrl } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { loadLaunchState } from "./launchState";
import {
  computeMintRevenue,
  computeProfit,
  extractSeaportPayoutEvents,
  type InternalTxItem,
  type ProfitBreakdown,
  type TimedAmount,
} from "./profit";

export interface CollectionStatus {
  name: string;
  symbol: string;
  owner: string;
  totalSupply: bigint;
  maxSupply: bigint;
  baseURI: string;
  contractURI: string;
  provenanceHash: string;
  publicDrop: {
    mintPrice: bigint;
    startTime: number;
    endTime: number;
    maxTotalMintableByWallet: number;
    feeBps: number;
    restrictFeeRecipients: boolean;
  };
  creatorPayout: string;
  allowedFeeRecipients: readonly string[];
  royaltyReceiver: string;
  royaltyBps: number;
  transferValidator: string;
}

export interface ProfitData {
  breakdown: ProfitBreakdown;
  ethUsd: number | null;
  /** Creator's mint proceeds as timed deltas (block times resolved/sampled). */
  mintEvents: TimedAmount[];
  /** Royalty payouts (Seaport → receiver) as timed deltas. */
  royaltyEvents: TimedAmount[];
  /** Unix seconds of the contract creation tx; null if unknown. */
  createdAt: number | null;
}

/**
 * Pick the fee recipient a mint call should pass: OpenSea's recipient when
 * the drop doesn't restrict, when it's explicitly allowed, or — for drops
 * that restrict but never got OpenSea into their allow-list — the first
 * allowed address. Returns null when the drop restricts and allows no one,
 * which makes a public mint impossible to construct at all.
 */
export function pickFeeRecipient(
  info: ChainInfo,
  allowedFeeRecipients: readonly string[],
  restrictFeeRecipients: boolean,
): `0x${string}` | null {
  const openSeaFee = info.feeRecipient;
  const allowed = allowedFeeRecipients.map((a) => a.toLowerCase());
  if (openSeaFee && !restrictFeeRecipients) return openSeaFee;
  if (openSeaFee && allowed.includes(openSeaFee.toLowerCase())) return openSeaFee;
  if (allowedFeeRecipients.length > 0) return allowedFeeRecipients[0] as `0x${string}`;
  return null;
}

/**
 * A collection's logo image URI (from its `contractURI` JSON), resolved once
 * and cached — nulls included, so a collection without art isn't re-fetched.
 * Used to put avatars in the Live feed. Returns the raw `image` value (usually
 * an ipfs:// URI); render it through `IpfsImg`.
 */
const collectionImageCache = new Map<string, string | null>();

export async function fetchCollectionImage(
  publicClient: PublicClient,
  contract: `0x${string}`,
): Promise<string | null> {
  const key = contract.toLowerCase();
  const cached = collectionImageCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const uri = (await publicClient.readContract({
      address: contract,
      abi: tokenAbi,
      functionName: "contractURI",
    })) as string;
    if (!uri) {
      collectionImageCache.set(key, null);
      return null;
    }
    let json: unknown;
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      const payload = uri.slice(comma + 1);
      const text = uri.slice(0, comma).includes(";base64")
        ? atob(payload)
        : decodeURIComponent(payload);
      json = JSON.parse(text);
    } else {
      const res = await fetch(ipfsUrl(uri));
      if (!res.ok) {
        collectionImageCache.set(key, null);
        return null;
      }
      json = await res.json();
    }
    const image =
      json && typeof (json as { image?: unknown }).image === "string"
        ? ((json as { image: string }).image)
        : null;
    collectionImageCache.set(key, image);
    return image;
  } catch {
    collectionImageCache.set(key, null);
    return null;
  }
}

export const seaDropMintEvent = parseAbiItem(
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
);

/**
 * How many have been minted, asked whichever way this collection can answer.
 *
 * Not every collection on this chain answers `totalSupply()`. Hoodwinked
 * (0xc60079d7…) reverts on it with 426 of 3000 minted and rising, so this is
 * not a not-started-yet edge case and not something a collection grows out
 * of — why that build reverts is not established, only that it does. What
 * broke was the `Promise.all` around it: one reverting read failed the whole
 * batch, so the name, the price and the stage all vanished and the panel
 * refused to queue a drop that was minting at that moment.
 *
 * `getMintStats` is part of the SeaDrop interface every one of these
 * implements, and it answered 426 when totalSupply would not. `totalMinted()`
 * is the ERC721A spelling, where exposed. Nothing minted is the last resort,
 * and the least trustworthy of the four — but it lets the rest of the read
 * through, which is the point.
 */
export async function readMintedCount(
  client: PublicClient,
  target: `0x${string}`,
): Promise<bigint> {
  const attempts: (() => Promise<bigint>)[] = [
    () =>
      client.readContract({
        address: target,
        abi: tokenAbi,
        functionName: "totalSupply",
      }) as Promise<bigint>,
    async () => {
      const stats = (await client.readContract({
        address: target,
        abi: tokenAbi,
        functionName: "getMintStats",
        args: ["0x0000000000000000000000000000000000000000"],
      })) as readonly [bigint, bigint, bigint];
      return stats[1];
    },
    () =>
      client.readContract({
        address: target,
        abi: tokenAbi,
        functionName: "totalMinted",
      }) as Promise<bigint>,
  ];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // Next spelling.
    }
  }
  return 0n;
}

export async function fetchCollectionStatus(
  publicClient: PublicClient,
  target: `0x${string}`,
  info: ChainInfo,
): Promise<CollectionStatus> {
  const seaDrop = info.seaDrop;
  const read = <T,>(functionName: string): Promise<T> =>
    publicClient.readContract({
      address: target,
      abi: tokenAbi,
      functionName,
    } as never) as Promise<T>;
  const [name, symbol, owner, totalSupply, maxSupply, baseURI, contractURI, provenanceHash] =
    await Promise.all([
      read<string>("name"),
      read<string>("symbol"),
      read<string>("owner"),
      readMintedCount(publicClient, target),
      read<bigint>("maxSupply"),
      read<string>("baseURI"),
      read<string>("contractURI"),
      read<string>("provenanceHash"),
    ]);
  const [royaltyReceiver, royaltyAmount] = (await publicClient.readContract({
    address: target,
    abi: tokenAbi,
    functionName: "royaltyInfo",
    args: [1n, 10_000n],
  })) as readonly [string, bigint];
  const transferValidator = (await publicClient.readContract({
    address: target,
    abi: tokenAbi,
    functionName: "getTransferValidator",
  })) as string;
  const [publicDrop, creatorPayout, allowedFeeRecipients] = await Promise.all([
    publicClient.readContract({
      address: seaDrop,
      abi: seaDropAbi,
      functionName: "getPublicDrop",
      args: [target],
    }),
    publicClient.readContract({
      address: seaDrop,
      abi: seaDropAbi,
      functionName: "getCreatorPayoutAddress",
      args: [target],
    }),
    publicClient.readContract({
      address: seaDrop,
      abi: seaDropAbi,
      functionName: "getAllowedFeeRecipients",
      args: [target],
    }),
  ]);
  return {
    name,
    symbol,
    owner,
    totalSupply,
    maxSupply,
    baseURI,
    contractURI,
    provenanceHash,
    publicDrop: {
      mintPrice: publicDrop.mintPrice,
      startTime: Number(publicDrop.startTime),
      endTime: Number(publicDrop.endTime),
      maxTotalMintableByWallet: Number(publicDrop.maxTotalMintableByWallet),
      feeBps: Number(publicDrop.feeBps),
      restrictFeeRecipients: publicDrop.restrictFeeRecipients,
    },
    creatorPayout,
    allowedFeeRecipients,
    royaltyReceiver,
    royaltyBps: Number(royaltyAmount),
    transferValidator,
  };
}

/** In-memory cache — block timestamps never change. */
const blockTimeCache = new Map<string, number>();

/**
 * Resolve timestamps for a set of blocks with at most `maxLookups` RPC calls:
 * exact lookups for a sampled subset, linear interpolation between neighbors
 * for the rest (fine for charting; this chain has sub-second blocks).
 */
export async function resolveBlockTimes(
  publicClient: PublicClient,
  blocks: bigint[],
  maxLookups = 25,
): Promise<Map<bigint, number>> {
  const unique = [...new Set(blocks)].sort((a, b) => (a < b ? -1 : 1));
  const result = new Map<bigint, number>();
  if (unique.length === 0) return result;
  const sampled: bigint[] = [];
  if (unique.length <= maxLookups) {
    sampled.push(...unique);
  } else {
    for (let i = 0; i < maxLookups; i++) {
      sampled.push(unique[Math.round((i * (unique.length - 1)) / (maxLookups - 1))]);
    }
  }
  const known = new Map<bigint, number>();
  await Promise.all(
    [...new Set(sampled)].map(async (bn) => {
      const key = bn.toString();
      let t = blockTimeCache.get(key);
      if (t === undefined) {
        const block = await publicClient.getBlock({ blockNumber: bn });
        t = Number(block.timestamp);
        blockTimeCache.set(key, t);
      }
      known.set(bn, t);
    }),
  );
  const anchors = [...known.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const bn of unique) {
    const exact = known.get(bn);
    if (exact !== undefined) {
      result.set(bn, exact);
      continue;
    }
    // Interpolate between the nearest anchors.
    let lo = anchors[0];
    let hi = anchors[anchors.length - 1];
    for (const a of anchors) {
      if (a[0] <= bn && a[0] >= lo[0]) lo = a;
      if (a[0] >= bn && a[0] <= hi[0]) hi = a;
    }
    const span = Number(hi[0] - lo[0]);
    const frac = span === 0 ? 0 : Number(bn - lo[0]) / span;
    result.set(bn, Math.round(lo[1] + frac * (hi[1] - lo[1])));
  }
  return result;
}

export async function fetchProfitData(
  publicClient: PublicClient,
  target: `0x${string}`,
  s: CollectionStatus,
  info: ChainInfo,
): Promise<ProfitData> {
  const api = info.blockscoutApi; // undefined → explorer-dependent parts degrade

  // 1. Mint revenue — exact, from SeaDrop's mint events for THIS contract.
  //    Needs a full-range getLogs; some public RPCs cap this (archive limit).
  let logs;
  try {
    logs = await publicClient.getLogs({
      address: info.seaDrop,
      event: seaDropMintEvent,
      args: { nftContract: target },
      fromBlock: 0n,
      toBlock: "latest",
    });
  } catch {
    throw new Error(
      `${info.label}'s public RPC won't serve full-range logs (archive limit). ` +
        `Profit needs an archive-capable RPC — swap the RPC for ${info.label} in chains.ts.`,
    );
  }
  const mint = computeMintRevenue(
    logs.map((l) => ({
      quantity: l.args.quantityMinted!,
      unitPrice: l.args.unitMintPrice!,
      feeBps: l.args.feeBps!,
    })),
  );
  const blockTimes = await resolveBlockTimes(
    publicClient,
    logs.map((l) => l.blockNumber),
  );
  const mintEvents: TimedAmount[] = logs
    .map((l) => {
      const paid = l.args.quantityMinted! * l.args.unitMintPrice!;
      const fee = (paid * l.args.feeBps!) / 10_000n;
      return { t: blockTimes.get(l.blockNumber) ?? 0, wei: paid - fee };
    })
    .filter((e) => e.wei > 0n);

  // 2. Royalties — internal native transfers Seaport 1.6 → royalty receiver.
  //    Needs a Blockscout API (internal-tx index); skipped where unavailable.
  let royaltyEvents: TimedAmount[] = [];
  let royaltiesTruncated = false;
  if (api && s.royaltyBps > 0 && s.royaltyReceiver !== zeroAddress) {
    let query = "filter=to";
    for (let page = 0; page < 5; page++) {
      const res = await fetch(
        `${api}/addresses/${s.royaltyReceiver}/internal-transactions?${query}`,
      );
      if (!res.ok) break; // degrade rather than throw the whole profit calc
      const data = (await res.json()) as {
        items: InternalTxItem[];
        next_page_params: Record<string, string | number> | null;
      };
      royaltyEvents = royaltyEvents.concat(
        extractSeaportPayoutEvents(data.items, info.seaport, s.royaltyReceiver),
      );
      if (!data.next_page_params) break;
      if (page === 4) {
        royaltiesTruncated = true;
        break;
      }
      query =
        "filter=to&" +
        new URLSearchParams(
          Object.fromEntries(
            Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)]),
          ),
        ).toString();
    }
  }
  const royalties = royaltyEvents.reduce((acc, e) => acc + e.wei, 0n);

  // 3. Launch cost — gas actually paid for the txs we can attribute. Own
  //    launches come from saved state (any chain); others need the explorer.
  const savedState = loadLaunchState();
  const mine = savedState?.contractAddress?.toLowerCase() === target.toLowerCase();
  const hashes = new Set<string>();
  let createdAt: number | null = null;
  if (api) {
    const creationRes = await fetch(`${api}/addresses/${target}`);
    if (creationRes.ok) {
      const meta = (await creationRes.json()) as {
        creation_transaction_hash?: string | null;
        creation_tx_hash?: string | null;
      };
      const h = meta.creation_transaction_hash ?? meta.creation_tx_hash;
      if (h) {
        hashes.add(h);
        try {
          const txRes = await fetch(`${api}/transactions/${h}`);
          if (txRes.ok) {
            const tx = (await txRes.json()) as { timestamp?: string };
            if (tx.timestamp) createdAt = Math.floor(new Date(tx.timestamp).getTime() / 1000);
          }
        } catch {
          createdAt = null;
        }
      }
    }
  }
  if (mine && savedState) {
    for (const h of [
      savedState.deployTxHash,
      savedState.configureTxHash,
      savedState.royaltyTxHash,
      savedState.validatorTxHash,
      savedState.revealTxHash,
    ]) {
      if (h) hashes.add(h);
    }
  }
  let launchCost = 0n;
  for (const h of hashes) {
    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: h as `0x${string}`,
      });
      launchCost += receipt.gasUsed * receipt.effectiveGasPrice;
    } catch {
      // Receipt not found — skip; flagged via launchCostComplete.
    }
  }

  // 4. USD approximation (native coin price from the explorer, where available).
  let ethUsd: number | null = null;
  if (api) {
    try {
      const statsRes = await fetch(`${api}/stats`);
      if (statsRes.ok) {
        const price = Number(((await statsRes.json()) as { coin_price?: string }).coin_price);
        ethUsd = Number.isFinite(price) ? price : null;
      }
    } catch {
      ethUsd = null;
    }
  }

  return {
    breakdown: computeProfit({
      mint,
      royalties,
      royaltiesTruncated,
      launchCost,
      launchCostComplete: mine,
    }),
    ethUsd,
    mintEvents,
    royaltyEvents,
    createdAt,
  };
}
