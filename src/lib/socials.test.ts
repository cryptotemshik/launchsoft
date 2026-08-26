import { describe, expect, it } from "vitest";
import { parseSocials, twitterUrl } from "./socials";

// Shortened from a real Robinhood Chain collection page: the payload arrives
// escaped inside a script string, which is the part worth pinning down.
const ESCAPED =
  '<script>{\\"isVerified\\":false,\\"externalUrl\\":\\"https://pipedog.xyz/\\",' +
  '\\"twitterUsername\\":\\"pipedogsnft\\",\\"instagramUsername\\":\\"\\",\\"discordUrl\\":\\"\\"}</script>';

describe("parseSocials", () => {
  it("reads a handle and site out of the escaped payload", () => {
    expect(parseSocials(ESCAPED)).toEqual({
      twitter: "pipedogsnft",
      site: "https://pipedog.xyz/",
    });
  });

  it("reads the same fields unescaped", () => {
    expect(parseSocials('{"twitterUsername":"someproject"}')).toEqual({
      twitter: "someproject",
      site: null,
    });
  });

  it("treats an empty handle as nothing connected, not as a handle", () => {
    // Most collections look exactly like this, and reporting "" as a handle
    // would put a dead link on nine rows in ten.
    expect(parseSocials('{"twitterUsername":"","externalUrl":""}')).toEqual({
      twitter: null,
      site: null,
    });
  });

  it("treats null as nothing connected", () => {
    expect(parseSocials('{"twitterUsername":null}')).toEqual({ twitter: null, site: null });
  });

  it("says it could not tell when the page never mentions the field", () => {
    // The failure this exists for: OpenSea changes its payload, every page
    // parses to "no twitter", and the column confidently reports a dash for
    // the whole chain. Null keeps that out of the cache.
    expect(parseSocials("<html>" + "x".repeat(50_000) + "</html>")).toBeNull();
  });

  it("unwraps a whole URL pasted into the handle box", () => {
    expect(parseSocials('{"twitterUsername":"https://x.com/@someproject"}')?.twitter).toBe(
      "someproject",
    );
    expect(parseSocials('{"twitterUsername":"twitter.com/other_one"}')?.twitter).toBe("other_one");
  });

  it("refuses something that could not be a handle", () => {
    expect(parseSocials('{"twitterUsername":"not a handle at all!!"}')?.twitter).toBeNull();
  });

  it("ignores a site link belonging to some other collection on the page", () => {
    // Recommendation strips carry their own records. Only the one sitting
    // beside this collection's handle is this collection's.
    const far =
      '{"externalUrl":"https://someone-else.example/"}' +
      "y".repeat(2_000) +
      '{"twitterUsername":"ours"}';
    expect(parseSocials(far)).toEqual({ twitter: "ours", site: null });
  });

  it("ignores a relative external link", () => {
    expect(parseSocials('{"externalUrl":"/collection/x","twitterUsername":"a"}')?.site).toBeNull();
  });
});

describe("twitterUrl", () => {
  it("points at the account", () => {
    expect(twitterUrl("pipedogsnft")).toBe("https://x.com/pipedogsnft");
  });
});
