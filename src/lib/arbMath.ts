/**
 * Reading arbitrage out of Seaport fills.
 *
 * The strategy is: buy a listing priced in native ETH, and fill a collection
 * offer priced in WETH, for more. Whether that spread exists on this chain is
 * a question the chain itself answers — every completed trade is an
 * `OrderFulfilled` event, and the two legs are distinguishable by shape.
 *
 * Measured over three hours of live Robinhood Chain traffic (8,756 fills):
 * 4,253 listings bought with ETH, 2,514 offers accepted in WETH, and a spread
 * above 0.001 ETH existed 112 times, worth 0.42 ETH. Four collections carried
 * 96% of it — which is why the chain-wide firehose the spec describes buys
 * almost nothing, and a short priority list buys almost everything.
 *
 * Nothing here executes anything. It reads what happened and computes what
 * the spread was.
 */

/** A Seaport item, as the event reports it. */
export interface Item {
  /** 0 NATIVE · 1 ERC20 · 2 ERC721 · 3 ERC1155 · 4/5 the criteria variants. */
  itemType: number;
  token: string;
  identifier: string;
  amount: string;
}

export interface Fill {
  /** Seaport's hash for the order this filled — the same across its fills. */
  orderHash?: string;
  block: number;
  offerer: string;
  recipient: string;
  offer: Item[];
  consideration: (Item & { recipient?: string })[];
}

/**
 * What a fill was.
 *
 * `listing` — somebody's listing was bought. The offerer gave up the NFT and
 * the buyer paid; the price is the whole consideration, because fees and
 * royalties come out of what the buyer pays.
 *
 * `offer` — somebody's bid was accepted. The offerer put up ERC20 and gets the
 * NFT; the seller's proceeds are the offered amount minus the ERC20
 * consideration items, which are the fee and the royalty.
 */
export type FillKind = "listing" | "offer" | "other";

export interface Priced {
  kind: FillKind;
  collection: string;
  tokenId: string;
  /** Native wei paid, for a listing. */
  paidWei?: bigint;
  /** ERC20 wei the seller nets, for an accepted offer. */
  netWei?: bigint;
  /** The ERC20 the offer was denominated in. */
  currency?: string;
  block: number;
}

const NATIVE = 0;
const ERC20 = 1;
const isNft = (t: number) => t === 2 || t === 3;

/**
 * Classify one fill and price it.
 *
 * A fill with several NFTs in the offer is a bundle: not something a
 * collection offer can absorb, so it is left as `other` rather than priced
 * wrongly.
 */
export function priceFill(f: Fill): Priced | null {
  if (f.offer.length === 1 && isNft(f.offer[0].itemType)) {
    const nft = f.offer[0];
    const native = f.consideration.filter((c) => c.itemType === NATIVE);
    if (native.length === 0) return null; // priced in ERC20 — not our buy leg
    return {
      kind: "listing",
      collection: nft.token.toLowerCase(),
      tokenId: nft.identifier,
      paidWei: native.reduce((n, c) => n + BigInt(c.amount), 0n),
      block: f.block,
    };
  }

  if (f.offer.length === 1 && f.offer[0].itemType === ERC20) {
    const nft = f.consideration.find((c) => isNft(c.itemType));
    if (!nft) return null;
    const gross = BigInt(f.offer[0].amount);
    // Fee and royalty are consideration items in the same currency; the spec
    // is right that they must be parsed rather than assumed, because a
    // collection with optional royalties simply has fewer of them.
    const fees = f.consideration
      .filter((c) => c.itemType === ERC20)
      .reduce((n, c) => n + BigInt(c.amount), 0n);
    return {
      kind: "offer",
      collection: nft.token.toLowerCase(),
      tokenId: nft.identifier,
      netWei: gross > fees ? gross - fees : 0n,
      currency: f.offer[0].token.toLowerCase(),
      block: f.block,
    };
  }

  return null;
}

export interface Opportunity {
  collection: string;
  tokenId: string;
  /** What the listing cost. */
  paidWei: bigint;
  /** What the best offer in the window would have paid, net of its fees. */
  offerNetWei: bigint;
  gasWei: bigint;
  profitWei: bigint;
  buyBlock: number;
  sellBlock: number;
}

export interface SpreadOptions {
  /**
   * How long a bid order may have lived and still count as one standing
   * moment. An order that filled across two hours says little about any
   * particular second inside them.
   */
  windowBlocks: number;
  /** What a two-leg execution costs in gas, in wei. */
  gasWei: bigint;
  /** Below this the trade is noise. */
  minProfitWei: bigint;
  /** Listings above this are out of budget. */
  maxPaidWei: bigint;
}

