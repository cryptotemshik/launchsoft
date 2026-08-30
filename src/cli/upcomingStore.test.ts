import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addUpcoming,
  loadUpcoming,
  annotateUpcoming,
  removeUpcoming,
  saveUpcoming,
} from "./upcomingStore";
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
    addUpcoming(cfg, mint({ id: "bbbb2222", name: "Second", at: 999, twitter: "https://x.com/second" }));
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

  it("refuses the same collection twice, and says which entry already has it", () => {
    // Pressing "watch" on a scanner row twice used to make two entries: the id
    // is minted from the name and the clock, so it was different every time.
    const cfg = configIn();
    const contract = "0xc60079d77bbfb225632999564673f4e334f8d9dd";
    addUpcoming(cfg, mint({ id: "aaaa1111", contract }));
    const second = addUpcoming(cfg, mint({ id: "cccc3333", name: "Same drop, typed again", contract }));
    expect(second.duplicate?.id).toBe("aaaa1111");
    expect(second.list).toHaveLength(1);
    expect(loadUpcoming(cfg)).toHaveLength(1);
  });

  it("matches a contract whatever its case", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint({ id: "aaaa1111", contract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }));
    const again = addUpcoming(
      cfg,
      mint({ id: "cccc3333", contract: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD" }),
    );
    expect(again.duplicate).toBeDefined();
  });

  it("falls back to the handle when there is no contract yet", () => {
    // Half of what lands here is an account with no contract deployed.
    const cfg = configIn();
    addUpcoming(cfg, mint({ id: "aaaa1111" }));
    const again = addUpcoming(cfg, mint({ id: "cccc3333", name: "Typed again" }));
    expect(again.duplicate?.id).toBe("aaaa1111");
  });

  it("does not fold two different drops together on name alone", () => {
    // "Genesis" is half the chain. Losing a real drop to a name collision is
    // worse than listing one twice.
    const cfg = configIn();
    addUpcoming(cfg, mint({ id: "aaaa1111", name: "Genesis", twitter: "https://x.com/one" }));
    const other = addUpcoming(cfg, mint({ id: "cccc3333", name: "Genesis", twitter: "https://x.com/two" }));
    expect(other.duplicate).toBeUndefined();
    expect(loadUpcoming(cfg)).toHaveLength(2);
  });

  it("still treats the same id as an update rather than a duplicate", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint({ supply: 100 }));
    const again = addUpcoming(cfg, mint({ supply: 500 }));
    expect(again.duplicate).toBeUndefined();
    expect(loadUpcoming(cfg)[0].supply).toBe(500);
  });

  it("removes by id and says what it removed", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    addUpcoming(cfg, mint({ id: "bbbb2222", name: "Second", twitter: "https://x.com/second" }));
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

describe("painting an entry", () => {
  it("stores the colour someone picked", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    annotateUpcoming(cfg, "aaaa1111", { color: "cyan" });
    expect(loadUpcoming(cfg)[0].color).toBe("cyan");
  });

  it("treats auto as no choice, so the field goes away", () => {
    // An entry set back to automatic has to be indistinguishable from one
    // never coloured, or the price-derived default would never come back.
    const cfg = configIn();
    addUpcoming(cfg, mint({ color: "red" }));
    annotateUpcoming(cfg, "aaaa1111", { color: "auto" });
    expect(loadUpcoming(cfg)[0]).not.toHaveProperty("color");
  });

  it("leaves everything else on the entry alone", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint({ at: 4242, supply: 500, dayOnly: true }));
    annotateUpcoming(cfg, "aaaa1111", { color: "violet" });
    const [m] = loadUpcoming(cfg);
    expect({ at: m.at, supply: m.supply, dayOnly: m.dayOnly, name: m.name }).toEqual({
      at: 4242,
      supply: 500,
      dayOnly: true,
      name: "Test Drop",
    });
  });

  it("touches nothing when the id is unknown", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint({ color: "grey" }));
    const { updated, list } = annotateUpcoming(cfg, "nope", { color: "red" });
    expect(updated).toBeUndefined();
    expect(list[0].color).toBe("grey");
  });

  it("does not disturb the other entries", () => {
    const cfg = configIn();
    addUpcoming(cfg, mint());
    addUpcoming(cfg, mint({ id: "bbbb2222", name: "Second", twitter: "https://x.com/second" }));
    annotateUpcoming(cfg, "bbbb2222", { color: "amber" });
    const list = loadUpcoming(cfg);
    expect(list.map((m) => [m.name, m.color])).toEqual([
      ["Test Drop", undefined],
      ["Second", "amber"],
    ]);
  });
});

/** A config with one entry, ready to be annotated. */
function seed(): string {
  const cfg = configIn();
  addUpcoming(cfg, mint({ supply: 1000, at: 1234 }));
  return cfg;
}

describe("notes on a watched drop", () => {
  it("keeps what was written", () => {
    const cfg = seed();
    annotateUpcoming(cfg, "aaaa1111", { note: "allow-listed, 2 wallets" });
    expect(loadUpcoming(cfg).find((m) => m.id === "aaaa1111")?.note).toBe(
      "allow-listed, 2 wallets",
    );
  });

  it("clears the field rather than storing an empty one", () => {
    const cfg = seed();
    annotateUpcoming(cfg, "aaaa1111", { note: "something" });
    annotateUpcoming(cfg, "aaaa1111", { note: undefined });
    expect("note" in (loadUpcoming(cfg).find((m) => m.id === "aaaa1111") ?? {})).toBe(false);
  });

  it("leaves the colour alone, and the colour leaves it alone", () => {
    // The picker and the note box write independently; either clearing the
    // other would make the second edit look like it undid the first.
    const cfg = seed();
    annotateUpcoming(cfg, "aaaa1111", { color: "cyan" });
    annotateUpcoming(cfg, "aaaa1111", { note: "watch the founder" });
    const after = loadUpcoming(cfg).find((m) => m.id === "aaaa1111");
    expect(after?.color).toBe("cyan");
    expect(after?.note).toBe("watch the founder");
    annotateUpcoming(cfg, "aaaa1111", { color: "auto" });
    expect(loadUpcoming(cfg).find((m) => m.id === "aaaa1111")?.note).toBe("watch the founder");
  });

  it("touches nothing when the patch is empty", () => {
    const cfg = seed();
    annotateUpcoming(cfg, "aaaa1111", { color: "red", note: "keep me" });
    annotateUpcoming(cfg, "aaaa1111", {});
    const after = loadUpcoming(cfg).find((m) => m.id === "aaaa1111");
    expect(after?.color).toBe("red");
    expect(after?.note).toBe("keep me");
  });

  it("leaves the rest of the entry as it was", () => {
    const cfg = seed();
    const before = loadUpcoming(cfg).find((m) => m.id === "aaaa1111");
    annotateUpcoming(cfg, "aaaa1111", { note: "n" });
    const after = loadUpcoming(cfg).find((m) => m.id === "aaaa1111");
    expect({ ...after, note: undefined }).toEqual({ ...before, note: undefined });
  });
});
