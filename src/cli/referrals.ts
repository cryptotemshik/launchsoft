/**
 * The referral programme — pure logic, no I/O.
 *
 * An influencer shares a code; anyone who signs up through it is bound to them
 * for good. The referrer earns a percentage of what their *paying* referrals
 * spend — Pro subscriptions and snipe fees — and the percentage climbs with how
 * many paying referrals they have brought (the tiers). The referred user, in
 * turn, gets a one-time discount on their first Pro month, so the code is worth
 * using on both sides.
 *
 * Who owns whom, who has paid, and the crediting all live in accounts/billing;
 * this file only does the arithmetic and the codes, so it is trivially testable.
 */
import { randomBytes } from "node:crypto";

export interface RefTier {
  /** 1, 2, 3 … — shown to the user. */
  tier: number;
  /** Paying referrals needed to reach this tier. */
  minPaying: number;
  /** Percent of a referral's spend the referrer earns at this tier. */
  pct: number;
}

/**
 * The ladder. Reach the count, earn the percent — of both Pro payments and
 * snipe fees. Tuned to be generous enough to matter to an influencer while the
 * margins still work (Pro is $29.99, the snipe fee $2).
 */
export const REFERRAL_TIERS: RefTier[] = [
  { tier: 1, minPaying: 1, pct: 10 },
  { tier: 2, minPaying: 5, pct: 20 },
  { tier: 3, minPaying: 20, pct: 30 },
];

/** The one-time discount a referred user gets on their first Pro payment, %. */
export const REFEREE_DISCOUNT_PCT = 20;

export interface TierStanding {
  /** 0 when they have no paying referrals yet. */
  tier: number;
  /** Percent earned right now. */
  pct: number;
  /** The next tier up, if any — for a "3 more to 20%" hint. */
  next: RefTier | null;
}

/** Where a referrer with `paying` paying referrals stands on the ladder. */
export function tierForPaying(paying: number, tiers: RefTier[] = REFERRAL_TIERS): TierStanding {
  const sorted = [...tiers].sort((a, b) => a.minPaying - b.minPaying);
  let cur: RefTier | null = null;
  for (const t of sorted) if (paying >= t.minPaying) cur = t;
  const next = sorted.find((t) => t.minPaying > paying) ?? null;
  return { tier: cur?.tier ?? 0, pct: cur?.pct ?? 0, next };
}

/** Referral commission on an amount at a percent, floored to whole wei. */
export function commissionWei(amountWei: bigint, pct: number): bigint {
  if (amountWei <= 0n || pct <= 0) return 0n;
  return (amountWei * BigInt(Math.round(pct))) / 100n;
}

/** A referee's first-Pro-payment amount after their one-time discount. */
export function refereeDiscountedWei(amountWei: bigint, pct = REFEREE_DISCOUNT_PCT): bigint {
  if (amountWei <= 0n || pct <= 0) return amountWei;
  return amountWei - (amountWei * BigInt(Math.round(pct))) / 100n;
}

// Unambiguous alphabet — no 0/o, 1/l, so a code read off a stream is typable.
const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A fresh referral code. Six chars is ~10^9 space — plenty, still short. */
export function genReferralCode(len = 6): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

/** Normalise a code coming from a URL or an input: lower-case, safe chars only. */
export function normRefCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
}
