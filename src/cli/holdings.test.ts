import { describe, expect, it, vi } from "vitest";
import { scanChain } from "./holdings";

const W1 = "0x1111111111111111111111111111111111111111" as const;
const W2 = "0x2222222222222222222222222222222222222222" as const;
const OUTSIDER = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const COLL = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

interface Log {
  address: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  topics: string[];
  args: { from: string; to: string; tokenId: bigint };
}

const transfer = (
  block: number,
  index: number,
  from: string,
  to: string,
  id: number,
  address: string = COLL,
): Log => ({
  address,
  blockNumber: BigInt(block),
  logIndex: index,
  transactionHash: `0xtx${block}${index}`,
  // Four topics is what makes it ERC-721 rather than ERC-20.
  topics: ["0xddf2", from, to, `0x${id.toString(16)}`],
  args: { from, to, tokenId: BigInt(id) },
});

/**
 * A client that answers getLogs from a fixed set, filtered the way a node
 * would: by `to` for the incoming query and by `from` for the outgoing one.
 */
function clientWith(logs: Log[], blockNumber = 1000n) {
  return {
    getBlockNumber: async () => blockNumber,
    readContract: async ({ address }: { address: string }) => `Name of ${address.slice(0, 6)}`,
    getLogs: async ({ args }: { args: { to?: string[]; from?: string[] } }) => {
      if (args.to) {
        const want = new Set(args.to.map((a) => a.toLowerCase()));
        return logs.filter((l) => want.has(l.args.to.toLowerCase()));
      }
      const want = new Set((args.from ?? []).map((a) => a.toLowerCase()));
      return logs.filter((l) => want.has(l.args.from.toLowerCase()));
    },
  } as never;
}

/** The held tokens of one collection, flattened for the old assertions. */
const heldOf = (scan: Awaited<ReturnType<typeof scanChain>>, collection = COLL) =>
  scan.collections.find((c) => c.collection.toLowerCase() === collection.toLowerCase())?.wallets ??
  [];

