/**
 * Realtime mint feed over a WebSocket RPC. Given a wss:// endpoint that
 * supports `eth_subscribe`, this subscribes to the canonical SeaDrop's
 * `SeaDropMint` logs and pushes each decoded mint the instant it lands —
 * no polling, no Blockscout round-trip. The Blockscout REST poll stays as
 * backfill/history; this is the low-latency path on top of it.
 */
import { createPublicClient, parseAbiItem, webSocket, type Chain } from "viem";
import type { MintEvent } from "./mintfeed";

const seaDropMintEvent = parseAbiItem(
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
);

export type WatchStatus = "connecting" | "live" | "error";

export interface MintWatch {
  stop: () => void;
}

export function watchMints(opts: {
  wssUrl: string;
  chain: Chain;
  seaDrop: `0x${string}`;
  onMint: (e: MintEvent) => void;
  onStatus: (status: WatchStatus, message?: string) => void;
}): MintWatch {
  const { wssUrl, chain, seaDrop, onMint, onStatus } = opts;
  let unwatch: (() => void) | null = null;

  onStatus("connecting");
  const client = createPublicClient({ chain, transport: webSocket(wssUrl, { retryCount: 2 }) });

  // Confirm the socket actually talks before claiming "live".
  client
    .getChainId()
    .then(() => onStatus("live"))
    .catch((e) => onStatus("error", e instanceof Error ? e.message : String(e)));

  try {
    unwatch = client.watchEvent({
      address: seaDrop,
      event: seaDropMintEvent,
      onLogs: (logs) => {
        for (const log of logs) {
          const a = log.args as {
            nftContract?: `0x${string}`;
            minter?: `0x${string}`;
            quantityMinted?: bigint;
            unitMintPrice?: bigint;
          };
          if (!a.nftContract || !a.minter) continue;
          onMint({
            id: `${log.transactionHash ?? ""}:${log.logIndex ?? 0}`,
            collection: a.nftContract,
            minter: a.minter,
            quantity: Number(a.quantityMinted ?? 0n),
            unitPriceWei: a.unitMintPrice ?? 0n,
            txHash: log.transactionHash ?? "",
            block: Number(log.blockNumber ?? 0n),
            // Realtime: no block timestamp on the log, and it just arrived.
            t: Math.floor(Date.now() / 1000),
          });
        }
      },
      onError: (err) => onStatus("error", err.message),
    });
  } catch (e) {
    onStatus("error", e instanceof Error ? e.message : String(e));
  }

  return {
    stop: () => {
      try {
        unwatch?.();
      } catch {
        /* already torn down */
      }
    },
  };
}
