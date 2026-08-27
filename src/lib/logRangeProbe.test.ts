import { describe, expect, it } from "vitest";
import { probeLogRange, PROBE_BLOCKS } from "./logRangeProbe";

const ADDR = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

function answering(body: unknown, status = 200): typeof fetch {
  return (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
}

describe("asking an endpoint whether it can serve a scan", () => {
  it("accepts one that answers", async () => {
    const v = await probeLogRange("https://x/", ADDR, 1_000_000n, answering({ result: [] }));
    expect(v.ok).toBe(true);
  });

  it("catches a free tier that caps the range, and reads back the cap", async () => {
    // Alchemy's real wording, which is the whole reason this exists.
    const v = await probeLogRange(
      "https://x/",
      ADDR,
      1_000_000n,
      answering({
        error: {
          message:
            "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. " +
            "Based on your parameters, this block range should work: [0x2d5eef6, 0x2d5eeff]. Upgrade to PAYG.",
        },
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.suggested).toBe(10);
    expect(v.reason).toContain("Free tier");
  });

  it("reports a refusal that names no width, without inventing one", async () => {
    const v = await probeLogRange(
      "https://x/",
      ADDR,
      1_000_000n,
      answering({ error: { message: "query exceeds max results" } }),
    );
    expect(v.ok).toBe(false);
    expect(v.suggested).toBeUndefined();
  });

  it("treats a rate limit as busy, not incapable", async () => {
    // An endpoint under load is a different problem with a different fix.
    // Calling it incapable would have the server cry wolf about a good node.
    const v = await probeLogRange("https://x/", ADDR, 1_000_000n, answering({}, 429));
    expect(v.ok).toBe(true);
  });

  it("does not call a bad day a cap", async () => {
    // The chain's own node answers a wide unfiltered query this way when it is
    // struggling, and it is the one endpoint here with no range cap at all.
    // Reading it as a cap had the server accuse the wrong endpoint entirely.
    const v = await probeLogRange(
      "https://x/",
      ADDR,
      1_000_000n,
      answering({ error: { message: "internal server errror" } }),
    );
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("internal server errror");
  });

  it("does not accuse an endpoint it could not reach", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const v = await probeLogRange("https://x/", ADDR, 1_000_000n, dead);
    expect(v.ok).toBe(true);
  });

  it("asks for a range worth scanning with, ending at the tip", async () => {
    let sent: Record<string, string> = {};
    const spy = (async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body).params[0];
      return { status: 200, json: async () => ({ result: [] }) };
    }) as unknown as typeof fetch;
    await probeLogRange("https://x/", ADDR, 1_000_000n, spy);
    expect(BigInt(sent.toBlock)).toBe(1_000_000n);
    expect(BigInt(sent.toBlock) - BigInt(sent.fromBlock)).toBe(PROBE_BLOCKS);
  });

  it("does not ask for blocks before the genesis of a young chain", async () => {
    let sent: Record<string, string> = {};
    const spy = (async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body).params[0];
      return { status: 200, json: async () => ({ result: [] }) };
    }) as unknown as typeof fetch;
    await probeLogRange("https://x/", ADDR, 500n, spy);
    expect(BigInt(sent.fromBlock)).toBe(0n);
  });
});
