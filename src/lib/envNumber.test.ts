import { describe, expect, it } from "vitest";
import { envNumber } from "./envNumber";

describe("reading a number out of the environment", () => {
  it("takes the fallback when the variable is unset", () => {
    expect(envNumber(undefined, 100)).toBe(100);
  });

  it("takes the fallback when the variable is present but empty", () => {
    // `SNIPE_WAVE_SIZE=` in an env file. Number("") is 0, not NaN, so the
    // obvious implementation reads this as a deliberate zero and turns the
    // setting off — which is exactly how wave dispatch shipped disabled.
    expect(envNumber("", 100)).toBe(100);
    expect(envNumber("   ", 100)).toBe(100);
  });

  it("keeps 0 when someone actually types it", () => {
    expect(envNumber("0", 100)).toBe(0);
  });

  it("refuses 0 where 0 would be nonsense", () => {
    // A port of 0 or a poll interval of 0 is never what anyone meant.
    expect(envNumber("0", 8787, 1)).toBe(8787);
  });

  it("takes a plain number", () => {
    expect(envNumber("250", 100)).toBe(250);
  });

  it("trims surrounding whitespace, which env files collect", () => {
    expect(envNumber(" 250 ", 100)).toBe(250);
  });

  it("floors a fractional value rather than passing it on", () => {
    expect(envNumber("2.9", 100)).toBe(2);
  });

  it("falls back on anything that isn't a number", () => {
    expect(envNumber("lots", 100)).toBe(100);
    expect(envNumber("100ms", 100)).toBe(100);
    expect(envNumber("NaN", 100)).toBe(100);
    expect(envNumber("Infinity", 100)).toBe(100);
  });

  it("falls back on a negative value", () => {
    expect(envNumber("-5", 100)).toBe(100);
  });
});