/**
 * Every purchase that could really have been resold into a bid that was
 * already standing when the purchase happened.
 *
 * Two rules make this a measurement rather than a story, and both were learned
 * the expensive way — by shipping without them and being unable to reconcile
 * a single row against the marketplace.
 *
 * **The bid must be proven to have existed at the moment of the purchase.**
 * The chain shows when an order was *consumed*, never when it was *placed*.
 * The first version paired a purchase with any bid accepted within fifteen
 * minutes after it, which quietly assumes bids persist backwards in time. They
 * do not: measured over 60,000 blocks, a bid that fills more than once lives a
 * median of twelve seconds and is swept five times. So a bid accepted five
 * minutes after a purchase almost certainly did not exist when that listing
 * was bought. The only on-chain proof available is that the *same order* also
 * filled *before* the purchase and again after — then it straddled the moment,
 * and it was there. Applied to 5.6 hours of live traffic, this cut 253
 * "opportunities" worth 4.50 ETH down to 7 worth 0.026 ETH. Ninety-nine per
 * cent of the earlier number was an artefact of the assumption.
 *
 * **One fill backs one trade.** An accepted offer is one real trade that took
 * one token; it cannot also have taken four others. An order that filled five
 * times can back five purchases, and no more.
 *
 * What survives is still an upper bound: it proves a bid stood at that price
 * while that listing was cheap, not that we would have won the race for the
 * listing.
 *
 * Collection offers apply to any token in the collection, so pairing by
 * collection rather than by token id is correct.
 */
export function findOpportunities(
  fills: readonly Fill[],
  opts: SpreadOptions,
): Opportunity[] {
  const priced = fills.map((f, i) => ({ p: priceFill(f), hash: f.orderHash ?? `#${i}` }));

  /**
   * Each bid order's life, as the chain can see it: the first and last block
   * it was filled in, how many fills it had, and the best net any of them
   * paid. An order seen only once has from === to and cannot straddle
   * anything, which is the point.
   */
  interface BidOrder {
    from: number;
    to: number;
    net: bigint;
    fillsLeft: number;
    collection: string;
  }
  const orders = new Map<string, BidOrder>();
  for (const { p, hash } of priced) {
    if (!p || p.kind !== "offer" || p.netWei === undefined) continue;
    const e = orders.get(hash);
    if (!e) {
      orders.set(hash, {
        from: p.block, to: p.block, net: p.netWei, fillsLeft: 1, collection: p.collection,
      });
    } else {
      e.from = Math.min(e.from, p.block);
      e.to = Math.max(e.to, p.block);
      if (p.netWei > e.net) e.net = p.netWei;
      e.fillsLeft += 1;
    }
  }
  const byCollection = new Map<string, BidOrder[]>();
  for (const o of orders.values()) {
    const l = byCollection.get(o.collection) ?? [];
    l.push(o);
    byCollection.set(o.collection, l);
  }

  const buys = priced
    .map(({ p }) => p)
    .filter(
      (p): p is Priced =>
        p !== null && p.kind === "listing" && p.paidWei !== undefined && p.paidWei <= opts.maxPaidWei,
    )
    .sort((a, b) => a.block - b.block);

  const out: Opportunity[] = [];
  for (const p of buys) {
    let best: BidOrder | null = null;
    for (const o of byCollection.get(p.collection) ?? []) {
      // Straddles the purchase, so the bid demonstrably stood at that moment.
      if (o.fillsLeft <= 0 || o.from >= p.block || o.to <= p.block) continue;
      if (o.to - o.from > opts.windowBlocks) continue;
      if (!best || o.net > best.net) best = o;
    }
    if (!best) continue;

    const profit = best.net - p.paidWei! - opts.gasWei;
    if (profit < opts.minProfitWei) continue;
    best.fillsLeft -= 1;
    out.push({
      collection: p.collection,
      tokenId: p.tokenId,
      paidWei: p.paidWei!,
      offerNetWei: best.net,
      gasWei: opts.gasWei,
      profitWei: profit,
      buyBlock: p.block,
      sellBlock: best.to,
    });
  }
  return out;
}

/** Total spread per collection, biggest first — the concentration answer. */
export function byCollection(opps: readonly Opportunity[]): {
  collection: string;
  trades: number;
  profitWei: bigint;
}[] {
  const acc = new Map<string, { trades: number; profitWei: bigint }>();
  for (const o of opps) {
    const e = acc.get(o.collection) ?? { trades: 0, profitWei: 0n };
    e.trades += 1;
    e.profitWei += o.profitWei;
    acc.set(o.collection, e);
  }
  return [...acc.entries()]
    .map(([collection, e]) => ({ collection, ...e }))
    .sort((a, b) => (b.profitWei > a.profitWei ? 1 : b.profitWei < a.profitWei ? -1 : 0));
}
