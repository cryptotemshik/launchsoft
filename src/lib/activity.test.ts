import { describe, expect, it } from "vitest";
import {
  classifyTransfer,
  looksLikeTrade,
  mergeEvents,
  type TransferItem,
  type WalletEvent,
} from "./activity";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0x0000000000000000000000000000000000000000";

function item(over: Partial<TransferItem>): TransferItem {
  return {
    from: { hash: OTHER },
    to: { hash: WALLET },
    token: { name: "Cool Cats", address: "0xc0", type: "ERC-721" },
    token_type: "ERC-721",
    total: { token_id: "42" },
    timestamp: "2026-08-19T12:00:00.000000Z",
    transaction_hash: "0xtx",
    log_index: 3,
    method: "transfer",
    ...over,
  };
}

describe("looksLikeTrade", () => {
  it("recognizes Seaport order fills", () => {
    expect(looksLikeTrade("fulfillBasicOrder_efficient_6GL6yc")).toBe(true);
    expect(looksLikeTrade("matchAdvancedOrders")).toBe(true);
    expect(looksLikeTrade("fulfillAvailableAdvancedOrders")).toBe(true);
  });
  it("recognizes raw Seaport 4-byte selectors", () => {
    expect(looksLikeTrade("0xfb0f3ee1")).toBe(true); // fulfillBasicOrder
    expect(looksLikeTrade("0x00000000")).toBe(true); // efficient basic order
    expect(looksLikeTrade("0xa8174404")).toBe(true); // matchOrders
  });
  it("treats plain transfers as non-trades", () => {
    expect(looksLikeTrade("transferFrom")).toBe(false);
    expect(looksLikeTrade("safeTransferFrom")).toBe(false);
    expect(looksLikeTrade("0x42842e0e")).toBe(false); // safeTransferFrom selector
    expect(looksLikeTrade("0x23b872dd")).toBe(false); // transferFrom selector
    expect(looksLikeTrade(null)).toBe(false);
    expect(looksLikeTrade(undefined)).toBe(false);
  });
});

describe("classifyTransfer", () => {
  it("classifies a mint (from 0x0 to the wallet)", () => {
    const e = classifyTransfer(item({ from: { hash: ZERO }, method: "mintPublic" }), WALLET);
    expect(e?.kind).toBe("mint");
    expect(e?.collection).toBe("Cool Cats");
    expect(e?.tokenId).toBe("42");
  });

  it("classifies an incoming marketplace fill as a buy", () => {
    const e = classifyTransfer(item({ method: "fulfillBasicOrder" }), WALLET);
    expect(e?.kind).toBe("buy");
    expect(e?.counterparty).toBe(OTHER);
  });

  it("classifies an incoming plain transfer as a receive", () => {
    expect(classifyTransfer(item({}), WALLET)?.kind).toBe("receive");
  });

  it("classifies an outgoing marketplace fill as a sell", () => {
    const e = classifyTransfer(
      item({ from: { hash: WALLET }, to: { hash: OTHER }, method: "matchOrders" }),
      WALLET,
    );
    expect(e?.kind).toBe("sell");
    expect(e?.counterparty).toBe(OTHER);
  });

  it("classifies an outgoing plain transfer as a send", () => {
    const e = classifyTransfer(
      item({ from: { hash: WALLET }, to: { hash: OTHER } }),
      WALLET,
    );
    expect(e?.kind).toBe("send");
  });

  it("returns null when the transfer doesn't involve the wallet", () => {
    expect(
      classifyTransfer(item({ from: { hash: OTHER }, to: { hash: ZERO } }), WALLET),
    ).toBeNull();
  });

  it("makes a wallet-scoped dedupe id and passes the label through", () => {
    const e = classifyTransfer(item({}), WALLET, "whale");
    expect(e?.id).toBe(`${WALLET}:0xtx:3`);
    expect(e?.label).toBe("whale");
  });

  it("parses the timestamp to unix seconds", () => {
    const e = classifyTransfer(item({}), WALLET);
    expect(e?.t).toBe(Math.floor(Date.UTC(2026, 7, 19, 12, 0, 0) / 1000));
  });
});

describe("mergeEvents", () => {
  const mk = (id: string, t: number): WalletEvent => ({
    id,
    wallet: WALLET as `0x${string}`,
    kind: "mint",
    collection: "X",
    txHash: "0x",
    t,
  });

  it("dedupes by id and sorts newest first", () => {
    const merged = mergeEvents([mk("a", 100)], [mk("a", 100), mk("b", 200)]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("caps the feed length", () => {
    const many = Array.from({ length: 10 }, (_, i) => mk(`e${i}`, i));
    expect(mergeEvents([], many, 3)).toHaveLength(3);
  });
});
