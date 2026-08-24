import { describe, expect, it } from "vitest";
import {
  datetimeLocalToUnix,
  ethToWei,
  formatCountdown,
  timeAgo,
  isAddress,
  normalizePrivateKey,
  normalizeProvenanceHash,
  UINT80_MAX,
  weiToEth,
} from "./convert";

describe("ethToWei", () => {
  it("converts ETH strings to wei", () => {
    expect(ethToWei("1")).toBe(10n ** 18n);
    expect(ethToWei("0.02")).toBe(2n * 10n ** 16n);
    expect(ethToWei(".5")).toBe(5n * 10n ** 17n);
    expect(ethToWei("0")).toBe(0n);
    expect(ethToWei(" 0.001 ")).toBe(10n ** 15n);
  });

  it("rejects garbage — no $ prices on-chain", () => {
    expect(() => ethToWei("$5")).toThrow();
    expect(() => ethToWei("5 USD")).toThrow();
    expect(() => ethToWei("1,5")).toThrow();
    expect(() => ethToWei("-1")).toThrow();
    expect(() => ethToWei("")).toThrow();
    expect(() => ethToWei("1e18")).toThrow();
  });

  it("enforces the uint80 PublicDrop.mintPrice bound", () => {
    // 1.3M ETH overflows uint80.
    expect(() => ethToWei("1300000")).toThrow(/uint80/);
    expect(UINT80_MAX).toBe(2n ** 80n - 1n);
  });

  it("round-trips through weiToEth", () => {
    expect(weiToEth(ethToWei("0.02"))).toBe("0.02");
  });
});

describe("datetimeLocalToUnix", () => {
  it("treats the input as local wall-clock time", () => {
    const unix = datetimeLocalToUnix("2026-08-20T21:00");
    expect(unix).toBe(Math.floor(new Date(2026, 7, 20, 21, 0).getTime() / 1000));
  });

  it("rejects invalid dates", () => {
    expect(() => datetimeLocalToUnix("")).toThrow();
    expect(() => datetimeLocalToUnix("not-a-date")).toThrow();
  });
});

describe("formatCountdown", () => {
  it("formats", () => {
    expect(formatCountdown(-5)).toBe("live now");
    expect(formatCountdown(90)).toBe("1m 30s");
    expect(formatCountdown(3 * 3600 + 120)).toBe("3h 2m 0s");
    expect(formatCountdown(2 * 86400 + 3600)).toBe("2d 1h 0m");
  });
});

describe("normalizeProvenanceHash", () => {
  const hash = "a".repeat(64);

  it("accepts 64 hex chars with or without 0x", () => {
    expect(normalizeProvenanceHash(hash)).toBe(`0x${hash}`);
    expect(normalizeProvenanceHash(`0x${hash}`)).toBe(`0x${hash}`);
    expect(normalizeProvenanceHash(`0x${hash.toUpperCase()}`)).toBe(`0x${hash}`);
  });

  it("returns null for empty input", () => {
    expect(normalizeProvenanceHash("")).toBeNull();
    expect(normalizeProvenanceHash("   ")).toBeNull();
  });

  it("rejects wrong lengths and non-hex", () => {
    expect(() => normalizeProvenanceHash("abc")).toThrow();
    expect(() => normalizeProvenanceHash(`0x${"g".repeat(64)}`)).toThrow();
  });
});

describe("normalizePrivateKey", () => {
  const hex = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
  it("accepts 64 hex with or without 0x and lowercases", () => {
    expect(normalizePrivateKey(hex)).toBe(`0x${hex}`);
    expect(normalizePrivateKey(`0x${hex}`)).toBe(`0x${hex}`);
    expect(normalizePrivateKey(`0X${hex.toUpperCase()}`)).toBe(`0x${hex}`);
    expect(normalizePrivateKey(`  ${hex}  `)).toBe(`0x${hex}`);
  });
  it("rejects wrong length or non-hex", () => {
    expect(() => normalizePrivateKey("")).toThrow();
    expect(() => normalizePrivateKey("0x1234")).toThrow();
    expect(() => normalizePrivateKey("z".repeat(64))).toThrow();
    expect(() => normalizePrivateKey(hex + "00")).toThrow();
  });
});

describe("isAddress", () => {
  it("accepts 20-byte hex addresses", () => {
    expect(isAddress("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress("00005EA00Ac477B1030CE78506496e8C2dE24bf5")).toBe(false);
  });
});

describe("timeAgo", () => {
  const now = 1_000_000_000_000; // fixed "now" in ms
  const at = (secsAgo: number) => Math.floor(now / 1000) - secsAgo;
  it("renders compact buckets", () => {
    expect(timeAgo(at(2), now)).toBe("just now");
    expect(timeAgo(at(30), now)).toBe("30s");
    expect(timeAgo(at(90), now)).toBe("1m");
    expect(timeAgo(at(3 * 3600), now)).toBe("3h");
    expect(timeAgo(at(2 * 86400), now)).toBe("2d");
    expect(timeAgo(at(3 * 7 * 86400), now)).toBe("3w");
    expect(timeAgo(at(90 * 86400), now)).toBe("3mo");
  });
});
