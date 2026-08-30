import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyWatchlistChanged,
  onWatchlistChanged,
  resetWatchlistSignal,
} from "./watchlistSignal";
import { createTabStore } from "./tabStore";

afterEach(() => resetWatchlistSignal());

describe("telling the other view the list changed", () => {
  it("reaches everyone listening", () => {
    const a = vi.fn();
    const b = vi.fn();
    onWatchlistChanged(a);
    onWatchlistChanged(b);
    notifyWatchlistChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("names the writer, so it can skip its own change", () => {
    // The writer has already applied the change; reading again would cost a
    // request to confirm what it just did.
    const mine = {};
    let toldSomeoneElse = false;
    onWatchlistChanged((source) => {
      if (source !== mine) toldSomeoneElse = true;
    });
    notifyWatchlistChanged(mine);
    expect(toldSomeoneElse).toBe(false);
    notifyWatchlistChanged({});
    expect(toldSomeoneElse).toBe(true);
  });

  it("stops telling a listener that unsubscribed", () => {
    const heard = vi.fn();
    const off = onWatchlistChanged(heard);
    off();
    notifyWatchlistChanged();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("what a signal does to a store", () => {
  it("makes a tab that was not open read again when it is", async () => {
    // A colour picked in the calendar must be the colour in the watchlist,
    // and the watchlist may not have been open for an hour.
    const store = createTabStore<{ rows: number[] }>({ rows: [] });
    onWatchlistChanged((source) => {
      if (source === store) return;
      store.invalidate();
      void store.run();
    });
    store.setFetcher(async () => store.set({ rows: [1] }));
    await store.run();
    expect(store.isStale()).toBe(false);

    notifyWatchlistChanged({ someoneElse: true });
    expect(store.isStale()).toBe(true);
    store.reset();
  });

  it("keeps the rows on screen while it re-reads", async () => {
    const store = createTabStore<{ rows: number[] }>({ rows: [] });
    store.setFetcher(async () => store.set({ rows: [1, 2] }));
    await store.run();
    store.invalidate();
    // Invalidating is a statement about freshness, not a reason to blank a
    // table somebody is reading.
    expect(store.getState().data.rows).toEqual([1, 2]);
    store.reset();
  });
});
