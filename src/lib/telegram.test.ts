import { describe, expect, it } from "vitest";
import { escapeHtml, formatMintReport, packMessages, type MintReport } from "./telegram";

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

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const wallet = (over: Partial<MintReport["wallets"][number]> = {}) => ({
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

describe("packMessages", () => {
  it("keeps a short section in one message", () => {
    const out = packMessages("<b>Head</b>", ["a", "b"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("<b>Head</b>\n\na\nb");
  });

  it("returns nothing for an empty section", () => {
    expect(packMessages("<b>Head</b>", [])).toEqual([]);
  });

  it("splits rather than truncating, and numbers the parts", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const out = packMessages("<b>Failed</b>", lines);

    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toContain(`<b>Failed</b> (1/${out.length})`);
    // Every single line survives somewhere — that is the whole point.
    const joined = out.join("\n");
    for (const l of lines) expect(joined).toContain(l);
  });

  it("keeps every message inside Telegram's limit", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `${i} ${"y".repeat(80)}`);
    for (const m of packMessages("<b>Failed</b>", lines)) {
      expect(m.length).toBeLessThanOrEqual(4096);
    }
  });

  it("trims a single over-long line instead of dropping what follows it", () => {
    const out = packMessages("<b>Head</b>", ["z".repeat(9000), "the next wallet"]);
    expect(out.join("\n")).toContain("the next wallet");
    for (const m of out) expect(m.length).toBeLessThanOrEqual(4096);
  });
});

describe("formatMintReport", () => {
  it("sends an overview, the mints, and the failures as separate messages", () => {
    const out = formatMintReport({
      ...base,
      wallets: [
        wallet({ quantity: 3, tokenIds: ["1", "2", "3"] }),
        wallet({ address: addr(2), quantity: 2, tokenIds: ["4", "5"] }),
        wallet({ address: addr(3), status: "rejected", quantity: 0, tokenIds: [] }),
      ],
    });

    expect(out).toHaveLength(3);
    expect(out[0]).toContain("MINT COMPLETE");
    expect(out[0]).toContain("<b>5</b> NFTs on <b>2</b> wallets");
    expect(out[0]).toContain("<b>1</b> wallet failed");
    expect(out[1]).toContain("MINTED — 2 wallets, 5 NFTs");
    expect(out[2]).toContain("FAILED — 1 wallet");
  });

  it("puts the overview first, since that is what a lock screen shows", () => {
    const out = formatMintReport({ ...base, wallets: [wallet()] });
    expect(out[0]).toContain("Test Drop");
    expect(out[0]).toContain("Robinhood Chain");
    expect(out[0]).toContain("public stage");
  });

  it("omits the mint message when nothing minted", () => {
    const out = formatMintReport({
      ...base,
      wallets: [wallet({ status: "rejected", quantity: 0, tokenIds: [] })],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("MINT FAILED");
    expect(out.some((m) => m.includes("MINTED —"))).toBe(false);
  });

  it("omits the failure message when nothing failed", () => {
    const out = formatMintReport({ ...base, wallets: [wallet()] });
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.includes("FAILED —"))).toBe(false);
  });

  it("names every failed wallet, however many there are", () => {
    // The complaint that started this: a run with dozens of failures showed
    // only the first few, so the list could not be acted on.
    const wallets = Array.from({ length: 60 }, (_, i) =>
      wallet({
        address: addr(i + 1),
        status: "rejected",
        quantity: 0,
        tokenIds: [],
        detail: "execution reverted: stage not open for this wallet",
      }),
    );
    const out = formatMintReport({ ...base, wallets });
    const joined = out.join("\n");
    for (const w of wallets) {
      expect(joined).toContain(`${w.address.slice(0, 8)}…${w.address.slice(-4)}`);
    }
    expect(out[0]).toContain("<b>60</b> wallets failed");
  });

  it("links each minted wallet to its OpenSea profile and each token to its item", () => {
    const out = formatMintReport({
      ...base,
      wallets: [wallet({ tokenIds: ["7", "8"], txHash: "0xdead" })],
    });
    const mints = out[1];
    expect(mints).toContain('href="https://opensea.io/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(mints).toContain('href="https://opensea.io/item/robinhood/0xccc/7"');
    expect(mints).toContain('href="https://opensea.io/item/robinhood/0xccc/8"');
    expect(mints).toContain('href="https://explorer/tx/0xdead"');
  });

  it("lists every token id — a wallet that minted 30 shows all 30", () => {
    const tokenIds = Array.from({ length: 30 }, (_, i) => String(i + 1));
    const out = formatMintReport({
      ...base,
      wallets: [wallet({ quantity: 30, tokenIds })],
    });
    const joined = out.join("\n");
    for (const id of tokenIds) expect(joined).toContain(`>#${id}</a>`);
  });

  it("links the collection from the mint and failure messages too", () => {
    const out = formatMintReport({
      ...base,
      wallets: [wallet(), wallet({ address: addr(3), status: "rejected", quantity: 0, tokenIds: [] })],
    });
    for (const m of out) expect(m).toContain('href="https://opensea.io/assets/robinhood/0xccc"');
  });

  it("puts each failure reason on its own line, so a phone can read it", () => {
    const out = formatMintReport({
      ...base,
      wallets: [
        wallet({
          address: addr(5),
          status: "reverted",
          quantity: 0,
          tokenIds: [],
          detail: "execution reverted: MintQuantityExceedsMaxMintedPerWallet",
        }),
      ],
    });
    expect(out[1]).toContain("\n   execution reverted: MintQuantityExceedsMaxMintedPerWallet");
  });

  it("counts skipped wallets apart from failures", () => {
    const out = formatMintReport({
      ...base,
      wallets: [wallet(), wallet({ address: addr(9), status: "skipped", quantity: 0, tokenIds: [] })],
    });
    expect(out[0]).toContain("1 skipped");
    expect(out.some((m) => m.includes("FAILED —"))).toBe(false);
  });

  it("says plainly when it was a dry run", () => {
    const out = formatMintReport({ ...base, dryRun: true, wallets: [wallet()] });
    expect(out[0]).toContain("DRY RUN");
  });

  it("escapes a hostile collection name", () => {
    const out = formatMintReport({
      ...base,
      collectionName: "<script>alert(1)</script>",
      wallets: [wallet()],
    });
    expect(out[0]).toContain("&lt;script&gt;");
    expect(out[0]).not.toContain("<script>");
  });
});
