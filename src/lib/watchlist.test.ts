import { describe, expect, it } from "vitest";
import { parseWalletBlob } from "./watchlist";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("parseWalletBlob", () => {
  it("parses one address per line", () => {
    const { wallets, invalid } = parseWalletBlob(`${A}\n${B}`);
    expect(invalid).toEqual([]);
    expect(wallets.map((w) => w.address)).toEqual([A, B]);
  });

  it("lowercases addresses", () => {
    const { wallets } = parseWalletBlob(A.toUpperCase().replace("0X", "0x"));
    expect(wallets[0].address).toBe(A);
  });

  it("captures a label alongside the address, any order", () => {
    const { wallets } = parseWalletBlob(`${A} whale\nAlice, ${B}`);
    expect(wallets[0]).toEqual({ address: A, label: "whale" });
    expect(wallets[1]).toEqual({ address: B, label: "Alice" });
  });

  it("captures multiple addresses on one comma/space separated line", () => {
    const { wallets } = parseWalletBlob(`${A}, ${B}`);
    expect(wallets.map((w) => w.address)).toEqual([A, B]);
  });

  it("shares a leading label across many addresses on a line", () => {
    const { wallets } = parseWalletBlob(`team: ${A} ${B}`);
    expect(wallets).toEqual([
      { address: A, label: "team" },
      { address: B, label: "team" },
    ]);
  });

  it("dedupes repeats, first label wins", () => {
    const { wallets } = parseWalletBlob(`${A} first\n${A} second`);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].label).toBe("first");
  });

  it("collects invalid lines", () => {
    const { wallets, invalid } = parseWalletBlob(`${A}\nnot-an-address\n0x123`);
    expect(wallets).toHaveLength(1);
    expect(invalid).toContain("not-an-address");
    expect(invalid).toContain("0x123");
  });

  it("ignores blank lines", () => {
    const { wallets } = parseWalletBlob(`\n\n${A}\n   \n`);
    expect(wallets).toHaveLength(1);
  });
});
