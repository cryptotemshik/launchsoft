import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSocialCache, lookupSocials } from "./socialLookup";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

/** A page big enough to be taken seriously, carrying one handle. */
const page = (handle: string | null) =>
  '<html>' + "x".repeat(30_000) +
  `{\\"isVerified\\":false,\\"twitterUsername\\":${handle === null ? "null" : `\\"${handle}\\"`}}</html>`;

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => clearSocialCache());
afterEach(() => vi.unstubAllGlobals());

describe("lookupSocials", () => {
  it("answers nothing at first and everything once the reads land", async () => {
    // The whole design in one test: the first ask cannot block on a
    // two-megabyte fetch, so it reports the work as pending and the caller
    // comes back for it.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(page("someproject"), { status: 200 })));
    const first = lookupSocials("robinhood", [A]);
    expect(first.known).toEqual({});
    expect(first.pending).toEqual([A]);

    await settle();
    const second = lookupSocials("robinhood", [A]);
    expect(second.pending).toEqual([]);
    expect(second.known[A]).toMatchObject({ twitter: "someproject" });
  });

  it("reads each collection once, however often it is asked about", async () => {
    const fetchMock = vi.fn(async () => new Response(page("once"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    lookupSocials("robinhood", [A, A, A]);
    lookupSocials("robinhood", [A]);
    await settle();
    lookupSocials("robinhood", [A]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes a 404 as an answer — there is no page, so there is no account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    lookupSocials("robinhood", [A]);
    await settle();
    expect(lookupSocials("robinhood", [A]).known[A]).toEqual({ twitter: null, site: null });
  });

  it("does not cache a failure as 'no twitter'", async () => {
    // A timeout is not evidence about the collection, and pinning "none" on
    // one would leave the row wrong for twelve hours.
    const fetchMock = vi.fn(async () => {
      throw new Error("timed out");
    });
    vi.stubGlobal("fetch", fetchMock);
    lookupSocials("robinhood", [A]);
    await settle();
    expect(lookupSocials("robinhood", [A]).known).toEqual({});
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a truncated page rather than reading nothing out of it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>rate limited</html>")));
    lookupSocials("robinhood", [A]);
    await settle();
    expect(lookupSocials("robinhood", [A]).known).toEqual({});
  });

  it("caches nothing from a full page that no longer carries the field", async () => {
    // If OpenSea changes its payload, every row would otherwise be pinned as
    // "no twitter" for twelve hours before anyone noticed.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>" + "x".repeat(40_000) + "</html>")));
    lookupSocials("robinhood", [A]);
    await settle();
    expect(lookupSocials("robinhood", [A]).known).toEqual({});
  });

  it("queues no more than the limit allows", async () => {
    const fetchMock = vi.fn(async () => new Response(page(null), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = lookupSocials("robinhood", [A, B], 1);
    expect(r.pending).toEqual([A]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
