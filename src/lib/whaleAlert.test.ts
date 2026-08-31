import { describe, expect, it } from "vitest";
import { groupWhaleEntries } from "./whaleAlert";
import type { WalletEvent } from "./activity";

let n = 0;
function ev(
  wallet: string,
  contract: string,
  kind: WalletEvent["kind"],
  t: number,
): WalletEvent {
  return {
    id: `${wallet}:${++n}`,
    wallet: wallet as `0x${string}`,
    kind,
    collection: contract === "0xcoll" ? "Cool Cats" : "NFT",
    contract,
    txHash: `0x${n}`,
    t,
  };
}

const W1 = `0x${"11".repeat(20)}`;
const W2 = `0x${"22".repeat(20)}`;
const W3 = `0x${"33".repeat(20)}`;
const W4 = `0x${"44".repeat(20)}`;

describe("grouping whale entries", () => {
  it("flags a collection only once three distinct whales acquire it", () => {
    const events = [
      ev(W1, "0xcoll", "mint", 100),
      ev(W2, "0xcoll", "buy", 110),
    ];
    expect(groupWhaleEntries(events)).toHaveLength(0); // only two
    events.push(ev(W3, "0xcoll", "buy", 120));
    const groups = groupWhaleEntries(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].whales).toEqual([W1, W2, W3]); // in entry order
    expect(groups[0].collection).toBe("Cool Cats");
  });

  it("counts each whale once however many times it buys", () => {
    const events = [
      ev(W1, "0xcoll", "buy", 100),
      ev(W1, "0xcoll", "buy", 101),
      ev(W2, "0xcoll", "buy", 102),
      ev(W3, "0xcoll", "mint", 103),
    ];
    expect(groupWhaleEntries(events)[0].count).toBe(3);
  });

  it("keeps the fourth whale so the component can shout again", () => {
    const events = [
      ev(W1, "0xcoll", "buy", 100),
      ev(W2, "0xcoll", "buy", 101),
      ev(W3, "0xcoll", "buy", 102),
      ev(W4, "0xcoll", "buy", 103),
    ];
    expect(groupWhaleEntries(events)[0].whales).toEqual([W1, W2, W3, W4]);
  });

  it("ignores gifts and sends — only mints and buys count", () => {
    const events = [
      ev(W1, "0xcoll", "receive", 100),
      ev(W2, "0xcoll", "receive", 101),
      ev(W3, "0xcoll", "send", 102),
    ];
    expect(groupWhaleEntries(events)).toHaveLength(0);
  });

  it("respects a time window", () => {
    const events = [
      ev(W1, "0xcoll", "buy", 100),
      ev(W2, "0xcoll", "buy", 110),
      ev(W3, "0xcoll", "buy", 120),
    ];
    expect(groupWhaleEntries(events, { sinceT: 105 })).toHaveLength(0); // only two after 105
  });
});
