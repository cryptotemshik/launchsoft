import { describe, expect, it } from "vitest";
import {
  commissionWei,
  genReferralCode,
  normRefCode,
  refereeDiscountedWei,
  REFERRAL_TIERS,
  tierForPaying,
} from "./referrals";

describe("referral tiers", () => {
  it("no paying referrals → tier 0, next is tier 1", () => {
    const s = tierForPaying(0);
    expect(s.tier).toBe(0);
    expect(s.pct).toBe(0);
    expect(s.next?.tier).toBe(1);
  });

  it("climbs the ladder at the thresholds", () => {
    expect(tierForPaying(1).pct).toBe(10);
    expect(tierForPaying(4).pct).toBe(10);
    expect(tierForPaying(5).pct).toBe(20);
    expect(tierForPaying(19).pct).toBe(20);
    expect(tierForPaying(20).pct).toBe(30);
    expect(tierForPaying(999).pct).toBe(30);
  });

  it("names the next tier until the top", () => {
    expect(tierForPaying(1).next?.minPaying).toBe(5);
    expect(tierForPaying(5).next?.minPaying).toBe(20);
    expect(tierForPaying(20).next).toBeNull();
  });

  it("tiers are ordered and sane", () => {
    expect(REFERRAL_TIERS.map((t) => t.tier)).toEqual([1, 2, 3]);
  });
});

describe("commission math", () => {
  it("takes the percent, floored to wei", () => {
    expect(commissionWei(1000n, 10)).toBe(100n);
    expect(commissionWei(1000n, 30)).toBe(300n);
    expect(commissionWei(999n, 10)).toBe(99n); // floor
  });
  it("is zero for non-positive inputs", () => {
    expect(commissionWei(0n, 30)).toBe(0n);
    expect(commissionWei(1000n, 0)).toBe(0n);
    expect(commissionWei(-5n, 30)).toBe(0n);
  });
});

describe("referee discount", () => {
  it("knocks off the discount percent", () => {
    expect(refereeDiscountedWei(1000n, 20)).toBe(800n);
    expect(refereeDiscountedWei(1000n, 0)).toBe(1000n);
  });
});

describe("codes", () => {
  it("generates codes of the requested length from the safe alphabet", () => {
    const c = genReferralCode(6);
    expect(c).toHaveLength(6);
    expect(c).toMatch(/^[a-z2-9]+$/);
    expect(c).not.toMatch(/[0o1l]/);
  });
  it("normalises user/URL input", () => {
    expect(normRefCode("  ABC-123 ")).toBe("abc123");
    expect(normRefCode("Zx9!!")).toBe("zx9");
  });
});
