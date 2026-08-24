import { describe, expect, it } from "vitest";
import { buildCumulativeSeries, dedupeByReceiver, niceTicks } from "./series";
import { parseCollectionInput } from "./convert";
import { estimateVolumeFromRoyalties } from "./profit";

const ETH = 10n ** 18n;

describe("buildCumulativeSeries", () => {
  it("accumulates sorted events and extends to now", () => {
    const s = buildCumulativeSeries(
      [
        { t: 200, wei: 2n * ETH },
        { t: 100, wei: ETH },
        { t: 300, wei: -ETH },
      ],
      1000,
    );
    expect(s.map((p) => [p.t, p.cum])).toEqual([
      [99, 0n],
      [100, ETH],
      [200, 3n * ETH],
      [300, 2n * ETH],
      [1000, 2n * ETH],
    ]);
  });

  it("merges same-timestamp events into one point", () => {
    const s = buildCumulativeSeries(
      [
        { t: 100, wei: ETH },
        { t: 100, wei: ETH },
      ],
      200,
    );
    expect(s).toEqual([
      { t: 99, cum: 0n },
      { t: 100, cum: 2n * ETH },
      { t: 200, cum: 2n * ETH },
    ]);
  });

  it("folds unknown-timestamp events into the baseline instead of a 1970 tail", () => {
    const s = buildCumulativeSeries(
      [
        { t: 0, wei: -ETH },
        { t: 100, wei: 3n * ETH },
      ],
      200,
    );
    expect(s[0]).toEqual({ t: 99, cum: -ETH });
    expect(s[1]).toEqual({ t: 100, cum: 2n * ETH });
  });

  it("handles empty and unknown-only inputs", () => {
    expect(buildCumulativeSeries([], 100)).toEqual([]);
    const s = buildCumulativeSeries([{ t: 0, wei: ETH }], 100);
    expect(s[s.length - 1]).toEqual({ t: 100, cum: ETH });
  });
});

describe("dedupeByReceiver", () => {
  it("counts a shared royalty receiver only once", () => {
    const a = { receiver: "0xAAA", events: [{ t: 1, wei: ETH }] };
    const b = { receiver: "0xaaa", events: [{ t: 1, wei: ETH }] };
    const c = { receiver: "0xBBB", events: [{ t: 2, wei: 2n * ETH }] };
    const merged = dedupeByReceiver([a, b, c]);
    expect(merged.reduce((s, e) => s + e.wei, 0n)).toBe(3n * ETH);
  });
});

describe("niceTicks", () => {
  it("produces round ticks covering the range", () => {
    const ticks = niceTicks(0n, ETH); // 0..1 ETH
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(1);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });
  it("survives a flat series", () => {
    expect(niceTicks(ETH, ETH)).toEqual([1]);
  });
});

describe("parseCollectionInput", () => {
  const addr = "0x21da691b3E0ee6Ae2b4657bf09cb2d2d7f6fdF48";
  it("accepts bare addresses and common URLs", () => {
    expect(parseCollectionInput(addr)).toBe(addr);
    expect(parseCollectionInput(` ${addr} `)).toBe(addr);
    expect(
      parseCollectionInput(`https://opensea.io/assets/robinhood/${addr}`),
    ).toBe(addr);
    expect(
      parseCollectionInput(`https://opensea.io/item/robinhood/${addr}/5`),
    ).toBe(addr);
    expect(
      parseCollectionInput(`https://robinhoodchain.blockscout.com/address/${addr}`),
    ).toBe(addr);
    expect(
      parseCollectionInput(`https://robinhoodchain.blockscout.com/token/${addr}?tab=holders`),
    ).toBe(addr);
  });
  it("rejects garbage", () => {
    expect(parseCollectionInput("")).toBeNull();
    expect(parseCollectionInput("https://opensea.io/collection/some-slug")).toBeNull();
    expect(parseCollectionInput("0x123")).toBeNull();
  });
});

describe("estimateVolumeFromRoyalties", () => {
  it("derives volume = royalties / bps", () => {
    // 0.05 ETH royalties at 5% → 1 ETH volume
    expect(estimateVolumeFromRoyalties(ETH / 20n, 500)).toBe(ETH);
  });
  it("returns null without royalties", () => {
    expect(estimateVolumeFromRoyalties(ETH, 0)).toBeNull();
  });
});
