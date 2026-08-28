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
const bid = (block: number, wei: string, col = COL) =>
  fill({ block, offer: [item(1, WETH, parseEther(wei).toString())], consideration: [item(2, col, "1", "9")] });

describe("finding a spread", () => {
  it("pairs a purchase with the best offer that followed it", () => {
    const opps = findOpportunities([bought(100, "0.01"), bid(200, "0.015"), bid(300, "0.02")], opts);
    expect(opps).toHaveLength(1);
    expect(opps[0].offerNetWei).toBe(parseEther("0.02"));
    expect(opps[0].profitWei).toBe(parseEther("0.02") - parseEther("0.01") - opts.gasWei);
  });

  it("ignores an offer that was accepted before the purchase", () => {
    // It proves a bid existed then, not now. Pairing backwards would invent
    // opportunities out of stale prices.
    expect(findOpportunities([bid(50, "0.02"), bought(100, "0.01")], opts)).toEqual([]);
  });

  it("ignores an offer past the window", () => {
    expect(findOpportunities([bought(100, "0.01"), bid(2000, "0.02")], opts)).toEqual([]);
  });

  it("does not pair across collections", () => {
    const other = "0x9302243bc2F3642cbA8c59c2cc7f876bf9d83915";
    expect(findOpportunities([bought(100, "0.01"), bid(200, "0.02", other)], opts)).toEqual([]);
  });

  it("subtracts gas before judging the threshold", () => {
    // A spread of exactly the threshold is not a trade once gas is paid.
    const opps = findOpportunities([bought(100, "0.01"), bid(200, "0.011")], opts);
    expect(opps).toEqual([]);
  });

  it("refuses a listing above the budget however good the spread", () => {
    const opps = findOpportunities([bought(100, "0.5"), bid(200, "0.9")], opts);
    expect(opps).toEqual([]);
  });

  it("adds up the spread per collection, biggest first", () => {
    const other = "0x9302243bc2F3642cbA8c59c2cc7f876bf9d83915";
    const opps = findOpportunities(
      [
        bought(100, "0.01"), bid(150, "0.02"),
        bought(100, "0.01", other), bid(150, "0.05", other),
      ],
      opts,
    );
    const rows = byCollection(opps);
    expect(rows).toHaveLength(2);
    expect(rows[0].collection).toBe(other.toLowerCase());
    expect(rows[0].trades).toBe(1);
    expect(rows[0].profitWei > rows[1].profitWei).toBe(true);
  });
});
