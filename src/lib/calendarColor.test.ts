import { describe, expect, it } from "vitest";
import { colorClass, isPickable, priceClass, resolveColor } from "./calendarColor";

describe("telling a free mint from a paid one by its price", () => {
  it("calls zero free", () => {
    expect(priceClass("0")).toBe("free");
  });

  it("calls anything above zero paid", () => {
    expect(priceClass("200000000000000")).toBe("paid");
    expect(priceClass("1")).toBe("paid");
  });

  it("does not call a missing price free", () => {
    // No price means the stage isn't configured yet. Painting it like a free
    // mint would promise something the chain has not said.
    expect(priceClass(undefined)).toBe("unknown");
    expect(priceClass(null)).toBe("unknown");
    expect(priceClass("")).toBe("unknown");
  });

  it("does not throw on a value that isn't a number", () => {
    expect(priceClass("soon")).toBe("unknown");
  });
});

describe("choosing the colour of a row", () => {
  it("uses the price when nobody picked anything", () => {
    expect(resolveColor({ priceWei: "0" })).toBe("free");
    expect(resolveColor({ priceWei: "5" })).toBe("paid");
    expect(resolveColor({})).toBe("unknown");
  });

  it("lets a picked colour win over the price", () => {
    expect(resolveColor({ priceWei: "0", color: "red" })).toBe("red");
  });

  it("treats an explicit auto as no choice at all", () => {
    expect(resolveColor({ priceWei: "0", color: "auto" })).toBe("free");
  });

  it("ignores a colour that isn't in the palette", () => {
    // The watchlist is a JSON file a person can hand-edit, and this value ends
    // up in a class name. Anything unrecognised falls back to the price.
    expect(resolveColor({ priceWei: "0", color: "#ff0000" })).toBe("free");
    expect(resolveColor({ priceWei: "0", color: "url(javascript:x)" })).toBe("free");
    expect(resolveColor({ priceWei: "5", color: "" })).toBe("paid");
  });

  it("builds a class name that cannot carry anything but a palette key", () => {
    expect(colorClass({ priceWei: "0" })).toBe("cal-c-free");
    expect(colorClass({ priceWei: "5", color: "cyan" })).toBe("cal-c-cyan");
    expect(colorClass({ color: "'; drop table --" })).toBe("cal-c-unknown");
  });
});

describe("validating what may be stored", () => {
  it("accepts every palette key and auto", () => {
    for (const c of ["auto", "green", "amber", "cyan", "violet", "red", "grey"]) {
      expect(isPickable(c)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    expect(isPickable("free")).toBe(false);
    expect(isPickable("#abcdef")).toBe(false);
    expect(isPickable(7)).toBe(false);
    expect(isPickable(undefined)).toBe(false);
  });
});
