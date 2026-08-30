/**
 * What a queued mint costs each wallet, and who is short.
 *
 * The arithmetic is small and the consequence of getting it wrong is not: a
 * wallet funded a shade too little arms, waits for the stage, and reverts for
 * gas at the one moment nobody is watching. So it is here, in front of tests,
 * rather than inline in a modal.
 */

import { gasNeededWei } from "./spread";

export interface FundingRow {
  address: string;
  /** What it holds now, in wei. Null when the balance could not be read. */
  balanceWei: bigint | null;
  /** What it still needs to reach the target, in wei. */
  shortfallWei: bigint;
}

export interface FundingPlan {
  /** What each wallet must hold for this job: the mint plus its gas. */
  perWalletWei: bigint;
  /** The mint half, for showing the breakdown. */
  mintWei: bigint;
  /** The gas half. */
  gasWei: bigint;
  rows: FundingRow[];
  /** Wallets that need something. */
  needy: number;
  /** Total to send, excluding the transfer fees the server adds on top. */
  totalWei: bigint;
}

export interface JobCost {
  /** Mint price per unit, in wei. */
  priceWei: bigint;
  /** How many each wallet mints. */
  quantity: number;
  /** The job's gas cap, in gwei, as typed. */
  maxFeeGwei: string;
  /** The job's gas limit, in units. */
  gasLimit: number;
  /**
   * Transactions this job sends per wallet.
   *
   * A spread run signs several on consecutive nonces, and each one has to be
   * affordable when its turn comes. Leaving this out is how a wallet ends up
   * funded for exactly one shot — which is precisely what happened on Chill
   * Guys: the first shot reverted, the balance fell below the reservation, and
   * every later shot was refused before it reached a block.
   */
  shots?: number;
}

/** gwei is 10^9 wei, and the string comes from a text box, so parse it safely. */
export function gweiToWei(gwei: string): bigint {
  const t = (gwei ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return 0n;
  const [whole, frac = ""] = t.split(".");
  const padded = (frac + "000000000").slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(padded || "0");
}

/**
 * What one wallet must hold.
 *
 * Deliberately the job's full gas allowance rather than an estimate of what
 * the mint will really burn. A wallet holding the estimate and not the
 * allowance is a wallet whose transaction a node may refuse to accept at all —
 * the check is against the cap, not the eventual spend, and the change is
 * returned either way.
 */
export function perWalletCost(cost: JobCost): { mintWei: bigint; gasWei: bigint; totalWei: bigint } {
  const quantity = Number.isFinite(cost.quantity) && cost.quantity > 0 ? Math.floor(cost.quantity) : 1;
  const mintWei = cost.priceWei * BigInt(quantity);
  const limit = Number.isFinite(cost.gasLimit) && cost.gasLimit > 0 ? Math.floor(cost.gasLimit) : 0;
  const shots = Number.isFinite(cost.shots) && (cost.shots ?? 0) > 0 ? Math.floor(cost.shots!) : 1;
  // One full reservation plus what each earlier shot actually burns — see
  // `gasNeededWei`. Not one reservation per shot, which would demand many
  // times what a run needs and refuse wallets that could mint perfectly well.
  const gasWei = gasNeededWei(shots, BigInt(limit), gweiToWei(cost.maxFeeGwei));
  return { mintWei, gasWei, totalWei: mintWei + gasWei };
}

/**
 * The whole picture for one job: the target balance, who is below it, by how
 * much, and what that adds up to.
 *
 * A wallet whose balance could not be read counts as needing the full amount.
 * The alternative — assuming it is fine — funds nothing and fails the mint,
 * and the server tops up against balances it reads itself anyway, so an
 * over-estimate here costs nothing but a larger number on screen.
 */
export function planFunding(
  wallets: readonly { address: string; balanceWei: bigint | null }[],
  cost: JobCost,
): FundingPlan {
  const { mintWei, gasWei, totalWei: perWalletWei } = perWalletCost(cost);
  const rows: FundingRow[] = wallets.map((w) => ({
    address: w.address,
    balanceWei: w.balanceWei,
    shortfallWei:
      w.balanceWei === null
        ? perWalletWei
        : w.balanceWei >= perWalletWei
          ? 0n
          : perWalletWei - w.balanceWei,
  }));
  return {
    perWalletWei,
    mintWei,
    gasWei,
    rows,
    needy: rows.filter((r) => r.shortfallWei > 0n).length,
    totalWei: rows.reduce((sum, r) => sum + r.shortfallWei, 0n),
  };
}

/** wei as a plain decimal string the funding endpoint will accept. */
export function weiToEthString(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
