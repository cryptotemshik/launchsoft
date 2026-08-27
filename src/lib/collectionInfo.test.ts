import { describe, expect, it } from "vitest";
import { parseCollectionPage, twitterUrl } from "./collectionInfo";

// Shortened from a real Robinhood Chain collection page: the payload arrives
// escaped inside a script string, which is the part worth pinning down.
const ESCAPED =
  '<script>{\\"isVerified\\":false,\\"externalUrl\\":\\"https://pipedog.xyz/\\",' +
  '\\"twitterUsername\\":\\"pipedogsnft\\",\\"instagramUsername\\":\\"\\",\\"discordUrl\\":\\"\\"}</script>';

describe("parseCollectionPage", () => {
  it("reads a handle and site out of the escaped payload", () => {
    expect(parseCollectionPage(ESCAPED)).toEqual({
      twitter: "pipedogsnft",
      site: "https://pipedog.xyz/",
      floor: null,
    });
  });

  it("reads the same fields unescaped", () => {
    expect(parseCollectionPage('{"twitterUsername":"someproject"}')).toEqual({
      twitter: "someproject",
      site: null,
      floor: null,
    });
  });

  it("treats an empty handle as nothing connected, not as a handle", () => {
    // Most collections look exactly like this, and reporting "" as a handle
    // would put a dead link on nine rows in ten.
    expect(parseCollectionPage('{"twitterUsername":"","externalUrl":""}')).toEqual({
      twitter: null,
      site: null,
      floor: null,
    });
  });

  it("treats null as nothing connected", () => {
    expect(parseCollectionPage('{"twitterUsername":null}')).toEqual({
      twitter: null,
      site: null,
      floor: null,
    });
  });

  it("says it could not tell when the page never mentions the field", () => {
    // The failure this exists for: OpenSea changes its payload, every page
    // parses to "no twitter", and the column confidently reports a dash for
    // the whole chain. Null keeps that out of the cache.
    expect(parseCollectionPage("<html>" + "x".repeat(50_000) + "</html>")).toBeNull();
  });

  it("unwraps a whole URL pasted into the handle box", () => {
    expect(parseCollectionPage('{"twitterUsername":"https://x.com/@someproject"}')?.twitter).toBe(
      "someproject",
    );
    expect(parseCollectionPage('{"twitterUsername":"twitter.com/other_one"}')?.twitter).toBe("other_one");
  });

  it("refuses something that could not be a handle", () => {
    expect(parseCollectionPage('{"twitterUsername":"not a handle at all!!"}')?.twitter).toBeNull();
  });

  it("ignores a site link belonging to some other collection on the page", () => {
    // Recommendation strips carry their own records. Only the one sitting
    // beside this collection's handle is this collection's.
    const far =
      '{"externalUrl":"https://someone-else.example/"}' +
      "y".repeat(2_000) +
      '{"twitterUsername":"ours"}';
    expect(parseCollectionPage(far)).toEqual({ twitter: "ours", site: null, floor: null });
  });

  it("ignores a relative external link", () => {
    expect(parseCollectionPage('{"externalUrl":"/collection/x","twitterUsername":"a"}')?.site).toBeNull();
  });
});

describe("twitterUrl", () => {
  it("points at the account", () => {
    expect(twitterUrl("pipedogsnft")).toBe("https://x.com/pipedogsnft");
  });
});

describe("the floor price, from the same page", () => {
  // Shortened from the live payload: the floor sits under the collection's own
  // record, priced in whatever coin the chain uses.
  const withFloor =
    '{\\"collectionBySlug\\":{\\"slug\\":\\"pipe-dogss\\",\\"floorPrice\\":{\\"pricePerItem\\":' +
    '{\\"token\\":{\\"unit\\":0.0001,\\"symbol\\":\\"ETH\\"},\\"usd\\":0.250716}}}' +
    ',\\"twitterUsername\\":\\"pipedogsnft\\"}';

  it("reads the unit, the coin and the dollar value", () => {
    expect(parseCollectionPage(withFloor)?.floor).toEqual({
      unit: 0.0001,
      symbol: "ETH",
      usd: 0.250716,
    });
  });

  it("never assumes the coin — this chain prices in USDG too", () => {
    expect(
      parseCollectionPage('{"floorPrice":{"unit":0.21,"symbol":"USDG"},"twitterUsername":null}')
        ?.floor,
    ).toEqual({ unit: 0.21, symbol: "USDG", usd: null });
  });

  it("reports no listings as no floor rather than as zero", () => {
    // Most drops here are early enough to have nothing listed, and a floor of
    // 0 would read as "free to buy".
    expect(parseCollectionPage('{"floorPrice":null,"twitterUsername":null}')?.floor).toBeNull();
  });

  it("does not read the next price on the page as a null floor's value", () => {
    // Caught against the live chain: a collection with nothing listed was
    // reported at "0 ETH" because the scan ran past the null and landed in an
    // unrelated record further down the page.
    const nulled =
      '{\\"floorPrice\\":null,\\"somethingElse\\":{\\"unit\\":0,\\"symbol\\":\\"ETH\\"}}' +
      '{\\"twitterUsername\\":null}';
    expect(parseCollectionPage(nulled)?.floor).toBeNull();
  });

  it("ignores the per-item offers, which occur fifty times a page", () => {
    const offers =
      '{"bestOffer":{"unit":9.99,"symbol":"ETH"}}'.repeat(3) + '{"twitterUsername":null}';
    expect(parseCollectionPage(offers)?.floor).toBeNull();
  });
});
