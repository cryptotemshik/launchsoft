import { describe, expect, it, vi } from "vitest";
import { eth, priceTransfers, summarise, type OutgoingTransfer } from "./profit";

const W1 = "0x1111111111111111111111111111111111111111" as const;
const W2 = "0x2222222222222222222222222222222222222222" as const;
const BUYER = "0x9999999999999999999999999999999999999999" as const;
const COLL = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

const ETH = 1_000_000_000_000_000_000n;

/** A client whose balances are looked up as `wallet@block`. */
function clientWith(balances: Record<string, bigint>) {
  return {
    getBalance: async ({
      address,
      blockNumber,
    }: {
      address: string;
      blockNumber: bigint;
    }) => balances[`${address.toLowerCase()}@${blockNumber}`] ?? 0n,
  } as never;
}

const out = (over: Partial<OutgoingTransfer> = {}): OutgoingTransfer => ({
  wallet: W1,
  tokenId: "1",
  blockNumber: 100n,
  txHash: "0xtx",
  to: BUYER,
  ...over,
});

describe("priceTransfers", () => {
  it("prices a sale from the seller's balance rise in that block", async () => {
    const client = clientWith({
      [`${W1.toLowerCase()}@99`]: 1n * ETH,
      [`${W1.toLowerCase()}@100`]: 2n * ETH,
    });
    const sales = await priceTransfers(client, [out()], [W1]);
    expect(sales).toHaveLength(1);
    expect(sales[0].proceedsWei).toBe(1n * ETH);
    expect(sales[0].tokenId).toBe("1");
  });

  it("ignores a move to another of our own wallets — that is not a sale", async () => {
    // Consolidating onto one wallet before listing must not read as revenue.
    const client = clientWith({});
    const sales = await priceTransfers(client, [out({ to: W2 })], [W1, W2]);
    expect(sales).toEqual([]);
  });

  it("splits the rise between tokens that left in the same transaction", async () => {
    const client = clientWith({
      [`${W1.toLowerCase()}@99`]: 0n,
      [`${W1.toLowerCase()}@100`]: 3n * ETH,
    });
    const sales = await priceTransfers(
      client,
      [out({ tokenId: "1" }), out({ tokenId: "2" }), out({ tokenId: "3" })],
      [W1],
    );
    expect(sales.map((s) => s.proceedsWei)).toEqual([1n * ETH, 1n * ETH, 1n * ETH]);
  });

  it("reads one balance pair per wallet-block, not one per token", async () => {
    const getBalance = vi.fn(async () => 0n);
    await priceTransfers({ getBalance } as never, [out({ tokenId: "1" }), out({ tokenId: "2" })], [
      W1,
    ]);
    // Two calls: the block and the one before it. Not four.
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it("marks a sale unpriced when the node has no state for that block", async () => {
    // Only an archive node keeps historical balances; Robinhood Chain's public
    // RPC answers "metadata is not found". Calling that a free sale would
    // quietly understate the drop, so it is reported as unknown instead.
    const client = {
      getBalance: async () => {
        throw new Error("metadata is not found, 41612262");
      },
    };
    const sales = await priceTransfers(client as never, [out()], [W1]);
    expect(sales[0].priced).toBe(false);
    expect(sales[0].proceedsWei).toBe(0n);

    const r = summarise(COLL, { gasWei: 0n, priceWei: 0n, tokens: 1, wallets: 1 }, sales, 0);
    expect(r.revenueWei).toBe(0n);
    expect(r.unpricedSales).toBe(1);
    expect(r.soldTokens).toBe(1);
  });

  it("prices a gift at zero rather than inventing a number", async () => {
    const client = clientWith({
      [`${W1.toLowerCase()}@99`]: 5n * ETH,
      [`${W1.toLowerCase()}@100`]: 5n * ETH,
    });
    const sales = await priceTransfers(client, [out()], [W1]);
    expect(sales[0].proceedsWei).toBe(0n);
    // Priced, and the price was nothing — different from not knowing.
    expect(sales[0].priced).toBe(true);
  });

  it("treats a fall in balance as no proceeds, not as negative revenue", async () => {
    // Sending a token out costs gas; that is a cost, not a sale for minus.
    const client = clientWith({
      [`${W1.toLowerCase()}@99`]: 5n * ETH,
      [`${W1.toLowerCase()}@100`]: 4n * ETH,
    });
    const sales = await priceTransfers(client, [out()], [W1]);
    expect(sales[0].proceedsWei).toBe(0n);
  });

  it("keeps sales from different wallets apart", async () => {
    const client = clientWith({
      [`${W1.toLowerCase()}@99`]: 0n,
      [`${W1.toLowerCase()}@100`]: 1n * ETH,
      [`${W2.toLowerCase()}@199`]: 0n,
      [`${W2.toLowerCase()}@200`]: 2n * ETH,
    });
    const sales = await priceTransfers(
      client,
      [out(), out({ wallet: W2, tokenId: "9", blockNumber: 200n })],
      [W1, W2],
    );
    expect(sales.map((s) => s.proceedsWei)).toEqual([1n * ETH, 2n * ETH]);
  });

  it("does nothing, and asks nothing of the node, with no transfers", async () => {
    const getBalance = vi.fn();
    expect(await priceTransfers({ getBalance } as never, [], [W1])).toEqual([]);
    expect(getBalance).not.toHaveBeenCalled();
  });
});

describe("summarise", () => {
  const cost = { gasWei: 5_000_000_000_000n, priceWei: 1n * ETH, tokens: 10, wallets: 4 };

  it("nets revenue against gas and mint price together", () => {
    const r = summarise(
      COLL,
      cost,
      [
        { wallet: W1, tokenId: "1", blockNumber: 1n, txHash: "0x", proceedsWei: 2n * ETH, priced: true },
        { wallet: W1, tokenId: "2", blockNumber: 2n, txHash: "0x", proceedsWei: 1n * ETH, priced: true },
      ],
      8,
    );
    expect(r.revenueWei).toBe(3n * ETH);
    expect(r.soldTokens).toBe(2);
    expect(r.heldTokens).toBe(8);
    expect(r.netWei).toBe(3n * ETH - 1n * ETH - 5_000_000_000_000n);
  });

  it("shows a loss while the drop has not sold through", () => {
    const r = summarise(COLL, cost, [], 10);
    expect(r.revenueWei).toBe(0n);
    expect(r.netWei).toBeLessThan(0n);
    expect(r.unpricedSales).toBe(0);
  });
});

describe("eth", () => {
  it("keeps enough places to read a gas figure", () => {
    expect(eth(5_300_000_000_000n)).toBe("0.000005");
    expect(eth(1n * ETH)).toBe("1");
    expect(eth(1_500_000_000_000_000_000n)).toBe("1.500000");
  });
});
