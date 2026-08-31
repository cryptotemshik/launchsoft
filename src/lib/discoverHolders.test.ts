import { describe, expect, it } from "vitest";
import { parseHolders } from "./discoverHolders";

describe("parsing Blockscout holders", () => {
  it("ranks by count, drops junk, applies the limit", () => {
    const data = {
      items: [
        { address: { hash: "0x" + "aa".repeat(20) }, value: "3" },
        { address: { hash: "0x" + "bb".repeat(20) }, value: "10" },
        { address: { hash: "not-an-address" }, value: "99" },
        { address: {}, value: "1" },
        { address: { hash: "0x" + "cc".repeat(20) }, value: 7 },
      ],
    };
    const top = parseHolders(data, 2);
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({ address: "0x" + "bb".repeat(20), count: 10 });
    expect(top[1]).toEqual({ address: "0x" + "cc".repeat(20), count: 7 });
  });

  it("is empty for an empty response", () => {
    expect(parseHolders({})).toEqual([]);
    expect(parseHolders({ items: [] })).toEqual([]);
  });
});
