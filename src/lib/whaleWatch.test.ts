import { describe, expect, it } from "vitest";
import { addressTopic, parseAcquisitions, TRANSFER_TOPIC, whaleTopicBatches } from "./whaleWatch";

const W1 = `0x${"11".repeat(20)}`;
const W2 = `0x${"22".repeat(20)}`;
const STRANGER = `0x${"99".repeat(20)}`;
const COLL = `0x${"cc".repeat(20)}`;
const ZERO = `0x${"0".repeat(64)}`;

const whales = new Set([W1, W2]);

function log(to: string, opts: { from?: string; erc20?: boolean; contract?: string; block?: number } = {}) {
  const topics = opts.erc20
    ? [TRANSFER_TOPIC, addressTopic(opts.from ?? STRANGER), addressTopic(to)]
    : [TRANSFER_TOPIC, addressTopic(opts.from ?? STRANGER), addressTopic(to), `0x${"0".repeat(63)}1`];
  return { address: opts.contract ?? COLL, topics, blockNumber: opts.block ?? 100 };
}

describe("parsing whale acquisitions from logs", () => {
  it("keeps NFT transfers into whale wallets and flags mints", () => {
    const acqs = parseAcquisitions(
      [
        log(W1, { from: `0x${"0".repeat(40)}` }), // mint (from zero address)
        log(W2, { from: STRANGER }), // a buy/transfer in
      ],
      whales,
    );
    expect(acqs).toHaveLength(2);
    expect(acqs[0]).toMatchObject({ contract: COLL, whale: W1, minted: true });
    expect(acqs[1]).toMatchObject({ whale: W2, minted: false });
  });

  it("ignores transfers to non-whales", () => {
    expect(parseAcquisitions([log(STRANGER)], whales)).toHaveLength(0);
  });

  it("ignores ERC-20 transfers (three topics, no tokenId)", () => {
    expect(parseAcquisitions([log(W1, { erc20: true })], whales)).toHaveLength(0);
  });

  it("mints from the zero address are detected", () => {
    const acqs = parseAcquisitions([{ address: COLL, topics: [TRANSFER_TOPIC, ZERO, addressTopic(W1), "0x1"], blockNumber: 5 }], whales);
    expect(acqs[0].minted).toBe(true);
  });
});

describe("topic batching", () => {
  it("chunks whales and pads each to a 32-byte topic", () => {
    const batches = whaleTopicBatches([W1, W2], 1);
    expect(batches).toHaveLength(2);
    expect(batches[0][0]).toBe(addressTopic(W1));
    expect(batches[0][0]).toHaveLength(66);
  });
});
