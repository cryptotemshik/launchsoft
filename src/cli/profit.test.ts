import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockTimes,
  clearProfitCaches,
  eth,
  priceMints,
  priceTransfers,
  summarise,
  type MintTransfer,
  type OutgoingTransfer,
} from "./profit";

const W1 = "0x1111111111111111111111111111111111111111" as const;
const W2 = "0x2222222222222222222222222222222222222222" as const;
const BUYER = "0x9999999999999999999999999999999999999999" as const;
const COLL = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

const ETH = 1_000_000_000_000_000_000n;

// The caches key on hashes and block numbers, which are unique in the wild but
// reused across these fixtures.
beforeEach(clearProfitCaches);

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
  collection: COLL,
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
        { wallet: W1, collection: COLL, tokenId: "1", blockNumber: 1n, txHash: "0x", proceedsWei: 2n * ETH, priced: true },
        { wallet: W1, collection: COLL, tokenId: "2", blockNumber: 2n, txHash: "0x", proceedsWei: 1n * ETH, priced: true },
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

describe("priceMints", () => {
  const mint = (over: Partial<MintTransfer> = {}): MintTransfer => ({
    wallet: W1,
    collection: COLL,
    tokenId: "1",
    blockNumber: 10n,
    txHash: "0xtx1",
    ...over,
  });

  /** A node that knows two transactions. */
  const node = (txs: Record<string, { value: bigint; gasUsed: bigint; gasPrice: bigint }>) =>
    ({
      getTransaction: async ({ hash }: { hash: string }) => {
        if (!txs[hash]) throw new Error("not found");
        return { value: txs[hash].value, gasPrice: txs[hash].gasPrice };
      },
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (!txs[hash]) throw new Error("not found");
        return { gasUsed: txs[hash].gasUsed, effectiveGasPrice: txs[hash].gasPrice };
      },
    }) as never;

  it("charges the mint price and the gas of the transaction that minted", async () => {
    const cost = await priceMints(
      node({ "0xtx1": { value: 2n * ETH, gasUsed: 100_000n, gasPrice: 10n } }),
      [mint()],
    );
    const c = cost.get(COLL.toLowerCase())!;
    expect(c.priceWei).toBe(2n * ETH);
    expect(c.gasWei).toBe(1_000_000n);
    expect(c.tokens).toBe(1);
    expect(c.wallets).toBe(1);
  });

  it("reads one transaction once however many tokens it minted", async () => {
    // A wallet minting ten in one go pays once, not ten times — the bug this
    // guards against would have multiplied a drop's cost by its quantity.
    const getTransaction = vi.fn(async () => ({ value: 3n * ETH, gasPrice: 0n }));
    const getTransactionReceipt = vi.fn(async () => ({ gasUsed: 0n, effectiveGasPrice: 0n }));
    const cost = await priceMints({ getTransaction, getTransactionReceipt } as never, [
      mint({ tokenId: "1" }),
      mint({ tokenId: "2" }),
      mint({ tokenId: "3" }),
    ]);
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(cost.get(COLL.toLowerCase())!.priceWei).toBe(3n * ETH);
    expect(cost.get(COLL.toLowerCase())!.tokens).toBe(3);
  });

  it("keeps collections apart and counts the wallets behind each", async () => {
    const other = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
    const cost = await priceMints(
      node({
        "0xtx1": { value: 1n * ETH, gasUsed: 0n, gasPrice: 0n },
        "0xtx2": { value: 5n * ETH, gasUsed: 0n, gasPrice: 0n },
      }),
      [
        mint(),
        mint({ wallet: W2, tokenId: "2", txHash: "0xtx2", collection: other }),
      ],
    );
    expect(cost.get(COLL.toLowerCase())!.priceWei).toBe(1n * ETH);
    expect(cost.get(other.toLowerCase())!.priceWei).toBe(5n * ETH);
    expect(cost.get(other.toLowerCase())!.wallets).toBe(1);
  });

  it("counts a token the node has forgotten as minted, but not as free", async () => {
    const cost = await priceMints(node({}), [mint()]);
    const c = cost.get(COLL.toLowerCase())!;
    expect(c.tokens).toBe(1);
    expect(c.priceWei).toBe(0n);
  });

  it("splits one transaction between the collections it minted, by token count", async () => {
    const other = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
    const cost = await priceMints(
      node({ "0xtx1": { value: 3n * ETH, gasUsed: 0n, gasPrice: 0n } }),
      [
        mint({ tokenId: "1" }),
        mint({ tokenId: "2" }),
        mint({ tokenId: "3", collection: other }),
      ],
    );
    expect(cost.get(COLL.toLowerCase())!.priceWei).toBe(2n * ETH);
    expect(cost.get(other.toLowerCase())!.priceWei).toBe(1n * ETH);
  });

  it("asks nothing of the node when nothing was minted", async () => {
    const getTransaction = vi.fn();
    expect(
      (await priceMints({ getTransaction } as never, [])).size,
    ).toBe(0);
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

describe("caching settled history", () => {
  it("reads a transaction once and remembers what it cost", async () => {
    const getTransaction = vi.fn(async () => ({ value: 2n * ETH, gasPrice: 0n }));
    const getTransactionReceipt = vi.fn(async () => ({ gasUsed: 0n, effectiveGasPrice: 0n }));
    const client = { getTransaction, getTransactionReceipt } as never;
    const mint = {
      wallet: W1,
      collection: COLL,
      tokenId: "1",
      blockNumber: 10n,
      txHash: "0xtx1",
    };

    const first = await priceMints(client, [mint]);
    const second = await priceMints(client, [mint]);

    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(second.get(COLL.toLowerCase())!.priceWei).toBe(first.get(COLL.toLowerCase())!.priceWei);
  });

  it("prices a sale once and does not ask the node again", async () => {
    const getBalance = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) =>
      blockNumber === 100n ? 5n * ETH : 4n * ETH,
    );
    const client = { getBalance } as never;

    const first = await priceTransfers(client, [out()], [W1]);
    const second = await priceTransfers(client, [out()], [W1]);

    expect(getBalance).toHaveBeenCalledTimes(2); // the block and the one before
    expect(second[0].proceedsWei).toBe(first[0].proceedsWei);
    expect(second[0].proceedsWei).toBe(1n * ETH);
  });

  it("does not remember a sale it could not price", async () => {
    // A node without archive state today may have it tomorrow — caching
    // "unknown" would make a temporary gap permanent.
    let archive = false;
    const client = {
      getBalance: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (!archive) throw new Error("metadata is not found");
        return blockNumber === 100n ? 3n * ETH : 1n * ETH;
      },
    } as never;

    expect((await priceTransfers(client, [out()], [W1]))[0].priced).toBe(false);
    archive = true;
    const after = await priceTransfers(client, [out()], [W1]);
    expect(after[0].priced).toBe(true);
    expect(after[0].proceedsWei).toBe(2n * ETH);
  });

  it("reads a block's timestamp once", async () => {
    const getBlock = vi.fn(async () => ({ timestamp: 1_700_000_000n }));
    const client = { getBlock } as never;

    await blockTimes(client, [7n, 7n, 8n]);
    const again = await blockTimes(client, [7n, 8n]);

    expect(getBlock).toHaveBeenCalledTimes(2); // 7 and 8, not four calls
    expect(again.get("7")).toBe(1_700_000_000);
  });

  it("forgets everything when asked, so a fresh report really is fresh", async () => {
    const getBlock = vi.fn(async () => ({ timestamp: 1n }));
    const client = { getBlock } as never;
    await blockTimes(client, [1n]);
    clearProfitCaches();
    await blockTimes(client, [1n]);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });
});
