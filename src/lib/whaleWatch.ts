/**
 * Spotting whales entering a collection, from raw chain logs.
 *
 * The signal the product cares about is simple: three or more different whales
 * acquiring the same collection. Acquiring shows up on-chain as an ERC-721
 * Transfer whose recipient is a whale — a mint (from the zero address) or a
 * buy/transfer (from anyone else); both are "a whale just got into this". So a
 * single log filter — Transfer, any sender, recipient in the whale set — finds
 * every acquisition across the whole chain in one query, and this turns those
 * logs into {collection, whale} pairs for the store to tally.
 *
 * Pure: it parses logs it is handed. Fetching them (server, over RPC — not the
 * Cloudflare-gated explorer) and tallying them (whaleAlerts.ts) live elsewhere.
 */

/** keccak256("Transfer(address,address,uint256)") — ERC-721 and ERC-20 share it. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO_TOPIC = `0x${"0".repeat(64)}`;

/** An address as a 32-byte topic, lower-cased, for an indexed-arg filter. */
export function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.toLowerCase().replace(/^0x/, "")}`;
}

/** The address an indexed-address topic stands for. */
function topicToAddress(topic: string): `0x${string}` {
  return `0x${topic.slice(-40)}`.toLowerCase() as `0x${string}`;
}

export interface Acquisition {
  /** The collection contract, lower-cased. */
  contract: `0x${string}`;
  /** The whale that acquired, lower-cased. */
  whale: `0x${string}`;
  /** True when it came straight from a mint (sender = zero address). */
  minted: boolean;
  blockNumber: number;
}

interface RawLog {
  address?: string;
  topics?: string[];
  blockNumber?: string | number | bigint;
}

/**
 * Keep only the logs that are an NFT landing in a whale's wallet.
 *
 * ERC-721 Transfer carries three indexed args (from, to, tokenId), so its log
 * has four topics; ERC-20's value is unindexed, giving three — that length gap
 * is how a token transfer is told from an NFT one without an ABI. The `to`
 * filter is applied here too rather than trusted from the request, so a widened
 * server-side filter can never smuggle in a non-whale.
 */
export function parseAcquisitions(logs: readonly RawLog[], whales: ReadonlySet<string>): Acquisition[] {
  const out: Acquisition[] = [];
  for (const log of logs) {
    const topics = log.topics ?? [];
    if (topics.length !== 4) continue; // ERC-721 only (from, to, tokenId indexed)
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = topicToAddress(topics[2] ?? "");
    if (!whales.has(to)) continue;
    const contract = (log.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(contract)) continue;
    out.push({
      contract: contract as `0x${string}`,
      whale: to,
      minted: (topics[1] ?? "").toLowerCase() === ZERO_TOPIC,
      blockNumber: Number(log.blockNumber ?? 0),
    });
  }
  return out;
}

/** Split a whale set into topic-filter batches, so one getLogs stays small. */
export function whaleTopicBatches(whales: readonly string[], batchSize = 100): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < whales.length; i += batchSize) {
    batches.push(whales.slice(i, i + batchSize).map(addressTopic));
  }
  return batches;
}
