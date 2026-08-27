import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCollectionCache, lookupCollections } from "./collectionLookup";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

/** A page big enough to be taken seriously, carrying one handle. */
const page = (handle: string | null) =>
  '<html>' + "x".repeat(30_000) +
  `{\\"isVerified\\":false,\\"twitterUsername\\":${handle === null ? "null" : `\\"${handle}\\"`}}</html>`;

const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * A fetch that answers the collection page and the twitter mirrors
 * differently — the lookup calls both, and only one of them serves HTML.
 */
function stub(pageBody: string | number, followers?: number) {
  return vi.fn(async (u: string) => {
    if (/fxtwitter|vxtwitter/.test(u)) {
      return followers === undefined
        ? new Response("<!DOCTYPE html>", { status: 200 })
        : new Response(JSON.stringify({ user: { screen_name: "someproject", followers } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    }
    return typeof pageBody === "number"
      ? new Response("", { status: pageBody })
      : new Response(pageBody, { status: 200 });
  });
}

beforeEach(() => clearCollectionCache());
afterEach(() => vi.unstubAllGlobals());

describe("lookupCollections", () => {
  it("answers nothing at first and everything once the reads land", async () => {
    // The whole design in one test: the first ask cannot block on a
    // two-megabyte fetch, so it reports the work as pending and the caller
    // comes back for it.
    vi.stubGlobal("fetch", stub(page("someproject"), 136));
    const first = lookupCollections("robinhood", [A]);
    expect(first.known).toEqual({});
    expect(first.pending).toEqual([A]);

    await settle();
    const second = lookupCollections("robinhood", [A]);
    expect(second.pending).toEqual([]);
    expect(second.known[A]).toMatchObject({ twitter: "someproject" });
  });

  it("reads each collection once, however often it is asked about", async () => {
    const fetchMock = stub(page("once"), 5);
    vi.stubGlobal("fetch", fetchMock);
    lookupCollections("robinhood", [A, A, A]);
    lookupCollections("robinhood", [A]);
    await settle();
    lookupCollections("robinhood", [A]);
    await settle();
    const pages = fetchMock.mock.calls.filter((c) => /opensea/.test(c[0] as string));
    expect(pages).toHaveLength(1);
  });

  it("takes a 404 as an answer — there is no page, so there is no account", async () => {
    vi.stubGlobal("fetch", stub(404));
    lookupCollections("robinhood", [A]);
    await settle();
    expect(lookupCollections("robinhood", [A]).known[A]).toEqual({
      twitter: null,
      site: null,
      floor: null,
    });
  });

  it("does not cache a failure as 'no twitter'", async () => {
    // A timeout is not evidence about the collection, and pinning "none" on
    // one would leave the row wrong for twelve hours.
    const fetchMock = vi.fn(async () => {
      throw new Error("timed out");
    });
    vi.stubGlobal("fetch", fetchMock);
    lookupCollections("robinhood", [A]);
    await settle();
    expect(lookupCollections("robinhood", [A]).known).toEqual({});
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a truncated page rather than reading nothing out of it", async () => {
    vi.stubGlobal("fetch", stub("<html>rate limited</html>"));
    lookupCollections("robinhood", [A]);
    await settle();
    expect(lookupCollections("robinhood", [A]).known).toEqual({});
  });

  it("caches nothing from a full page that no longer carries the field", async () => {
    // If OpenSea changes its payload, every row would otherwise be pinned as
    // "no twitter" for twelve hours before anyone noticed.
    vi.stubGlobal("fetch", stub("<html>" + "x".repeat(40_000) + "</html>"));
    lookupCollections("robinhood", [A]);
    await settle();
    expect(lookupCollections("robinhood", [A]).known).toEqual({});
  });

  it("queues no more than the limit allows", async () => {
    const fetchMock = stub(page(null));
    vi.stubGlobal("fetch", fetchMock);
    const r = lookupCollections("robinhood", [A, B], 1);
    expect(r.pending).toEqual([A]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the follower count that gives the handle meaning", () => {
  it("arrives after the page and fills the cell in", async () => {
    vi.stubGlobal("fetch", stub(page("someproject"), 136));
    lookupCollections("robinhood", [A]);
    await settle();
    await settle();
    expect(lookupCollections("robinhood", [A]).known[A]).toMatchObject({
      twitter: "someproject",
      followers: 136,
    });
  });

  it("asks the mirrors once per handle, not once per collection", async () => {
    // A creator with three drops has one account, and three identical reads
    // would be three chances to get rate-limited for no new information.
    const fetchMock = stub(page("someproject"), 7);
    vi.stubGlobal("fetch", fetchMock);
    lookupCollections("robinhood", [A, B]);
    await settle();
    await settle();
    const mirror = fetchMock.mock.calls.filter((c) => /fxtwitter|vxtwitter/.test(c[0] as string));
    expect(mirror).toHaveLength(1);
  });

  it("still reports the handle when both mirrors refuse", async () => {
    // Half an answer beats none: the handle is the link, the count is colour.
    vi.stubGlobal("fetch", stub(page("someproject")));
    lookupCollections("robinhood", [A]);
    await settle();
    await settle();
    const r = lookupCollections("robinhood", [A]);
    expect(r.known[A]).toMatchObject({ twitter: "someproject" });
    expect(r.known[A].followers).toBeUndefined();
    // And it stops asking, rather than re-reading on every refresh.
    expect(r.pending).toEqual([]);
  });
});
