import { describe, expect, it } from "vitest";
import { readMintedCount } from "./collectionData";

const TARGET = "0xc60079d77bbFb225632999564673f4E334F8D9dd" as `0x${string}`;

/** A client that answers only the function names it is given. */
function client(answers: Record<string, unknown>, seen: string[] = []) {
  return {
    seen,
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        seen.push(functionName);
        if (!(functionName in answers)) throw new Error("execution reverted");
        return answers[functionName];
      },
    } as never,
  };
}

describe("counting what has been minted", () => {
  it("uses totalSupply when the collection answers it", async () => {
    const { client: c, seen } = client({ totalSupply: 42n });
    expect(await readMintedCount(c, TARGET)).toBe(42n);
    // And stops there — the fallbacks cost a round trip each.
    expect(seen).toEqual(["totalSupply"]);
  });

  it("falls back to getMintStats when totalSupply reverts", async () => {
    // Hoodwinked's real shape: 426 of 3000 minted, and totalSupply reverting
    // anyway — so this is not a not-started-yet case that fixes itself.
    const { client: c } = client({ getMintStats: [0n, 426n, 3000n] });
    expect(await readMintedCount(c, TARGET)).toBe(426n);
  });

  it("takes the middle word of getMintStats, not the first or last", async () => {
    // minterNumMinted, currentTotalSupply, maxSupply — reading the wrong one
    // would report 3000 minted for an untouched drop.
    const { client: c } = client({ getMintStats: [7n, 426n, 3000n] });
    expect(await readMintedCount(c, TARGET)).toBe(426n);
  });

  it("falls back again to totalMinted", async () => {
    const { client: c } = client({ totalMinted: 99n });
    expect(await readMintedCount(c, TARGET)).toBe(99n);
  });

  it("reports nothing minted rather than failing the whole read", async () => {
    // The fault this exists to stop: one reverting call inside a Promise.all
    // took the name, the price and the stage down with it, and the panel
    // refused to queue a drop that was minting at that moment.
    const { client: c, seen } = client({});
    expect(await readMintedCount(c, TARGET)).toBe(0n);
    expect(seen).toEqual(["totalSupply", "getMintStats", "totalMinted"]);
  });
});
