/**
 * Who holds what, read from the chain instead of from an index.
 *
 * The obvious route — ask Blockscout per wallet — is both slow and unreliable
 * at this size: the index answers in 2–4 seconds and refuses part of any
 * burst, so a hundred wallets took over two minutes and quietly reported zero
 * for every wallet whose request was refused.
 *
 * Transfer logs give the same answer in two RPC calls for the whole set.
 * ERC-721 indexes `from`, `to` and `tokenId`, so the node can filter server
 * side on "any of these hundred addresses", and replaying the matching logs in
 * order leaves each token's current owner. Measured against Robinhood Chain:
 * 1.6s for a hundred wallets, matching Blockscout token for token.
 *
 * The catch is that this needs to be told which collection to look at — logs
 * are filtered by contract. Discovering unknown collections is what the index
 * is still for; minting through this server already knows.
 */
import { getAddress, parseAbiItem, type PublicClient } from "viem";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

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
  blockNumber: bigint;
  logIndex: number;
  args: { from?: `0x${string}`; to?: `0x${string}`; tokenId?: bigint };
};

async function getLogsChunked(
  client: PublicClient,
  address: `0x${string}`,
  args: Record<string, unknown>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferLog[]> {
  try {
    return (await client.getLogs({
      address,
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
      getLogsChunked(client, address, args, fromBlock, mid),
      getLogsChunked(client, address, args, mid + 1n, toBlock),
    ]);
    return [...a, ...b];
  }
}

/**
 * Which of `wallets` currently holds which tokens of `collection`.
 *
 * Both directions are needed: a wallet that received a token and later sent it
 * on still has the incoming log. Replaying every transfer touching this wallet
 * set in block order settles who ended up with each token.
 */
export async function holdingsFromLogs(
  client: PublicClient,
  collection: `0x${string}`,
  wallets: readonly `0x${string}`[],
  fromBlock = 0n,
): Promise<WalletHolding[]> {
  if (wallets.length === 0) return [];
  const toBlock = await client.getBlockNumber();

  const [incoming, outgoing] = await Promise.all([
    getLogsChunked(client, collection, { to: wallets as `0x${string}`[] }, fromBlock, toBlock),
    getLogsChunked(client, collection, { from: wallets as `0x${string}`[] }, fromBlock, toBlock),
  ]);

  // Last write wins, so order matters: block first, then position within it.
  const ordered = [...incoming, ...outgoing].sort(
    (a, b) =>
      Number(a.blockNumber - b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
  );

  const ownerOf = new Map<string, string>();
  for (const log of ordered) {
    if (log.args.tokenId === undefined || !log.args.to) continue;
    ownerOf.set(log.args.tokenId.toString(), log.args.to.toLowerCase());
  }

  const mine = new Set(wallets.map((w) => w.toLowerCase()));
  const byWallet = new Map<string, string[]>();
  for (const [tokenId, owner] of ownerOf) {
    if (!mine.has(owner)) continue;
    byWallet.set(owner, [...(byWallet.get(owner) ?? []), tokenId]);
  }

  return [...byWallet.entries()].map(([wallet, tokenIds]) => ({
    wallet: getAddress(wallet),
    // Numeric order, so a list of ids reads the way a person would write it.
    tokenIds: tokenIds.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
  }));
}
