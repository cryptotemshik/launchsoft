import { afterEach, describe, expect, it, vi } from "vitest";
import { findHoldings } from "./nftSweep";

const API = "https://explorer.example/api/v2";
const WALLET = "0x1111111111111111111111111111111111111111" as const;
const COLL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COLL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const item = (id: string, address: string, name?: string) => ({
  id,
  token: { address_hash: address, name },
});

function mockPages(pages: { items: unknown[]; next?: Record<string, string> | null }[]) {
  let call = 0;
  return vi.fn(async () => {
    const p = pages[Math.min(call++, pages.length - 1)];
    return {
      ok: true,
      json: async () => ({ items: p.items, next_page_params: p.next ?? null }),
    } as unknown as Response;
  });
}

describe("findHoldings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups token ids by collection", async () => {
    vi.stubGlobal(
      "fetch",
      mockPages([
        {
          items: [
            item("1", COLL_A, "Alpha"),
            item("2", COLL_A, "Alpha"),
            item("7", COLL_B, "Beta"),
          ],
        },
      ]),
    );
    const out = await findHoldings(API, WALLET);
    expect(out).toHaveLength(2);
    const a = out.find((h) => h.collection === COLL_A)!;
    expect(a.tokenIds).toEqual(["1", "2"]);
    expect(a.collectionName).toBe("Alpha");
    expect(a.wallet).toBe(WALLET);
  });

  it("follows pagination until the last page", async () => {
    const fetchMock = mockPages([
      { items: [item("1", COLL_A)], next: { token_id: "2" } },
      { items: [item("2", COLL_A)], next: { token_id: "3" } },
      { items: [item("3", COLL_A)], next: null },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const out = await findHoldings(API, WALLET);
    expect(out[0].tokenIds).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops at maxPages so one huge wallet can't stall a sweep", async () => {
    // Every page claims another follows — only the cap ends it.
    const fetchMock = mockPages([{ items: [item("1", COLL_A)], next: { token_id: "x" } }]);
    vi.stubGlobal("fetch", fetchMock);
    await findHoldings(API, WALLET, undefined, 3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("filters to one collection when asked", async () => {
    vi.stubGlobal(
      "fetch",
      mockPages([{ items: [item("1", COLL_A), item("2", COLL_B)] }]),
    );
    const out = await findHoldings(API, WALLET, COLL_B as `0x${string}`);
    expect(out).toHaveLength(1);
    expect(out[0].collection).toBe(COLL_B);
  });

  it("matches the collection filter case-insensitively", async () => {
    vi.stubGlobal("fetch", mockPages([{ items: [item("5", COLL_A)] }]));
    const out = await findHoldings(API, WALLET, COLL_A.toUpperCase().replace("0X", "0x") as `0x${string}`);
    expect(out).toHaveLength(1);
  });

  it("skips malformed entries instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      mockPages([{ items: [{ id: "1" }, { token: { address_hash: COLL_A } }, item("9", COLL_A)] }]),
    );
    const out = await findHoldings(API, WALLET);
    expect(out).toHaveLength(1);
    expect(out[0].tokenIds).toEqual(["9"]);
  });

  it("raises when the explorer errors, rather than calling the wallet empty", async () => {
    // This used to return [], which is how a sweep came to report success while
    // leaving tokens behind: a refused request and an empty wallet looked the
    // same. 404 is chosen because it is the one status not worth retrying, so
    // the test doesn't sit through the backoff.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    await expect(findHoldings(API, WALLET)).rejects.toThrow(/404/);
  });
});
