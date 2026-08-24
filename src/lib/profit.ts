/**
 * Profit math for the Status tab.
 *
 * Profit = creator mint proceeds (net of OpenSea's feeBps, exact — from
 * SeaDrop's SeaDropMint events) + royalties received (estimate — internal
 * transfers from Seaport 1.6 to the royalty receiver; OpenSea pays creator
 * earnings that way on every secondary sale) − launch cost (gas actually paid
 * for deploy/configure/reveal transactions).
 *
 * All amounts are wei of native ETH — exactly what reached (or left) the
 * wallet, so marketplace cuts are already excluded by construction.
 */

export interface MintEvent {
  quantity: bigint;
  unitPrice: bigint;
  feeBps: bigint;
}

export interface MintRevenue {
  gross: bigint;
  openSeaFee: bigint;
  creator: bigint;
  mintedViaSeaDrop: bigint;
}

export function computeMintRevenue(mints: MintEvent[]): MintRevenue {
  let gross = 0n;
  let openSeaFee = 0n;
  let minted = 0n;
  for (const m of mints) {
    const paid = m.quantity * m.unitPrice;
    gross += paid;
    openSeaFee += (paid * m.feeBps) / 10_000n;
    minted += m.quantity;
  }
  return {
    gross,
    openSeaFee,
    creator: gross - openSeaFee,
    mintedViaSeaDrop: minted,
  };
}

/** Shape of Blockscout v2 /addresses/{a}/internal-transactions items we use. */
export interface InternalTxItem {
  value: string;
  from: { hash: string };
  to: { hash: string } | null;
  timestamp?: string;
}

/** An amount that happened at a point in time (unix seconds). */
export interface TimedAmount {
  t: number;
  wei: bigint;
}

/**
 * Extract internal native transfers `seaport → receiver` as timed amounts.
 * This is how OpenSea pays out creator royalties on secondary sales. It's an
 * ESTIMATE: it counts every Seaport payout to that address (all collections
 * sharing the same royalty receiver, and the receiver's own trading proceeds
 * if they sell through OpenSea from the same wallet).
 */
export function extractSeaportPayoutEvents(
  items: InternalTxItem[],
  seaport: string,
  receiver: string,
): TimedAmount[] {
  const s = seaport.toLowerCase();
  const r = receiver.toLowerCase();
  const events: TimedAmount[] = [];
  for (const it of items) {
    if (
      it.from.hash.toLowerCase() === s &&
      it.to?.hash.toLowerCase() === r &&
      it.value !== "0"
    ) {
      events.push({
        t: it.timestamp ? Math.floor(new Date(it.timestamp).getTime() / 1000) : 0,
        wei: BigInt(it.value),
      });
    }
  }
  return events;
}

/** Sum of `extractSeaportPayoutEvents`. */
export function sumSeaportPayouts(
  items: InternalTxItem[],
  seaport: string,
  receiver: string,
): bigint {
  return extractSeaportPayoutEvents(items, seaport, receiver).reduce(
    (acc, e) => acc + e.wei,
    0n,
  );
}

/**
 * Secondary trading volume implied by royalties: volume ≈ royalties / bps.
 * Only computable when the collection actually charges royalties.
 */
export function estimateVolumeFromRoyalties(
  royaltiesWei: bigint,
  royaltyBps: number,
): bigint | null {
  if (royaltyBps <= 0) return null;
  return (royaltiesWei * 10_000n) / BigInt(royaltyBps);
}

export interface ProfitBreakdown {
  mint: MintRevenue;
  royalties: bigint;
  royaltiesTruncated: boolean;
  launchCost: bigint;
  launchCostComplete: boolean;
  profit: bigint;
}

export function computeProfit(params: {
  mint: MintRevenue;
  royalties: bigint;
  royaltiesTruncated: boolean;
  launchCost: bigint;
  launchCostComplete: boolean;
}): ProfitBreakdown {
  return {
    ...params,
    profit: params.mint.creator + params.royalties - params.launchCost,
  };
}

/**
 * Trim an ETH amount for display: "0.0421", "12.5", "0". Sub-cutoff amounts
 * extend to 9 decimals instead of collapsing to a misleading "0" (gas on this
 * chain is tiny but real).
 */
export function formatEthShort(wei: bigint, maxDecimals = 6): string {
  const sign = wei < 0n ? "-" : "";
  const abs = wei < 0n ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const fracDigits = (abs % 10n ** 18n).toString().padStart(18, "0");
  let fracStr = fracDigits.slice(0, maxDecimals).replace(/0+$/, "");
  if (!fracStr && whole === 0n && abs > 0n) {
    fracStr = fracDigits.slice(0, 9).replace(/0+$/, "");
  }
  return `${sign}${whole}${fracStr ? "." + fracStr : ""}`;
}

/** "≈ $12.34" from a wei amount and a USD price per ETH; null when no price. */
export function formatUsdApprox(wei: bigint, ethUsd: number | null): string | null {
  if (ethUsd === null || !Number.isFinite(ethUsd)) return null;
  const eth = Number(wei) / 1e18;
  const usd = eth * ethUsd;
  const abs = Math.abs(usd);
  const digits = abs >= 100 ? 0 : 2;
  return `≈ ${usd < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}
