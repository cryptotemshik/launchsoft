/**
 * Gather minted NFTs from the wallet set onto one wallet.
 *
 * After a multi-wallet mint the tokens are scattered across twenty wallets, and
 * listing them means signing into twenty wallets. Moving them to one address
 * first turns that into one listing session.
 *
 * Finding what to move: ERC721SeaDrop is ERC721A and does **not** implement
 * `tokenOfOwnerByIndex`, so holdings can't be enumerated on-chain. Two sources
 * are used instead — the token ids decoded from a mint receipt (exact, free,
 * and what the auto-sweep uses), or the chain's Blockscout index (for anything
 * minted earlier or elsewhere).
 *
 * Like the funding transfers, everything is signed up front and blasted at once:
 * one wallet moving five tokens sends five transactions on sequential nonces,
 * different wallets are independent, and all of it goes out together.
 */
import { createPublicClient, encodeFunctionData, parseGwei, type Hex, type PublicClient } from "viem";
import { getChainInfo } from "../chains";
import { mapWithLimit, readTransport } from "../lib/rpcRead";
import {
  getJsonRetrying,
  scanWallets,
  walletTokenCounts,
  type ScanFailure,
} from "./blockscout";
import {
  blastToAll,
  isAlreadyKnown,
  parseRpcEndpoints,
  prepareBlast,
  warmEndpoints,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { nodeSender } from "./nodeSender";
import type { Signer, UnsignedTx } from "./signer";
import type { FundingGas } from "./funding";

/** An ERC-721 transferFrom costs well under this; unused gas is refunded. */
export const NFT_TRANSFER_GAS = 150_000n;

const transferFromAbi = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface Holding {
  wallet: `0x${string}`;
  collection: `0x${string}`;
  collectionName?: string;
  tokenIds: string[];
}

/**
 * Every token a wallet holds, with ids, from the chain's Blockscout index.
 * Paginated; capped so a wallet holding thousands can't stall the whole sweep.
 *
 * This is the expensive call — 11.8KB for a wallet holding thirteen tokens,
 * most of it base64 images nobody reads here. `scanHoldings` uses the cheap
 * count endpoint first and only comes here for wallets that hold something.
 */
export async function findHoldings(
  api: string,
  wallet: `0x${string}`,
  collection?: `0x${string}`,
  maxPages = 6,
): Promise<Holding[]> {
  const byCollection = new Map<string, Holding>();
  let query = "type=ERC-721";
  for (let page = 0; page < maxPages; page++) {
    const data = await getJsonRetrying<{
      items?: { id?: string; token?: { address_hash?: string; name?: string } }[];
      next_page_params?: Record<string, string | number> | null;
    }>(`${api}/addresses/${wallet}/nft?${query}`);

    for (const item of data.items ?? []) {
      const addr = item.token?.address_hash?.toLowerCase();
      if (!addr || !item.id) continue;
      if (collection && addr !== collection.toLowerCase()) continue;
      let h = byCollection.get(addr);
      if (!h) {
        h = {
          wallet,
          collection: addr as `0x${string}`,
          collectionName: item.token?.name,
          tokenIds: [],
        };
        byCollection.set(addr, h);
      }
      h.tokenIds.push(item.id);
    }
    if (!data.next_page_params) break;
    query =
      "type=ERC-721&" +
      new URLSearchParams(
        Object.fromEntries(
          Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)]),
        ),
      ).toString();
  }
  return [...byCollection.values()];
}

export interface ScanResult {
  holdings: Holding[];
  /** Wallets the index would not answer for — NOT wallets holding nothing. */
  failed: ScanFailure[];
  /** Wallets checked, and how many of them turned out to hold anything. */
  checked: number;
  withTokens: number;
}

/**
 * What a whole wallet set holds.
 *
 * Two phases, because the index is slow and most wallets are empty. First the
 * cheap per-collection counts for every wallet; then the expensive call for
 * ids, only where the counts say there is something to fetch. On a hundred
 * wallets where forty-five hold tokens, that is fifty-five heavy requests not
 * made.
 *
 * A wallet the index refuses is reported in `failed`, never as an empty
 * wallet: reporting "nothing here" for a wallet full of tokens is how a sweep
 * silently leaves them behind.
 */
export async function scanHoldings(
  api: string,
  wallets: readonly `0x${string}`[],
  opts: {
    collection?: `0x${string}`;
    onProgress?: (done: number, total: number, phase: "counting" | "listing") => void;
  } = {},
): Promise<ScanResult> {
  const counts = await scanWallets(wallets, (w) => walletTokenCounts(api, w), {
    onProgress: (d, t) => opts.onProgress?.(d, t, "counting"),
  });

  const wanted = opts.collection?.toLowerCase();
  const holders = wallets.filter((w) => {
    const c = counts.results.get(w.toLowerCase());
    if (!c) return false;
    return wanted ? c.some((x) => x.collection === wanted) : c.length > 0;
  });

  const listed = await scanWallets(holders, (w) => findHoldings(api, w, opts.collection), {
    onProgress: (d, t) => opts.onProgress?.(d, t, "listing"),
  });

  return {
    holdings: [...listed.results.values()].flat(),
    failed: [...counts.failed, ...listed.failed],
    checked: wallets.length,
    withTokens: holders.length,
  };
}

