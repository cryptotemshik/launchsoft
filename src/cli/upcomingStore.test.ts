import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addUpcoming, loadUpcoming, removeUpcoming, saveUpcoming } from "./upcomingStore";
import type { UpcomingMint } from "../lib/upcoming";

const configIn = () => join(mkdtempSync(join(tmpdir(), "upcoming-")), "snipe.config.json");

const mint = (over: Partial<UpcomingMint> = {}): UpcomingMint => ({
  id: "aaaa1111",
  name: "Test Drop",
  twitter: "https://x.com/testdrop",
  addedAt: 1,
  ...over,
});

describe("upcoming store", () => {
  it("is empty before anything has been added", () => {
    expect(loadUpcoming(configIn())).toEqual([]);
  });

  it("keeps what it wrote, across separate loads", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    addUpcoming(cfg, mint({ id: "bbbb2222", name: "Second", at: 999 }));
    expect(loadUpcoming(cfg).map((m) => m.name)).toEqual(["Test Drop", "Second"]);
    expect(loadUpcoming(cfg)[1].at).toBe(999);
  });

  it("replaces an entry rather than storing the id twice", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint({ supply: 100 }));
    addUpcoming(cfg, mint({ supply: 500 }));
    const list = loadUpcoming(cfg);
    expect(list).toHaveLength(1);
    expect(list[0].supply).toBe(500);
  });

  it("removes by id and says what it removed", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    addUpcoming(cfg, mint({ id: "bbbb2222", name: "Second" }));
    const { removed, list } = removeUpcoming(cfg, "aaaa1111");
    expect(removed?.name).toBe("Test Drop");
    expect(list.map((m) => m.id)).toEqual(["bbbb2222"]);
    expect(loadUpcoming(cfg)).toHaveLength(1);
  });

  it("reports an unknown id without touching the list", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    const { removed, list } = removeUpcoming(cfg, "nope");
    expect(removed).toBeUndefined();
    expect(list).toHaveLength(1);
  });

  it("treats an unreadable file as empty instead of throwing", () => {
    // A hand-edited file that no longer parses should not take the API route
    // down with it — the next save fixes it.
    const cfg = configIn();
    saveUpcoming(cfg, [mint()]);
    writeFileSync(`${cfg}.upcoming.json`, "{ this is not json");
    expect(loadUpcoming(cfg)).toEqual([]);
  });

  it("drops entries missing the fields everything downstream reads", () => {
    const cfg = configIn();
    writeFileSync(
      `${cfg}.upcoming.json`,
      JSON.stringify([mint(), { id: "x" }, null, { name: "no id" }]),
    );
    expect(loadUpcoming(cfg).map((m) => m.id)).toEqual(["aaaa1111"]);
  });

  it("writes a file a person can read and edit", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    const text = readFileSync(`${cfg}.upcoming.json`, "utf8");
    expect(text).toContain('"name": "Test Drop"');
    expect(text.endsWith("\n")).toBe(true);
  });
});
