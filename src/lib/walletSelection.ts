/**
 * Choosing which wallets a job fires from.
 *
 * Pulled out of the picker because the funding panel needs the same idea of
 * "funded" as the picker does — a wallet that shows as fundable and then turns
 * out to be too poor to mint is worse than one that never showed at all.
 */

/**
 * What counts as funded, in ETH.
 *
 * Not "greater than zero", which is what this used to be. Dust left over from
 * a sweep passes that test and mints nothing: 21,000 gas at any believable
 * price costs more than a wallet holding 0.00001 ETH has. This is a floor
 * chosen to sit above dust and below any real mint budget on this chain.
 */
export const FUNDED_MIN_ETH = 0.0002;

export function isFunded(balance: string | null | undefined): boolean {
  if (balance == null) return false;
  const n = Number(balance);
  return Number.isFinite(n) && n >= FUNDED_MIN_ETH;
}

/**
 * `count` of `pool`, drawn without replacement.
 *
 * Fisher-Yates over a copy. The naive "sort by Math.random()" is biased and,
 * worse, the bias is invisible — a spread of wallets that quietly favours one
 * end of the list is exactly the pattern this is meant to avoid.
 */
export function pickRandom<T>(pool: readonly T[], count: number): T[] {
  const out = [...pool];
  const take = Math.max(0, Math.min(count, out.length));
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (out.length - i));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, take);
}
