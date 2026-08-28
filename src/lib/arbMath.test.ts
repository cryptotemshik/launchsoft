import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { byCollection, findOpportunities, priceFill, type Fill } from "./arbMath";

const COL = "0xC60079d77bbfb225632999564673f4E334F8D9dd";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const item = (itemType: number, token: string, amount: string, identifier = "0") => ({
  itemType, token, identifier, amount,
});
const fill = (over: Partial<Fill>): Fill => ({
  block: 100, offerer: "0xa", recipient: "0xb", offer: [], consideration: [], ...over,
});

describe("reading a fill", () => {
  it("prices a listing at the whole consideration, fees included", () => {
    // Fees and royalty come out of what the buyer pays, so the cost of the
    // buy leg is every native item — not just the seller's share.
    const p = priceFill(fill({
      offer: [item(2, COL, "1", "7")],
      consideration: [item(0, "0x0", "1000"), item(0, "0x0", "25"), item(0, "0x0", "50")],
    }));
    expect(p).toMatchObject({ kind: "listing", collection: COL.toLowerCase(), tokenId: "7" });
    expect(p!.paidWei).toBe(1075n);
  });

  it("prices an accepted offer net of its fees", () => {
    // The bidder puts up 1000; the fee and royalty items come out of that, so
    // the seller nets 900. Comparing the gross would invent 100 wei of profit.
    const p = priceFill(fill({
      offer: [item(1, WETH, "1000")],
      consideration: [item(2, COL, "1", "7"), item(1, WETH, "25"), item(1, WETH, "75")],
    }));
    expect(p).toMatchObject({ kind: "offer", currency: WETH.toLowerCase() });
    expect(p!.netWei).toBe(900n);
  });

  it("never reports a negative net when fees exceed the offer", () => {
    const p = priceFill(fill({
      offer: [item(1, WETH, "50")],
      consideration: [item(2, COL, "1", "7"), item(1, WETH, "80")],
    }));
    expect(p!.netWei).toBe(0n);
  });

  it("leaves a bundle alone rather than pricing it as one token", () => {
    // A collection offer cannot absorb a bundle, so pricing it would produce
    // an opportunity that could not be executed.
    expect(priceFill(fill({
      offer: [item(2, COL, "1", "7"), item(2, COL, "1", "8")],
      consideration: [item(0, "0x0", "1000")],
    }))).toBeNull();
  });

  it("skips a listing priced in ERC20 — that is not the buy leg", () => {
    expect(priceFill(fill({
      offer: [item(2, COL, "1", "7")],
      consideration: [item(1, WETH, "1000")],
    }))).toBeNull();
  });

  it("skips an ERC20 offer that buys nothing", () => {
    expect(priceFill(fill({ offer: [item(1, WETH, "1000")], consideration: [] }))).toBeNull();
  });
});

const opts = {
  windowBlocks: 1000,
  gasWei: parseEther("0.0000175"),
  minProfitWei: parseEther("0.001"),
  maxPaidWei: parseEther("0.3"),
};
const bought = (block: number, wei: string, col = COL) =>
  fill({ block, offer: [item(2, col, "1", "7")], consideration: [item(0, "0x0", parseEther(wei).toString())] });
/**
 * One fill of a bid order. `hash` is what ties fills of the same order
 * together — the only way the chain shows that a bid was still standing.
 */
const bid = (block: number, wei: string, hash = "0xorder", col = COL) =>
  fill({
    orderHash: hash,
    block,
    offer: [item(1, WETH, parseEther(wei).toString())],
    consideration: [item(2, col, "1", "9")],
  });
/** A bid proven to have stood across `block`: filled before it and after. */
const standing = (before: number, after: number, wei: string, hash = "0xorder", col = COL) => [
  bid(before, wei, hash, col),
  bid(after, wei, hash, col),
];

describe("finding a spread", () => {
  it("takes a bid proven to have stood across the purchase", () => {
    const opps = findOpportunities([...standing(50, 200, "0.02"), bought(100, "0.01")], opts);
    expect(opps).toHaveLength(1);
    expect(opps[0].offerNetWei).toBe(parseEther("0.02"));
    expect(opps[0].profitWei).toBe(parseEther("0.02") - parseEther("0.01") - opts.gasWei);
  });

  it("refuses a bid only ever seen after the purchase", () => {
    // The flaw this replaces. The chain shows when an order was consumed, not
    // when it was placed, and a bid that fills more than once lives a median
    // of twelve seconds — so one accepted five minutes later was almost
    // certainly not there when the listing was bought. Assuming otherwise
    // turned 7 real chances into 253 imaginary ones.
    expect(findOpportunities([bought(100, "0.01"), bid(200, "0.02")], opts)).toEqual([]);
    expect(findOpportunities([bought(100, "0.01"), bid(150, "0.02"), bid(200, "0.02")], opts)).toEqual([]);
  });

  it("refuses a bid only ever seen before the purchase", () => {
    expect(findOpportunities([bid(50, "0.02"), bid(60, "0.02"), bought(100, "0.01")], opts)).toEqual([]);
  });

  it("refuses a bid seen exactly once, which cannot straddle anything", () => {
    expect(findOpportunities([bid(50, "0.02"), bought(100, "0.01")], opts)).toEqual([]);
  });

  it("ignores an order that lived far longer than the window", () => {
    // Filled two hours apart says little about any particular second between.
    expect(findOpportunities([...standing(1, 5000, "0.02"), bought(100, "0.01")], opts)).toEqual([]);
  });

  it("does not pair across collections", () => {
    const other = "0x9302243bc2F3642cbA8c59c2cc7f876bf9d83915";
    const opps = findOpportunities(
      [...standing(50, 200, "0.02", "0xorder", other), bought(100, "0.01")],
      opts,
    );
    expect(opps).toEqual([]);
  });

  it("subtracts gas before judging the threshold", () => {
    expect(findOpportunities([...standing(50, 200, "0.011"), bought(100, "0.01")], opts)).toEqual([]);
  });

  it("refuses a listing above the budget however good the spread", () => {
    expect(findOpportunities([...standing(50, 200, "0.9"), bought(100, "0.5")], opts)).toEqual([]);
  });

  it("lets an order back as many purchases as it had fills, and no more", () => {
    // Two fills is two tokens taken; a third purchase has nothing left to sell
    // into.
    const opps = findOpportunities(
      [...standing(50, 200, "0.05"), bought(100, "0.01"), bought(110, "0.01"), bought(120, "0.01")],
      opts,
    );
    expect(opps).toHaveLength(2);
  });

  it("adds up the spread per collection, biggest first", () => {
    const other = "0x9302243bc2F3642cbA8c59c2cc7f876bf9d83915";
    const opps = findOpportunities(
      [
        ...standing(50, 200, "0.02", "0xa"),
        bought(100, "0.01"),
        ...standing(50, 200, "0.05", "0xb", other),
        bought(100, "0.01", other),
      ],
      opts,
    );
    const rows = byCollection(opps);
    expect(rows).toHaveLength(2);
    expect(rows[0].collection).toBe(other.toLowerCase());
    expect(rows[0].profitWei > rows[1].profitWei).toBe(true);
  });
});

