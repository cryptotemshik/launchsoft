/**
 * Who holds what, read from the chain in two queries.
 *
 * The obvious route — ask an explorer per wallet — is slow and unreliable at
 * this size: Robinhood Chain's Blockscout answers in 2–4 seconds and refuses
 * fifteen of any twenty simultaneous requests, so a hundred wallets took a
 * minute and undercounted whatever it refused.
 *
 * Transfer logs answer the same question for every wallet and every collection
 * at once. ERC-721 indexes `from`, `to` and `tokenId`, so the node filters
 * server-side on "any of these hundred addresses" — and with no contract
 * filter at all, one query returns every NFT any of them has ever received,
 * whichever collection it came from. Replaying the matches in order settles
 * each token's current owner.
 *
 * Measured against the real wallet set: 1.5 seconds for two queries covering
 * 813 transfers across 11 collections, where the explorer took 59 seconds and
 * missed tokens.
 *
 * ERC-20 shares the event's name and signature hash but leaves `value`
 * unindexed, so its logs carry three topics where these carry four. That is
 * the difference the filter below relies on.
 */
import { getAddress, parseAbiItem, type PublicClient } from "viem";
import { isRateLimit, mapWithLimit } from "../lib/rpcRead";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const NAME_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * Below this, halving again costs more round-trips than it saves, and a
 * provider still refusing a hundred-block window is telling us something other
 * than "too wide".
 */
const MIN_CHUNK = 100n;

export interface WalletHolding {
  wallet: `0x${string}`;
  tokenIds: string[];
}

/** A token arriving from nowhere — a mint, and the half of a cost we can see. */
export interface MintTransfer {
  wallet: `0x${string}`;
  collection: `0x${string}`;
  tokenId: string;
  blockNumber: bigint;
  txHash: string;
}

/** A token that left one of our wallets — the visible half of a sale. */
export interface OutgoingTransfer {
  wallet: `0x${string}`;
  collection: `0x${string}`;
  tokenId: string;
  blockNumber: bigint;
  txHash: string;
  to: `0x${string}`;
}

export interface CollectionHoldings {
  collection: `0x${string}`;
  name?: string;
  wallets: WalletHolding[];
  totalTokens: number;
}

export interface ChainScan {
  collections: CollectionHoldings[];
  /** Every departure, in order. Pricing them is profit.ts's job. */
  sent: OutgoingTransfer[];
  /**
   * Every arrival from the zero address. This is what a mint looks like from
   * the outside, and it is how many a drop cost — a figure the local ledger
   * only knows for runs this server happened to make.
   */
  minted: MintTransfer[];
  totalTokens: number;
  /** Wallets holding at least one token of anything. */
  walletsWithTokens: number;
}

/**
 * Providers cap how many blocks one `eth_getLogs` may cover, and say so in
 * different words. Rather than guess each provider's limit, ask for
 * everything and split when refused.
 */
function looksLikeRangeLimit(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("block range") ||
    msg.includes("range is too large") ||
    msg.includes("too many blocks") ||
    msg.includes("query returned more than") ||
    msg.includes("limit exceeded") ||
    msg.includes("response size")
  );
}

type TransferLog = {
  address: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  transactionHash?: string;
  topics: readonly string[];
  args: { from?: `0x${string}`; to?: `0x${string}`; tokenId?: bigint };
};

async function getLogsChunked(
  client: PublicClient,
  args: Record<string, unknown>,
  fromBlock: bigint,
  toBlock: bigint,
  address?: `0x${string}`,
): Promise<TransferLog[]> {
  try {
    return (await client.getLogs({
      ...(address ? { address } : {}),
      event: TRANSFER,
      args,
      fromBlock,
      toBlock,
    })) as unknown as TransferLog[];
  } catch (e) {
    const span = toBlock - fromBlock;
    if (!looksLikeRangeLimit(e) || span <= MIN_CHUNK) throw e;
    const mid = fromBlock + span / 2n;
    const [a, b] = await Promise.all([
      getLogsChunked(client, args, fromBlock, mid, address),
      getLogsChunked(client, args, mid + 1n, toBlock, address),
    ]);
    return [...a, ...b];
  }
}

/** ERC-20 shares the signature but indexes one argument fewer. */
const isErc721 = (l: TransferLog) => l.topics.length === 4 && l.args.tokenId !== undefined;

