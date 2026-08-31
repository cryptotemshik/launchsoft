/**
 * Find the biggest holders of a collection, from the browser.
 *
 * Whale discovery has to run here, not on the server: the chain's Blockscout
 * sits behind a Cloudflare challenge that a plain server request cannot pass,
 * but a real browser does — the same reason the tracker reads activity
 * client-side. So the admin panel pastes a collection, this ranks its holders,
 * and the operator seeds the whale list from real on-chain holdings.
 *
 * It cannot value a portfolio in dollars — Robinhood Chain NFTs have no floor
 * feed — so "whale" here means "holds a lot", optionally weighed against a
 * wallet's ETH balance, which is the one figure that can be priced. Honest
 * about what it is: a ranked shortlist for a human to approve, not an oracle.
 */
export interface Holder {
  address: `0x${string}`;
  /** How many of the collection this wallet holds. */
  count: number;
  /** Wei of native ETH, when looked up. */
  balanceWei?: string;
}

interface HoldersResponse {
  items?: Array<{ address?: { hash?: string }; value?: string | number }>;
}

/** Top holders of a collection, most-held first. */
export async function fetchTopHolders(
  api: string,
  contract: string,
  limit = 40,
): Promise<Holder[]> {
  const url = `${api.replace(/\/+$/, "")}/tokens/${contract}/holders`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`holders: ${res.status}`);
  const data = (await res.json()) as HoldersResponse;
  return parseHolders(data, limit);
}

/** Pure parse+rank, so the shaping is testable without the network. */
export function parseHolders(data: HoldersResponse, limit = 40): Holder[] {
  const out: Holder[] = [];
  for (const it of data.items ?? []) {
    const addr = it.address?.hash?.toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) continue;
    out.push({ address: addr as `0x${string}`, count: Number(it.value ?? 0) || 0 });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

/** A wallet's native ETH balance in wei, best-effort (0 on any failure). */
export async function fetchEthBalance(api: string, address: string): Promise<string> {
  try {
    const res = await fetch(`${api.replace(/\/+$/, "")}/addresses/${address}`);
    if (!res.ok) return "0";
    const data = (await res.json()) as { coin_balance?: string };
    return typeof data.coin_balance === "string" && /^\d+$/.test(data.coin_balance)
      ? data.coin_balance
      : "0";
  } catch {
    return "0";
  }
}
