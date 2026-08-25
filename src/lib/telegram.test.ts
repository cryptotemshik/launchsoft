import { describe, expect, it } from "vitest";
import { escapeHtml, formatMintReport, type MintReport } from "./telegram";

const base: Omit<MintReport, "wallets"> = {
  collectionName: "Test Drop",
  collection: "0xcccccccccccccccccccccccccccccccccccccccc",
  chainLabel: "Robinhood Chain",
  stage: "public",
  collectionUrl: "https://opensea.io/assets/robinhood/0xccc",
  itemUrl: (id) => `https://opensea.io/item/robinhood/0xccc/${id}`,
  profileUrl: (a) => `https://opensea.io/${a}`,
  explorerTxUrl: (h) => `https://explorer/tx/${h}`,
};

const wallet = (over: Partial<MintReport["wallets"][number]>) => ({
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "mined",
  quantity: 2,
  tokenIds: ["1", "2"],
  ...over,
});

describe("escapeHtml", () => {
  it("neutralises the characters Telegram parses as markup", () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe("&lt;b&gt;&amp;\"x\"&lt;/b&gt;");
  });
});

describe("formatMintReport", () => {
  it("totals NFTs and wallets across mined wallets only", () => {
    const out = formatMintReport({
      ...base,
      wallets: [
        wallet({ quantity: 3, tokenIds: ["1", "2", "3"] }),
        wallet({ address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", quantity: 2, tokenIds: ["4", "5"] }),
        wallet({ address: "0xcccccccccccccccccccccccccccccccccccccccd", status: "rejected", quantity: 0, tokenIds: [] }),
      ],
    });
    expect(out).toContain("<b>5</b> NFTs from <b>2</b> wallets");
    expect(out).toContain("1 failed");
    expect(out).toContain("MINT COMPLETE");
  });

  it("links every token id it was given", () => {
    const out = formatMintReport({ ...base, wallets: [wallet({})] });
    expect(out).toContain('href="https://opensea.io/item/robinhood/0xccc/1"');
    expect(out).toContain('href="https://opensea.io/item/robinhood/0xccc/2"');
  });

  it("caps token links so a big run can't blow the length limit", () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const out = formatMintReport({
      ...base,
      wallets: [wallet({ quantity: 20, tokenIds: ids })],
    });
    expect(out).toContain("+12 more");
    expect(out).not.toContain("/0xccc/20\"");
  });

  it("marks a run that minted nothing as failed", () => {
    const out = formatMintReport({
      ...base,
      wallets: [wallet({ status: "rejected", quantity: 0, tokenIds: [], detail: "insufficient funds" })],
    });
    expect(out).toContain("MINT FAILED");
    expect(out).toContain("insufficient funds");
  });

  it("labels a dry run instead of claiming a mint", () => {
    const out = formatMintReport({ ...base, dryRun: true, wallets: [] });
    expect(out).toContain("DRY RUN");
    expect(out).not.toContain("MINT COMPLETE");
  });

  it("escapes a hostile collection name rather than emitting its markup", () => {
    const out = formatMintReport({
      ...base,
      collectionName: '<script>alert(1)</script>',
      wallets: [],
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("stays within Telegram's message limit", () => {
    const wallets = Array.from({ length: 40 }, (_, i) =>
      wallet({
        address: `0x${String(i).padStart(40, "0")}`,
        quantity: 10,
        tokenIds: Array.from({ length: 10 }, (_, k) => String(i * 10 + k)),
      }),
    );
    const out = formatMintReport({ ...base, wallets });
    expect(out.length).toBeLessThanOrEqual(4096);
  });
});