describe("scanChain", () => {
  it("reports a token minted straight to one of our wallets", async () => {
    const scan = await scanChain(clientWith([transfer(1, 0, ZERO, W1, 7)]), [W1]);
    expect(heldOf(scan)).toEqual([{ wallet: W1, tokenIds: ["7"] }]);
    expect(scan.totalTokens).toBe(1);
    expect(scan.walletsWithTokens).toBe(1);
  });

  it("drops a token that was received and then sent away", async () => {
    // The incoming log still exists; only replaying both directions gets this
    // right, which is the whole reason the outgoing query is made.
    const scan = await scanChain(
      clientWith([transfer(1, 0, ZERO, W1, 7), transfer(5, 0, W1, OUTSIDER, 7)]),
      [W1],
    );
    expect(heldOf(scan)).toEqual([]);
    expect(scan.sent).toHaveLength(1);
    expect(scan.sent[0]).toMatchObject({ wallet: W1, tokenId: "7", to: OUTSIDER });
  });

  it("follows a token moved between two of our own wallets", async () => {
    const scan = await scanChain(
      clientWith([transfer(1, 0, ZERO, W1, 7), transfer(9, 0, W1, W2, 7)]),
      [W1, W2],
    );
    expect(heldOf(scan)).toEqual([{ wallet: W2, tokenIds: ["7"] }]);
  });

  it("orders by block, then by position within the block", async () => {
    // Two transfers of the same token in one block: the later log index wins.
    const scan = await scanChain(
      clientWith([
        transfer(3, 2, W1, W2, 7),
        transfer(3, 1, ZERO, W1, 7),
        transfer(3, 0, ZERO, W1, 8),
      ]),
      [W1, W2],
    );
    // Sorted by how many each holds, then whatever order — check as a set.
    expect(heldOf(scan)).toEqual(
      expect.arrayContaining([
        { wallet: W1, tokenIds: ["8"] },
        { wallet: W2, tokenIds: ["7"] },
      ]),
    );
  });

  it("sorts ids numerically, not as strings", async () => {
    const scan = await scanChain(
      clientWith([9, 100, 20, 3].map((id, i) => transfer(1, i, ZERO, W1, id))),
      [W1],
    );
    expect(heldOf(scan)[0].tokenIds).toEqual(["3", "9", "20", "100"]);
  });

  it("finds every collection at once, without being told any of them", async () => {
    // The point of dropping the contract filter: a hundred wallets holding
    // eleven collections cost the same two queries as holding one.
    const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
    const scan = await scanChain(
      clientWith([
        transfer(1, 0, ZERO, W1, 7, COLL),
        transfer(2, 0, ZERO, W1, 1, OTHER),
        transfer(2, 1, ZERO, W2, 2, OTHER),
      ]),
      [W1, W2],
    );
    expect(scan.collections).toHaveLength(2);
    // Ordered by size, so the biggest holding is the first thing read.
    expect(scan.collections[0].collection.toLowerCase()).toBe(OTHER);
    expect(scan.collections[0].totalTokens).toBe(2);
    expect(scan.totalTokens).toBe(3);
  });

  it("keeps two collections' token #1 apart", async () => {
    const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
    const scan = await scanChain(
      clientWith([transfer(1, 0, ZERO, W1, 1, COLL), transfer(1, 1, ZERO, W1, 1, OTHER)]),
      [W1],
    );
    expect(scan.totalTokens).toBe(2);
  });

  it("ignores ERC-20 transfers, which share the event but index one less", async () => {
    const erc20 = {
      ...transfer(1, 0, ZERO, W1, 5),
      topics: ["0xddf2", ZERO, W1],
      args: { from: ZERO, to: W1, tokenId: undefined as unknown as bigint },
    };
    const scan = await scanChain(clientWith([erc20, transfer(2, 0, ZERO, W1, 7)]), [W1]);
    expect(scan.totalTokens).toBe(1);
    expect(heldOf(scan)[0].tokenIds).toEqual(["7"]);
  });

  it("names each collection, and survives one that has no name()", async () => {
    const client = {
      getBlockNumber: async () => 1000n,
      readContract: async () => {
        throw new Error("execution reverted");
      },
      getLogs: async ({ args }: { args: { to?: string[] } }) =>
        args.to ? [transfer(1, 0, ZERO, W1, 7)] : [],
    };
    const scan = await scanChain(client as never, [W1]);
    expect(scan.collections[0].name).toBeUndefined();
    expect(scan.collections[0].totalTokens).toBe(1);
  });

  it("returns nothing for an empty wallet set without calling the node", async () => {
    const client = { getBlockNumber: vi.fn(), getLogs: vi.fn() };
    const scan = await scanChain(client as never, []);
    expect(scan.collections).toEqual([]);
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it("splits the range when the provider refuses it, and loses nothing", async () => {
    const logs = [transfer(10, 0, ZERO, W1, 1), transfer(900, 0, ZERO, W1, 2)];
    let refusals = 0;
    const client = {
      getBlockNumber: async () => 1000n,
      readContract: async () => "Name",
      getLogs: async ({
        args,
        fromBlock,
        toBlock,
      }: {
        args: { to?: string[]; from?: string[] };
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        if (toBlock - fromBlock > 600n) {
          refusals += 1;
          throw new Error("query returned more than 10000 results / block range too large");
        }
        if (!args.to) return [];
        return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
    };
    const scan = await scanChain(client as never, [W1]);
    expect(refusals).toBeGreaterThan(0);
    expect(heldOf(scan)[0].tokenIds).toEqual(["1", "2"]);
  });

  it("gives up rather than splitting forever on an error that isn't about range", async () => {
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async () => {
        throw new Error("unauthorized: bad api key");
      },
    };
    await expect(scanChain(client as never, [W1])).rejects.toThrow(/unauthorized/);
  });

  it("ignores tokens that ended up with someone outside the set", async () => {
    const scan = await scanChain(
      clientWith([transfer(1, 0, ZERO, W1, 7), transfer(2, 0, W1, OUTSIDER, 7)]),
      [W1, W2],
    );
    expect(scan.collections).toEqual([]);
    expect(scan.totalTokens).toBe(0);
  });
});

describe("mint detection", () => {
  it("reports arrivals from the zero address, and nothing else, as mints", async () => {
    const scan = await scanChain(
      clientWith([
        transfer(1, 0, ZERO, W1, 1),
        transfer(1, 1, ZERO, W1, 2),
        // Bought from someone, not minted — a cost we cannot read this way.
        transfer(2, 0, OUTSIDER, W2, 3),
      ]),
      [W1, W2],
    );
    expect(scan.minted.map((m) => m.tokenId)).toEqual(["1", "2"]);
    expect(scan.minted[0].wallet).toBe(W1);
    expect(scan.minted[0].txHash).toBe("0xtx10");
  });

  it("keeps a mint in the list after the token has been sold on", async () => {
    // Cost is spent whether or not the token is still held.
    const scan = await scanChain(
      clientWith([transfer(1, 0, ZERO, W1, 1), transfer(5, 0, W1, OUTSIDER, 1)]),
      [W1],
    );
    expect(scan.minted).toHaveLength(1);
    expect(scan.totalTokens).toBe(0);
  });
});
