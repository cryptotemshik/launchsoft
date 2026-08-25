import { describe, expect, it } from "vitest";
import { extractTunnelUrl } from "./tunnelUrl";

const banner = (host: string) => `
2026-08-25T12:00:00Z INF +--------------------------------------------------------+
2026-08-25T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at:       |
2026-08-25T12:00:00Z INF |  https://${host}.trycloudflare.com                      |
2026-08-25T12:00:00Z INF +--------------------------------------------------------+
`;

describe("extractTunnelUrl", () => {
  it("finds the URL in cloudflared's banner", () => {
    expect(extractTunnelUrl(banner("communities-maximize-alice-philips"))).toBe(
      "https://communities-maximize-alice-philips.trycloudflare.com",
    );
  });

  it("takes the LAST url — every earlier one in the log is already dead", () => {
    const log = banner("first-old-address") + banner("second-current-address");
    expect(extractTunnelUrl(log)).toBe("https://second-current-address.trycloudflare.com");
  });

  it("is null when the log has no tunnel banner yet", () => {
    expect(extractTunnelUrl("2026-08-25 INF Starting tunnel\nINF Registered")).toBeNull();
  });

  it("is null on empty input", () => {
    expect(extractTunnelUrl("")).toBeNull();
  });

  it("ignores other cloudflare hostnames", () => {
    const log = "connecting to https://api.cloudflare.com and https://dash.cloudflare.com";
    expect(extractTunnelUrl(log)).toBeNull();
  });

  it("normalises case, since a hostname is case-insensitive", () => {
    expect(extractTunnelUrl("visit HTTPS://Alpha-Beta.TryCloudflare.com now")).toBe(
      "https://alpha-beta.trycloudflare.com",
    );
  });

  it("handles a hostname with digits", () => {
    expect(extractTunnelUrl(banner("mode-2-alpha-7"))).toBe(
      "https://mode-2-alpha-7.trycloudflare.com",
    );
  });

  it("picks the URL out of a log full of unrelated noise", () => {
    const log = [
      "INF Requesting new quick Tunnel on trycloudflare.com...",
      "ERR failed to connect to origin error=dial tcp 127.0.0.1:8787: connect: connection refused",
      banner("noisy-log-address"),
      "INF Registered tunnel connection connIndex=0 location=iad07",
    ].join("\n");
    expect(extractTunnelUrl(log)).toBe("https://noisy-log-address.trycloudflare.com");
  });
});
