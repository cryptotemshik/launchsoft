import { describe, expect, it } from "vitest";
import { accountAge, compactCount, parseTwitterStats } from "./twitterStats";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-27T00:00:00Z");

describe("parseTwitterStats", () => {
  it("reads the nested shape one mirror uses", () => {
    expect(
      parseTwitterStats({
        code: 200,
        user: {
          screen_name: "pipedogsnft",
          followers: 136,
          tweets: 36,
          joined: "Wed Aug 12 10:14:10 +0000 2026",
        },
      }),
    ).toEqual({ followers: 136, tweets: 36, joinedMs: Date.parse("2026-08-12T10:14:10Z") });
  });

  it("reads the flat shape the other uses, under its own field names", () => {
    expect(
      parseTwitterStats({
        screen_name: "squirrelshood",
        followers_count: 17,
        tweet_count: 24,
        created_at: "Wed Aug 19 16:34:35 +0000 2026",
      }),
    ).toEqual({ followers: 17, tweets: 24, joinedMs: Date.parse("2026-08-19T16:34:35Z") });
  });

  it("keeps a real zero, which is a finding rather than a gap", () => {
    expect(parseTwitterStats({ screen_name: "brandnew", followers: 0 })).toEqual({
      followers: 0,
      tweets: null,
      joinedMs: null,
    });
  });

  it("refuses an error page served with a 200", () => {
    // Both mirrors do this when they are down, and a page that parses to
    // "no followers" would be worse than no answer at all.
    expect(parseTwitterStats("<!DOCTYPE html>")).toBeNull();
    expect(parseTwitterStats({ error: "Extract error" })).toBeNull();
    expect(parseTwitterStats(null)).toBeNull();
  });

  it("refuses a count that arrives without an account attached to it", () => {
    expect(parseTwitterStats({ followers: 500 })).toBeNull();
  });

  it("survives an unparseable join date", () => {
    expect(parseTwitterStats({ screen_name: "a", followers: 5, joined: "whenever" })?.joinedMs)
      .toBeNull();
  });
});

describe("accountAge", () => {
  it("counts in days while days still matter", () => {
    expect(accountAge(NOW - 8 * DAY, NOW)).toBe("8d");
    expect(accountAge(NOW - 13 * DAY, NOW)).toBe("13d");
  });

  it("moves up a unit as the account gets older", () => {
    expect(accountAge(NOW - 15 * DAY, NOW)).toBe("2w");
    expect(accountAge(NOW - 200 * DAY, NOW)).toBe("6mo");
    expect(accountAge(NOW - 1000 * DAY, NOW)).toBe("2y");
  });

  it("never reads as negative when the clocks disagree", () => {
    expect(accountAge(NOW + DAY, NOW)).toBe("0d");
  });
});

describe("compactCount", () => {
  it("keeps small counts exact — the difference between 17 and 136 is the point", () => {
    expect(compactCount(17)).toBe("17");
    expect(compactCount(999)).toBe("999");
  });

  it("shortens the big ones", () => {
    expect(compactCount(2_400)).toBe("2.4k");
    expect(compactCount(48_000)).toBe("48k");
    expect(compactCount(2_240_582)).toBe("2.2M");
    expect(compactCount(241_472_929)).toBe("241M");
  });
});
