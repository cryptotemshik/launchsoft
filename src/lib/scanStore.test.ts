import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getScanState,
  mergeCollectionInfo,
  resetScanStore,
  runScan,
  scanIsStale,
  setScanArrivalHandler,
  setScanEvery,
  setScanFetcher,
  subscribeScan,
  STALE_MS,
  type ScanView,
} from "./scanStore";

const view = (n: number, hours = 24): ScanView =>
  ({
    drops: Array.from({ length: n }, (_, i) => ({
      contract: `0x${String(i).padStart(40, "0")}`,
      priceWei: "0",
      startTime: 0,
      endTime: 0,
      maxPerWallet: 1,
      feeBps: 0,
      block: 1,
    })),
    hours,
    events: n,
    collections: n,
    enriched: n,
    fromBlock: 0,
    toBlock: 1,
    blocksPerHour: 36_000,
    chain: "test",
    explorerUrl: "",
    now: 0,
    tookMs: 1,
  }) as ScanView;

/**
 * The tests run without a DOM, and the loop asks the document whether anyone
 * can see the page. Standing one in is the whole of what it needs, and is
 * more honest than making the store take a predicate it would only ever be
 * given by a test.
 */
function visibility(v: "visible" | "hidden"): void {
  (globalThis as { document?: { visibilityState: string } }).document = { visibilityState: v };
}

afterEach(() => {
  resetScanStore();
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

describe("holding a scan across a visit", () => {
  it("keeps what it read when every listener goes away", async () => {
    setScanFetcher(async () => view(3));
    const off = subscribeScan(() => {});
    await runScan(24);
    // The tab being closed is exactly this: the subscriber leaves and the
    // component is gone. What it paid for must not go with it.
    off();
    expect(getScanState().view?.drops).toHaveLength(3);
    expect(scanIsStale()).toBe(false);
  });

  it("calls a held scan stale once it has aged", async () => {
    setScanFetcher(async () => view(1));
    await runScan(24);
    expect(scanIsStale(Date.now() + STALE_MS - 1)).toBe(false);
    expect(scanIsStale(Date.now() + STALE_MS + 1)).toBe(true);
  });

  it("has nothing to show before the first scan, and says so", () => {
    expect(getScanState().view).toBeNull();
    expect(scanIsStale()).toBe(true);
  });

  it("remembers the window the scan was taken for", async () => {
    setScanFetcher(async (h) => view(1, h));
    await runScan(720);
    expect(getScanState().hours).toBe(720);
  });
});

describe("running one at a time", () => {
  it("collapses concurrent asks into the request already in flight", async () => {
    let calls = 0;
    setScanFetcher(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return view(1);
    });
    await Promise.all([runScan(24), runScan(24), runScan(24)]);
    expect(calls).toBe(1);
  });

  it("does nothing at all without a fetcher", async () => {
    await runScan(24);
    expect(getScanState().view).toBeNull();
    expect(getScanState().busy).toBe(false);
  });
});

describe("what arrived since last time", () => {
  it("says nothing on the first scan — everything is new and that is not news", async () => {
    const fired = vi.fn();
    setScanArrivalHandler(fired);
    setScanFetcher(async () => view(3));
    await runScan(24);
    expect(getScanState().justIn.size).toBe(0);
    expect(fired).not.toHaveBeenCalled();
  });

  it("flags only the contracts the previous scan did not hold", async () => {
    const fired = vi.fn();
    setScanArrivalHandler(fired);
    let n = 2;
    setScanFetcher(async () => view(n));
    await runScan(24);
    n = 4;
    await runScan(24);
    expect([...getScanState().justIn]).toEqual([
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000003",
    ]);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe("when the server will not answer", () => {
  it("explains a 404 rather than showing the status code", async () => {
    setScanFetcher(async () => {
      throw new Error("HTTP 404");
    });
    await runScan(24);
    expect(getScanState().error).toMatch(/too old to scan/);
  });

  it("keeps the rows it already had", async () => {
    setScanFetcher(async () => view(2));
    await runScan(24);
    setScanFetcher(async () => {
      throw new Error("network down");
    });
    await runScan(24);
    expect(getScanState().error).toBe("network down");
    expect(getScanState().view?.drops).toHaveLength(2);
  });
});

describe("the refresh loop", () => {
  it("keeps refreshing with nobody subscribed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    setScanFetcher(async () => {
      calls++;
      return view(1);
    });
    visibility("visible");
    setScanEvery(3);
    // No subscriber: the tab is closed. The loop is the whole reason the
    // interval was moved out of the component.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
  });

  it("counts down between refreshes", async () => {
    vi.useFakeTimers();
    setScanFetcher(async () => view(1));
    setScanEvery(5);
    expect(getScanState().nextIn).toBe(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getScanState().nextIn).toBe(3);
  });

  it("stands down while the browser tab is hidden", async () => {
    vi.useFakeTimers();
    let calls = 0;
    setScanFetcher(async () => {
      calls++;
      return view(1);
    });
    visibility("hidden");
    setScanEvery(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toBe(0);
  });

  it("stops when set back to off", async () => {
    vi.useFakeTimers();
    let calls = 0;
    setScanFetcher(async () => {
      calls++;
      return view(1);
    });
    visibility("visible");
    setScanEvery(2);
    setScanEvery(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);
    expect(getScanState().every).toBe(0);
  });
});

describe("collection lookups", () => {
  it("merges into what is already known rather than replacing it", () => {
    mergeCollectionInfo({ "0xa": { twitter: "one" } as never }, undefined);
    mergeCollectionInfo({ "0xb": { twitter: "two" } as never }, undefined);
    expect(Object.keys(getScanState().info).sort()).toEqual(["0xa", "0xb"]);
  });

  it("leaves the state alone when there is nothing to merge", () => {
    const before = getScanState();
    mergeCollectionInfo({}, {});
    expect(getScanState()).toBe(before);
  });
});
