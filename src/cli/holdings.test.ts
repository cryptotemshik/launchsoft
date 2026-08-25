import { describe, expect, it, vi } from "vitest";
import { holdingsFromLogs } from "./holdings";

const W1 = "0x1111111111111111111111111111111111111111" as const;
const W2 = "0x2222222222222222222222222222222222222222" as const;
const OUTSIDER = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const COLL = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

interface Log {
  blockNumber: bigint;
  logIndex: number;
  args: { from: string; to: string; tokenId: bigint };
}

const transfer = (block: number, index: number, from: string, to: string, id: number): Log => ({
  blockNumber: BigInt(block),
  logIndex: index,
  args: { from, to, tokenId: BigInt(id) },
});

/**
 * A client that answers getLogs from a fixed set, filtered the way a node
 * would: by `to` for the incoming query and by `from` for the outgoing one.
 */
function clientWith(logs: Log[], blockNumber = 1000n) {
  return {
    getBlockNumber: async () => blockNumber,
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

describe("holdingsFromLogs", () => {
  it("reports a token minted straight to one of our wallets", async () => {
    const held = await holdingsFromLogs(clientWith([transfer(1, 0, ZERO, W1, 7)]), COLL, [W1]);
    expect(held).toEqual([{ wallet: W1, tokenIds: ["7"] }]);
  });

  it("drops a token that was received and then sent away", async () => {
    // The incoming log still exists; only replaying both directions gets this
    // right, which is the whole reason the outgoing query is made.
    const held = await holdingsFromLogs(
      clientWith([transfer(1, 0, ZERO, W1, 7), transfer(5, 0, W1, OUTSIDER, 7)]),
      COLL,
      [W1],
    );
    expect(held).toEqual([]);
  });

  it("follows a token moved between two of our own wallets", async () => {
    const held = await holdingsFromLogs(
      clientWith([transfer(1, 0, ZERO, W1, 7), transfer(9, 0, W1, W2, 7)]),
      COLL,
      [W1, W2],
    );
    expect(held).toEqual([{ wallet: W2, tokenIds: ["7"] }]);
  });

  it("orders by block, then by position within the block", async () => {
    // Two transfers of the same token in one block: the later log index wins.
    const held = await holdingsFromLogs(
      clientWith([
        transfer(3, 2, W1, W2, 7),
        transfer(3, 1, ZERO, W1, 7),
        transfer(3, 0, ZERO, W1, 8),
      ]),
      COLL,
      [W1, W2],
    );
    expect(held).toEqual([
      { wallet: W1, tokenIds: ["8"] },
      { wallet: W2, tokenIds: ["7"] },
    ]);
  });

  it("sorts ids numerically, not as strings", async () => {
    const held = await holdingsFromLogs(
      clientWith([9, 100, 20, 3].map((id, i) => transfer(1, i, ZERO, W1, id))),
      COLL,
      [W1],
    );
    expect(held[0].tokenIds).toEqual(["3", "9", "20", "100"]);
  });

  it("returns nothing for an empty wallet set without calling the node", async () => {
    const client = { getBlockNumber: vi.fn(), getLogs: vi.fn() };
    expect(await holdingsFromLogs(client as never, COLL, [])).toEqual([]);
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it("splits the range when the provider refuses it, and loses nothing", async () => {
    const logs = [transfer(10, 0, ZERO, W1, 1), transfer(900, 0, ZERO, W1, 2)];
    let refusals = 0;
    const client = {
      getBlockNumber: async () => 1000n,
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
    const held = await holdingsFromLogs(client as never, COLL, [W1]);
    expect(refusals).toBeGreaterThan(0);
    expect(held[0].tokenIds).toEqual(["1", "2"]);
  });

  it("gives up rather than splitting forever on an error that isn't about range", async () => {
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async () => {
        throw new Error("unauthorized: bad api key");
      },
    };
    await expect(holdingsFromLogs(client as never, COLL, [W1])).rejects.toThrow(/unauthorized/);
  });

  it("ignores tokens that ended up with someone outside the set", async () => {
    const held = await holdingsFromLogs(
      clientWith([transfer(1, 0, ZERO, W1, 7), transfer(2, 0, W1, OUTSIDER, 7)]),
      COLL,
      [W1, W2],
    );
    expect(held).toEqual([]);
  });
});
