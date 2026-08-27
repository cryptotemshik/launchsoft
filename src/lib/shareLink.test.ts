import { describe, expect, it } from "vitest";
import { buildShareLink, readShareLink } from "./shareLink";

const target = { url: "https://wrote-outputs.trycloudflare.com", token: "view-abc123" };

describe("share links", () => {
  it("round-trips a target", () => {
    const link = buildShareLink("https://launchpad-44c.pages.dev", target);
    expect(readShareLink(new URL(link).hash)).toEqual(target);
  });

  it("keeps the secret out of the part a server would see", () => {
    // The whole reason it is a fragment: a query string lands in access logs
    // and Referer headers.
    const link = buildShareLink("https://launchpad-44c.pages.dev", target);
    expect(link.split("#")[0]).not.toContain("view");
    expect(link).not.toContain(target.token);
  });

  it("survives an origin that already carries a hash or query", () => {
    const link = buildShareLink("https://x.dev/?a=1#live", target);
    expect(link.startsWith("https://x.dev/#view=")).toBe(true);
  });

  it("does not double the slash on an origin that ends in one", () => {
    expect(buildShareLink("https://x.dev/", target)).toMatch(/^https:\/\/x\.dev\/#view=/);
  });

  it("handles a token with characters base64 would trip on", () => {
    const odd = { url: "https://x.dev", token: "a+b/c=d?e#f и юникод" };
    const link = buildShareLink("https://x.dev", odd);
    expect(readShareLink(new URL(link).hash)).toEqual(odd);
  });

  it("reads nothing out of an ordinary page load", () => {
    expect(readShareLink("")).toBeNull();
    expect(readShareLink("#live")).toBeNull();
  });

  it("returns null rather than throwing on a mangled link", () => {
    // Someone re-types half of it into a phone. That should land on the
    // ordinary app, not on a blank screen.
    expect(readShareLink("#view=not-base64!!")).toBeNull();
    expect(readShareLink("#view=" + btoa("[1,2,3]"))).toBeNull();
    expect(readShareLink("#view=" + btoa('{"url":"x"}'))).toBeNull();
  });

  it("refuses a target that isn't an http endpoint", () => {
    // A link is untrusted input; this is the one thing worth checking about it.
    const bad = "#view=" + btoa(JSON.stringify({ url: "javascript:alert(1)", token: "t" }));
    expect(readShareLink(bad)).toBeNull();
  });

  it("refuses an empty url or token", () => {
    expect(readShareLink("#view=" + btoa(JSON.stringify({ url: "", token: "t" })))).toBeNull();
    expect(
      readShareLink("#view=" + btoa(JSON.stringify({ url: "https://x.dev", token: "" }))),
    ).toBeNull();
  });
});