/**
 * Everything `wallets` hold, of every collection, plus everything they have
 * sent away.
 *
 * @param collection restrict to one contract. Omitted, the scan covers all of
 *   them — which costs the same two queries, so there is rarely a reason to.
 */
export async function scanChain(
  client: PublicClient,
  wallets: readonly `0x${string}`[],
  opts: { collection?: `0x${string}`; fromBlock?: bigint } = {},
): Promise<ChainScan> {
  if (wallets.length === 0) {
    return { collections: [], sent: [], minted: [], totalTokens: 0, walletsWithTokens: 0 };
  }
  const fromBlock = opts.fromBlock ?? 0n;
  const toBlock = await client.getBlockNumber();
  const list = wallets as `0x${string}`[];

  const [incomingRaw, outgoingRaw] = await Promise.all([
    getLogsChunked(client, { to: list }, fromBlock, toBlock, opts.collection),
    getLogsChunked(client, { from: list }, fromBlock, toBlock, opts.collection),
  ]);
  const incoming = incomingRaw.filter(isErc721);
  const outgoing = outgoingRaw.filter(isErc721);

  // Last write wins, so order matters: block first, then position within it.
  const ordered = [...incoming, ...outgoing].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
  );

  // Keyed by contract as well as id — two collections can both have token #1.
  const ownerOf = new Map<string, string>();
  for (const l of ordered) {
    ownerOf.set(`${l.address.toLowerCase()}#${l.args.tokenId}`, l.args.to!.toLowerCase());
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  const mine = new Set(wallets.map((w) => w.toLowerCase()));
  const byCollection = new Map<string, Map<string, string[]>>();
  for (const [key, owner] of ownerOf) {
    if (!mine.has(owner)) continue;
    const [collection, tokenId] = key.split("#");
    const perWallet = byCollection.get(collection) ?? new Map<string, string[]>();
    perWallet.set(owner, [...(perWallet.get(owner) ?? []), tokenId]);
    byCollection.set(collection, perWallet);
  }

  const addresses = [...byCollection.keys()] as `0x${string}`[];
  // One `name()` each, batched by the read transport — 124ms for eleven.
  //
  // Rate limits are rethrown rather than caught, so mapWithLimit can back off
  // and try again: swallowing them here is what turned nine named collections
  // into nine bare addresses the moment the endpoint pushed back.
  const names = await mapWithLimit(addresses, async (address) => {
    try {
      return (await client.readContract({ address, abi: NAME_ABI, functionName: "name" })) as string;
    } catch (e) {
      if (isRateLimit(e)) throw e;
      // Not every contract implements it, and a missing name is not a reason
      // to lose the holdings under it.
      return undefined;
    }
  }).catch(() => addresses.map(() => undefined));

  const collections: CollectionHoldings[] = addresses.map((address, i) => {
    const perWallet = byCollection.get(address.toLowerCase())!;
    const walletsOut = [...perWallet.entries()].map(([wallet, tokenIds]) => ({
      wallet: getAddress(wallet),
      // Numeric order, so a list of ids reads the way a person would write it.
      tokenIds: tokenIds.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    }));
    return {
      collection: getAddress(address),
      name: names[i],
      wallets: walletsOut.sort((a, b) => b.tokenIds.length - a.tokenIds.length),
      totalTokens: walletsOut.reduce((n, w) => n + w.tokenIds.length, 0),
    };
  });
  collections.sort((a, b) => b.totalTokens - a.totalTokens);

  const holders = new Set<string>();
  for (const c of collections) for (const w of c.wallets) holders.add(w.wallet.toLowerCase());

  return {
    collections,
    minted: incoming
      .filter((l) => l.args.from!.toLowerCase() === ZERO)
      .map((l) => ({
        wallet: getAddress(l.args.to!),
        collection: getAddress(l.address),
        tokenId: l.args.tokenId!.toString(),
        blockNumber: l.blockNumber,
        txHash: l.transactionHash ?? "",
      })),
    sent: outgoing.map((l) => ({
      wallet: getAddress(l.args.from!),
      collection: getAddress(l.address),
      tokenId: l.args.tokenId!.toString(),
      blockNumber: l.blockNumber,
      txHash: l.transactionHash ?? "",
      to: getAddress(l.args.to!),
    })),
    totalTokens: collections.reduce((n, c) => n + c.totalTokens, 0),
    walletsWithTokens: holders.size,
  };
}
