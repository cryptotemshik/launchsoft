/**
 * Wallet activity — read a watched address's recent NFT transfers from a
 * Blockscout v2 API and classify each as a mint / buy / sell (or plain
 * receive / send when it isn't a marketplace order). Read-only, browser-side;
 * degrades to nothing on chains without a Blockscout API.
 */

import { fetchJson } from "./blockscout";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Seaport / marketplace order-fill methods → treat an in/out as a trade. */
const TRADE_METHODS = [
  "fulfillbasicorder",
  "fulfillbasicorder_efficient_6gl6yc",
  "fulfillorder",
  "fulfilladvancedorder",
  "fulfillavailableorders",
  "fulfillavailableadvancedorders",
  "matchorders",
  "matchadvancedorders",
  "atomicmatch_",
  "acceptoffer",
  "buy",
  "buynow",
  "purchase",
  "sweep",
];

/**
 * Seaport order-fill 4-byte selectors — Blockscout returns `method` as a raw
 * selector (not a decoded name) on many chains, so match those too. Canonical
 * Seaport 1.5/1.6 values; the "efficient" basic order is the famous 0x00000000.
 */
const TRADE_SELECTORS = new Set([
  "0xfb0f3ee1", // fulfillBasicOrder
  "0x00000000", // fulfillBasicOrder_efficient_6GL6yc
  "0xb3a34c4c", // fulfillOrder
  "0xe7acab24", // fulfillAdvancedOrder
  "0xed98a574", // fulfillAvailableOrders
  "0x87201b41", // fulfillAvailableAdvancedOrders
  "0xa8174404", // matchOrders
  "0xf2d12b12", // matchAdvancedOrders
]);

export function looksLikeTrade(method?: string | null): boolean {
  if (!method) return false;
  const raw = method.toLowerCase().trim();
  if (TRADE_SELECTORS.has(raw)) return true;
  const m = raw.replace(/[^a-z0-9_]/g, "");
  return TRADE_METHODS.some((t) => m.includes(t));
}

/** Raw Blockscout token-transfer item (only the fields we read). */
export interface TransferItem {
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  token?: {
    name?: string;
    symbol?: string;
    /** Blockscout v2 uses `address_hash`; older builds used `address`. */
    address_hash?: string;
    address?: string;
    type?: string;
  } | null;
  token_type?: string | null;
  total?: { token_id?: string | null } | null;
  timestamp?: string | null;
  transaction_hash: string;
  log_index?: number | string | null;
  method?: string | null;
}

export type EventKind = "mint" | "buy" | "sell" | "receive" | "send";

export interface WalletEvent {
  /** Stable dedupe key: wallet + tx + log index. */
  id: string;
  wallet: `0x${string}`;
  label?: string;
  kind: EventKind;
  collection: string;
  contract?: string;
  tokenId?: string;
  tokenType?: string;
  counterparty?: string;
  txHash: string;
  /** Unix seconds. */
  t: number;
}

export const KIND_VERB: Record<EventKind, string> = {
  mint: "minted",
  buy: "bought",
  sell: "sold",
  receive: "received",
  send: "sent",
};

/**
 * Turn one transfer into a wallet-relative event, or null if the transfer
 * doesn't involve this wallet.
 */
export function classifyTransfer(
  item: TransferItem,
  wallet: string,
  label?: string,
): WalletEvent | null {
  const from = (item.from?.hash ?? "").toLowerCase();
  const to = (item.to?.hash ?? "").toLowerCase();
  const w = wallet.toLowerCase();
  if (to !== w && from !== w) return null;

  const trade = looksLikeTrade(item.method);
  let kind: EventKind;
  if (from === ZERO && to === w) kind = "mint";
  else if (to === w) kind = trade ? "buy" : "receive";
  else kind = trade ? "sell" : "send";

  const t = item.timestamp
    ? Math.floor(new Date(item.timestamp).getTime() / 1000)
    : 0;

  return {
    id: `${w}:${item.transaction_hash}:${item.log_index ?? "0"}`,
    wallet: w as `0x${string}`,
    label,
    kind,
    collection: item.token?.name || item.token?.symbol || "NFT",
    contract: item.token?.address_hash ?? item.token?.address,
    tokenId: item.total?.token_id ?? undefined,
    tokenType: item.token_type ?? item.token?.type ?? undefined,
    counterparty: to === w ? from : to,
    txHash: item.transaction_hash,
    t,
  };
}

/** Fetch + classify a single wallet's recent NFT transfers (newest first). */
export async function fetchWalletEvents(
  api: string,
  wallet: string,
  label?: string,
): Promise<WalletEvent[]> {
  const url = `${api}/addresses/${wallet}/token-transfers?type=ERC-721,ERC-1155`;
  const data = await fetchJson<{ items?: TransferItem[] }>(url);
  return (data.items ?? [])
    .map((it) => classifyTransfer(it, wallet, label))
    .filter((e): e is WalletEvent => e !== null);
}

/**
 * Merge new events into an existing feed: dedupe by id, newest first, capped.
 * Pure — the component owns the state.
 */
export function mergeEvents(
  prior: WalletEvent[],
  incoming: WalletEvent[],
  cap = 200,
): WalletEvent[] {
  const byId = new Map<string, WalletEvent>();
  for (const e of prior) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.t - a.t).slice(0, cap);
}
