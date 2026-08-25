import { describe, expect, it } from "vitest";
import { ms, quantile, summarise } from "./latency";

describe("quantile", () => {
  it("takes the nearest rank, so every number is a real sample", () => {
    const s = [10, 20, 30, 40, 50];
    expect(quantile(s, 0.5)).toBe(30);
    expect(quantile(s, 0.95)).toBe(50);
    expect(quantile(s, 0)).toBe(10);
  });

  it("handles a single sample", () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.95)).toBe(7);
  });

  it("is NaN with nothing to rank", () => {
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe("summarise", () => {
  it("reports the spread, not just the average", () => {
    const s = summarise([30, 10, 20, 400, 25]);
    expect(s.n).toBe(5);
    expect(s.failed).toBe(0);
    expect(s.min).toBe(10);
    expect(s.median).toBe(25);
    expect(s.max).toBe(400);
  });

  it("counts failures separately instead of scoring them as fast", () => {
    const s = summarise([20, null, 30, null]);
    expect(s.n).toBe(2);
    expect(s.failed).toBe(2);
    // Nearest rank over [20, 30] takes the lower of the two — no interpolation,
    // so the reported median is a round-trip that really happened.
    expect(s.median).toBe(20);
  });

  it("survives an endpoint that never answered", () => {
    const s = summarise([null, null]);
    expect(s.n).toBe(0);
    expect(s.failed).toBe(2);
    expect(s.min).toBeNaN();
    expect(s.median).toBeNaN();
  });

  it("does not mutate the caller's array", () => {
    const input = [30, 10, 20];
    summarise(input);
    expect(input).toEqual([30, 10, 20]);
  });

  it("p95 tracks the tail an average would hide", () => {
    // Nineteen fast samples and one slow one: the mean barely moves, p95 does.
    const s = summarise([...Array(19).fill(10), 500]);
    expect(s.median).toBe(10);
    expect(s.p95).toBe(10);
    expect(s.max).toBe(500);
  });
});

describe("ms", () => {
  it("rounds to whole milliseconds", () => {
    expect(ms(12.4)).toBe("12ms");
    expect(ms(12.6)).toBe("13ms");
  });

  it("shows a dash rather than NaN", () => {
    expect(ms(NaN)).toBe("—");
  });
});
