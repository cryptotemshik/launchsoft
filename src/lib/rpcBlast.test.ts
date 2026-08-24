import { describe, expect, it, vi, afterEach } from "vitest";
import {
  blastToAll,
  isAlreadyKnown,
  labelRpc,
  parseRpcEndpoints,
  prepareBlast,
} from "./rpcBlast";

describe("labelRpc", () => {
  it("recognises known providers regardless of exact host", () => {
    expect(labelRpc("https://base-mainnet.g.alchemy.com/v2/key", 0)).toBe("alchemy");
    expect(labelRpc("https://mainnet-sequencer.base.org", 0)).toBe("sequencer");
    expect(labelRpc("https://rpc.flashbots.net", 0)).toBe("flashbots-protect");
  });
  it("falls back to the hostname for unrecognised URLs", () => {
    expect(labelRpc("https://my-node.example.com/rpc", 0)).toBe("my-node.example.com");
  });
  it("falls back to an index label for unparseable input", () => {
    expect(labelRpc("not a url", 2)).toBe("rpc[2]");
  });
});

describe("parseRpcEndpoints", () => {
  it("labels every non-empty URL", () => {
    const eps = parseRpcEndpoints(["https://a.example.com", "https://b.example.com"]);
    expect(eps).toHaveLength(2);
    expect(eps.map((e) => e.url)).toEqual(["https://a.example.com", "https://b.example.com"]);
  });
  it("drops blanks and de-dupes exact URLs", () => {
    const eps = parseRpcEndpoints(["https://a.example.com", "", "  ", "https://a.example.com"]);
    expect(eps).toHaveLength(1);
  });
});

describe("prepareBlast", () => {
  it("derives the same tx hash for the same raw tx, every time", () => {
    const raw = "0x02f86f0102030485012a05f200850165a0bc0083030d40940000000000000000000000000000000000000000018080c0";
    const a = prepareBlast(raw as `0x${string}`);
    const b = prepareBlast(raw as `0x${string}`);
    expect(a.txHash).toBe(b.txHash);
    expect(a.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("builds a well-formed eth_sendRawTransaction envelope", () => {
    const raw = "0x02f8";
    const { body } = prepareBlast(raw as `0x${string}`);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [raw] });
  });
});

describe("isAlreadyKnown", () => {
  it("recognises the two phrasings nodes use for a duplicate submission", () => {
    expect(isAlreadyKnown("already known")).toBe(true);
    expect(isAlreadyKnown("err: Already Known")).toBe(true);
    expect(isAlreadyKnown("transaction already exists")).toBe(true);
  });
  it("is false for unrelated errors and null", () => {
    expect(isAlreadyKnown("insufficient funds")).toBe(false);
    expect(isAlreadyKnown(null)).toBe(false);
  });
});

describe("blastToAll", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects a result per endpoint, success and error alike", async () => {
    const raw = "0x02f8";
    const prepared = prepareBlast(raw as `0x${string}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ result: "0xabc" }) })
      .mockResolvedValueOnce({ json: async () => ({ error: { message: "already known" } }) })
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const endpoints = parseRpcEndpoints(["https://a", "https://b", "https://c"]);
    const { txHash, results } = blastToAll(prepared, endpoints);
    expect(txHash).toBe(prepared.txHash);

    const settled = await results;
    expect(settled).toHaveLength(3);
    expect(settled[0]).toMatchObject({ txHash: "0xabc", error: null });
    expect(settled[1].error).toBe("already known");
    expect(isAlreadyKnown(settled[1].error)).toBe(true);
    expect(settled[2].error).toBe("network down");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("dispatches to every endpoint in the same tick (fire-and-forget)", () => {
    const raw = "0x02f8";
    const prepared = prepareBlast(raw as `0x${string}`);
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    vi.stubGlobal("fetch", fetchMock);

    const endpoints = parseRpcEndpoints(["https://a", "https://b"]);
    blastToAll(prepared, endpoints);
    // No await at all — both fetches must already have been issued.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
