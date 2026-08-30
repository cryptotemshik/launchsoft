import { afterEach, describe, expect, it, vi } from "vitest";
import { createTabStore, DEFAULT_STALE_MS, type TabStore } from "./tabStore";

interface Data {
  rows: number[];
  label: string;
}

let store: TabStore<Data> | null = null;
const open = (opts?: Parameters<typeof createTabStore>[1]) => {
  store = createTabStore<Data>({ rows: [], label: "" }, opts);
  return store;
};

/**
 * The tests run without a DOM, and the loop asks the document whether anyone
 * can see the page. Standing one in is the whole of what it needs.
 */
function visibility(v: "visible" | "hidden"): void {
  (globalThis as { document?: { visibilityState: string } }).document = { visibilityState: v };
}

afterEach(() => {
  store?.reset();
  store = null;
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

describe("holding what a tab fetched", () => {
  it("keeps it when every listener goes away", async () => {
    const s = open();
    s.setFetcher(async () => s.set({ rows: [1, 2, 3] }));
    const off = s.subscribe(() => {});
    await s.run();
    // Leaving the tab is exactly this: the subscriber goes and the component
    // is gone. What it paid for must not go with it.
    off();
    expect(s.getState().data.rows).toEqual([1, 2, 3]);
    expect(s.isStale()).toBe(false);
  });

  it("starts with the shape it was given rather than null", () => {
    const s = open();
    expect(s.getState().data).toEqual({ rows: [], label: "" });
    expect(s.isStale()).toBe(true);
  });

  it("merges a patch instead of replacing the whole of it", async () => {
    const s = open();
    s.setFetcher(async () => {
      s.set({ rows: [1] });
      s.set({ label: "done" });
    });
    await s.run();
    expect(s.getState().data).toEqual({ rows: [1], label: "done" });
  });

  it("goes stale on the clock it was given", async () => {
    const s = open({ staleMs: 1_000 });
    s.setFetcher(async () => s.set({ rows: [1] }));
    await s.run();
    expect(s.isStale(Date.now() + 999)).toBe(false);
    expect(s.isStale(Date.now() + 1_001)).toBe(true);
  });

  it("uses a sane default when given no clock", async () => {
    const s = open();
    s.setFetcher(async () => s.set({ rows: [1] }));
    await s.run();
    expect(s.isStale(Date.now() + DEFAULT_STALE_MS + 1)).toBe(true);
  });

  it("hands back the same snapshot object until something changes", async () => {
    // useSyncExternalStore compares by identity: a fresh object every read is
    // an infinite render loop.
    const s = open();
    expect(s.getState()).toBe(s.getState());
    s.setFetcher(async () => s.set({ rows: [1] }));
    await s.run();
    expect(s.getState()).toBe(s.getState());
  });

  it("tells its listeners when something does change", async () => {
    const s = open();
    const heard = vi.fn();
    s.subscribe(heard);
    s.setFetcher(async () => s.set({ rows: [1] }));
    await s.run();
    expect(heard).toHaveBeenCalled();
  });
});

describe("running one at a time", () => {
  it("collapses concurrent asks into the one already in flight", async () => {
    const s = open();
    let calls = 0;
    s.setFetcher(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
    });
    await Promise.all([s.run(), s.run(), s.run()]);
    expect(calls).toBe(1);
  });

  it("does nothing at all without a fetcher", async () => {
    const s = open();
    await s.run();
    expect(s.getState().busy).toBe(false);
    expect(s.getState().at).toBe(0);
  });

  it("is busy while it runs and not after", async () => {
    const s = open();
    let seen = false;
    s.setFetcher(async () => {
      seen = s.getState().busy;
    });
    await s.run();
    expect(seen).toBe(true);
    expect(s.getState().busy).toBe(false);
  });
});

describe("when the server will not answer", () => {
  it("keeps what it already had", async () => {
    const s = open();
    s.setFetcher(async () => s.set({ rows: [1, 2] }));
    await s.run();
    s.setFetcher(async () => {
      throw new Error("network down");
    });
    await s.run();
    expect(s.getState().error).toBe("network down");
    expect(s.getState().data.rows).toEqual([1, 2]);
  });

  it("does not stamp a failed run as a successful one", async () => {
    const s = open();
    s.setFetcher(async () => {
      throw new Error("nope");
    });
    await s.run();
    // Otherwise a failing tab looks fresh and never retries on reopening.
    expect(s.getState().at).toBe(0);
    expect(s.isStale()).toBe(true);
  });

  it("puts the message through the description it was given", async () => {
    const s = open({ describeError: (m) => (/404/.test(m) ? "server too old" : m) });
    s.setFetcher(async () => {
      throw new Error("HTTP 404");
    });
    await s.run();
    expect(s.getState().error).toBe("server too old");
  });

  it("takes a failure that did not come from a load", () => {
    const s = open();
    s.setError("could not recolour that row");
    expect(s.getState().error).toBe("could not recolour that row");
    s.setError(null);
    expect(s.getState().error).toBeNull();
  });

  it("clears an old error once a run succeeds", async () => {
    const s = open();
    s.setFetcher(async () => {
      throw new Error("nope");
    });
    await s.run();
    s.setFetcher(async () => s.set({ rows: [1] }));
    await s.run();
    expect(s.getState().error).toBeNull();
  });
});

describe("the refresh loop", () => {
  it("keeps refreshing with nobody subscribed", async () => {
    vi.useFakeTimers();
    const s = open();
    let calls = 0;
    s.setFetcher(async () => {
      calls++;
    });
    visibility("visible");
    s.setEvery(3);
    // No subscriber: the tab is closed. That is the whole reason the interval
    // lives out here.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
  });

  it("counts down between refreshes", async () => {
    vi.useFakeTimers();
    const s = open();
    s.setFetcher(async () => {});
    s.setEvery(5);
    expect(s.getState().nextIn).toBe(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.getState().nextIn).toBe(3);
  });

  it("stands down while the browser tab is hidden", async () => {
    vi.useFakeTimers();
    const s = open();
    let calls = 0;
    s.setFetcher(async () => {
      calls++;
    });
    visibility("hidden");
    s.setEvery(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toBe(0);
  });

  it("stops when set back to off", async () => {
    vi.useFakeTimers();
    const s = open();
    let calls = 0;
    s.setFetcher(async () => {
      calls++;
    });
    visibility("visible");
    s.setEvery(2);
    s.setEvery(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);
    expect(s.getState().every).toBe(0);
  });

  it("does not stack a second interval when set twice", async () => {
    vi.useFakeTimers();
    const s = open();
    let calls = 0;
    s.setFetcher(async () => {
      calls++;
    });
    visibility("visible");
    s.setEvery(2);
    s.setEvery(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1);
  });
});

describe("keeping stores apart", () => {
  it("gives each one its own data", async () => {
    const a = createTabStore<Data>({ rows: [], label: "a" });
    const b = createTabStore<Data>({ rows: [], label: "b" });
    a.setFetcher(async () => a.set({ rows: [1] }));
    await a.run();
    expect(b.getState().data.rows).toEqual([]);
    expect(b.getState().data.label).toBe("b");
    a.reset();
    b.reset();
  });

  it("does not hand out the initial object itself", async () => {
    // Two stores from one literal, or one store reset twice, would otherwise
    // share an array and quietly accumulate each other's rows.
    const initial = { rows: [] as number[], label: "" };
    const a = createTabStore<Data>(initial);
    a.set({ rows: [1] });
    expect(initial.rows).toEqual([]);
    a.reset();
    expect(a.getState().data.rows).toEqual([]);
  });
});