export interface NftTransferOutcome {
  wallet: `0x${string}`;
  collection: `0x${string}`;
  tokenId: string;
  txHash?: string;
  status: "sent" | "rejected";
  detail?: string;
}

export interface SweepNftsOptions {
  chainId: number;
  extraRpcs: string[];
  gas: FundingGas;
  /** Wallets to empty, with the tokens each one should move. */
  holdings: { wallet: `0x${string}`; items: { collection: `0x${string}`; tokenId: string }[] }[];
  /** Turns unsigned transfers into raw signed ones. Keys never enter here. */
  signer: Signer;
  to: `0x${string}`;
  dryRun: boolean;
}

export interface SweepNftsResult {
  to: `0x${string}`;
  moved: number;
  total: number;
  outcomes: NftTransferOutcome[];
}

export async function sweepNfts(
  opts: SweepNftsOptions,
  onLog: (s: string) => void,
): Promise<SweepNftsResult> {
  const info = getChainInfo(opts.chainId);
  if (!info) throw new Error(`chain ${opts.chainId} isn't in the registry`);

  const readUrl = opts.extraRpcs[0] ?? info.chain.rpcUrls.default.http[0];
  const client = createPublicClient({
    chain: info.chain,
    transport: readTransport(readUrl),
  }) as PublicClient;
  const endpoints: RpcEndpoint[] = parseRpcEndpoints([
    ...(info.submitRpcs ?? []),
    ...info.chain.rpcUrls.default.http,
    ...opts.extraRpcs,
  ]);

  const maxFeePerGas = parseGwei(opts.gas.maxFeeGwei);
  const maxPriorityFeePerGas = parseGwei(opts.gas.tipGwei);
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error("tip cannot exceed max fee");

  const senders = opts.holdings
    .map((h) => ({ address: h.wallet, items: h.items }))
    .filter((s) => s.items.length > 0);
  const total = senders.reduce((n, s) => n + s.items.length, 0);

  onLog(`moving ${total} token(s) from ${senders.length} wallet(s) → ${opts.to}`);
  if (total === 0) return { to: opts.to, moved: 0, total: 0, outcomes: [] };

  if (opts.dryRun) {
    onLog("DRY RUN — nothing was broadcast.");
    return {
      to: opts.to,
      moved: 0,
      total,
      outcomes: senders.flatMap((s) =>
        s.items.map((i) => ({
          wallet: s.address,
          collection: i.collection,
          tokenId: i.tokenId,
          status: "rejected" as const,
          detail: "dry run",
        })),
      ),
    };
  }

  // One wallet moving several tokens needs sequential nonces; wallets are
  // independent of each other, so those run in parallel.
  const startNonces = await mapWithLimit(senders, (s) =>
    client.getTransactionCount({ address: s.address, blockTag: "pending" }),
  );

  interface Prepared {
    wallet: `0x${string}`;
    collection: `0x${string}`;
    tokenId: string;
    blast: ReturnType<typeof prepareBlast>;
  }
  // Flatten wallet × token into one batch, sign it in a single call to the
  // signer, then map the raw transactions back in the same order. The keys
  // never enter this process when the signer is across a socket.
  const unsigned: UnsignedTx[] = [];
  const meta: { wallet: `0x${string}`; collection: `0x${string}`; tokenId: string }[] = [];
  senders.forEach((s, si) => {
    s.items.forEach((item, i) => {
      const data: Hex = encodeFunctionData({
        abi: transferFromAbi,
        functionName: "transferFrom",
        args: [s.address, opts.to, BigInt(item.tokenId)],
      });
      unsigned.push({
        from: s.address,
        chainId: info.id,
        to: item.collection,
        data,
        value: "0",
        nonce: startNonces[si] + i,
        gas: NFT_TRANSFER_GAS.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      });
      meta.push({ wallet: s.address, collection: item.collection, tokenId: item.tokenId });
    });
  });
  const raw = await opts.signer.sign(unsigned);
  const prepared: Prepared[] = raw.map((r, i) => ({ ...meta[i], blast: prepareBlast(r) }));
  onLog(`signed ${prepared.length} transfer(s)`);

  await warmEndpoints(endpoints, prepared.length, nodeSender);
  const t0 = Date.now();
  const fired = prepared.map((p) => ({ ...p, results: blastToAll(p.blast, endpoints, nodeSender).results }));
  onLog(`dispatched ${fired.length} transfer(s) in ${Date.now() - t0}ms`);

  const outcomes = await Promise.all(
    fired.map(async (f): Promise<NftTransferOutcome> => {
      const settled = await f.results;
      const ok = settled.some((r) => r.txHash !== null || isAlreadyKnown(r.error));
      if (!ok) {
        const reasons = [...new Set(settled.map((r) => r.error).filter(Boolean))].join("; ");
        return {
          wallet: f.wallet,
          collection: f.collection,
          tokenId: f.tokenId,
          status: "rejected",
          detail: reasons,
        };
      }
      return {
        wallet: f.wallet,
        collection: f.collection,
        tokenId: f.tokenId,
        txHash: f.blast.txHash,
        status: "sent",
      };
    }),
  );

  const moved = outcomes.filter((o) => o.status === "sent").length;
  onLog(`${moved}/${total} transfer(s) accepted`);
  return { to: opts.to, moved, total, outcomes };
}
