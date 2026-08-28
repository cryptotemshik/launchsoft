import { afterEach, describe, expect, it } from "vitest";
import { waveGapMs, waveSize } from "./runner";

const set = (v: string | undefined) => {
  if (v === undefined) delete process.env.SNIPE_WAVE_SIZE;
  else process.env.SNIPE_WAVE_SIZE = v;
};

afterEach(() => {
  delete process.env.SNIPE_WAVE_SIZE;
  delete process.env.SNIPE_WAVE_GAP_MS;
});

describe("reading the wave settings from the environment", () => {
  it("uses the default when the variable is unset", () => {
    // The bug this exists for: Number("") is 0, not NaN, so an unset variable
    // read as an explicit "off" and wave dispatch shipped disabled.
    set(undefined);
    expect(waveSize()).toBe(100);
  });

  it("uses the default when the variable is set to nothing", () => {
    // `SNIPE_WAVE_SIZE=` in an env file is the same as not setting it.
    set("");
    expect(waveSize()).toBe(100);
  });

  it("uses the default for whitespace", () => {
    set("   ");
    expect(waveSize()).toBe(100);
  });

  it("still lets 0 turn the split off, because that is a real setting", () => {
    set("0");
    expect(waveSize()).toBe(0);
  });

  it("takes a number", () => {
    set("250");
    expect(waveSize()).toBe(250);
  });

  it("ignores a value that isn't a number", () => {
    set("lots");
    expect(waveSize()).toBe(100);
  });

  it("ignores a negative value", () => {
    set("-5");
    expect(waveSize()).toBe(100);
  });

  it("reads the gap the same way", () => {
    expect(waveGapMs()).toBe(40);
    process.env.SNIPE_WAVE_GAP_MS = "";
    expect(waveGapMs()).toBe(40);
    process.env.SNIPE_WAVE_GAP_MS = "15";
    expect(waveGapMs()).toBe(15);
  });
});
