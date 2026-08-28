import { describe, expect, it } from "vitest";
import { warmWarnings } from "./runner";
import type { WarmReport } from "../lib/rpcBlast";

const report = (over: Partial<WarmReport> = {}): WarmReport => ({
  wanted: 100,
  opened: 300,
  failed: 0,
  short: [],
  capped: false,
  ...over,
});

describe("saying when a warm-up fell short", () => {
  it("says nothing about descriptors when the limit cannot be read", () => {
    // Guessing a limit would either cry wolf everywhere or stay silent where
    // it matters. Not knowing is its own answer.
    expect(warmWarnings(report(), 5000, 3, null)).toEqual([]);
  });

  it("treats an unlimited descriptor budget as fine", () => {
    expect(warmWarnings(report(), 5000, 3, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("stays quiet when everything opened", () => {
    // A warning on a healthy run is worse than none: it teaches you to skip
    // the line where the real one will appear.
    expect(warmWarnings(report(), 100, 3, 20_000)).toEqual([]);
  });

  it("says so when the socket ceiling clamped the request", () => {
    // The exact failure this was written for: a thousand wallets asked to warm
    // a thousand connections, got 512, and 488 negotiated TLS at T-0.
    const out = warmWarnings(report({ wanted: 512, capped: true }), 1000, 3, 65_536);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("512 connection(s) per endpoint");
    expect(out[0]).toContain("1000 wallet(s)");
    // Naming the fix matters — it is not in this program.
    expect(out[0]).toContain("SNIPE_MAX_SOCKETS");
  });

  it("warns before the descriptor limit bites, not after", () => {
    // 900 × 3 = 2700 sockets against the 1024 a fresh Ubuntu box gives you.
    const out = warmWarnings(report(), 900, 3, 1024);
    expect(out.some((l) => l.includes("ulimit -n"))).toBe(true);
    expect(out.some((l) => l.includes("2700 sockets"))).toBe(true);
  });

  it("leaves a comfortable descriptor budget alone", () => {
    // 20 wallets × 3 endpoints is nowhere near any sane limit.
    expect(warmWarnings(report(), 20, 3, 1024).filter((l) => l.includes("ulimit"))).toEqual([]);
  });

  it("names the endpoints that answered short, without listing fifty", () => {
    const out = warmWarnings(
      report({
        short: [
          { label: "sequencer", opened: 4 },
          { label: "public", opened: 0 },
          { label: "alchemy", opened: 7 },
          { label: "spare", opened: 1 },
        ],
      }),
      20,
      3,
      20_000,
    );
    const line = out.find((l) => l.includes("fewer warm-ups"))!;
    expect(line).toContain("sequencer (4/100)");
    expect(line).toContain("public (0/100)");
    expect(line).not.toContain("spare");
  });

  it("reports every distinct problem rather than only the first", () => {
    const out = warmWarnings(
      report({ wanted: 512, capped: true, short: [{ label: "public", opened: 3 }] }),
      1000,
      3,
      1024,
    );
    expect(out).toHaveLength(3);
  });
});
