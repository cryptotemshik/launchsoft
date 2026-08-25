import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCustomRpcText, parseCustomRpcs } from "./customRpc";

// The suite runs in node, where there is no localStorage. The store's whole
// job is what it does with that API, so give it the smallest real one.
beforeAll(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
});

describe("parseCustomRpcs", () => {
  it("takes one URL per line and keeps the given order", () => {
    expect(parseCustomRpcs("https://a.example\nhttps://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("ignores blank lines and stray whitespace", () => {
    expect(parseCustomRpcs("  https://a.example  \n\n\t\nhttps://b.example\n")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("returns nothing for an empty box", () => {
    expect(parseCustomRpcs("")).toEqual([]);
    expect(parseCustomRpcs("   \n  ")).toEqual([]);
  });
});

describe("loadCustomRpcText", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is empty when nothing has been stored", () => {
    expect(loadCustomRpcText()).toBe("");
  });

  it("reads what was stored", () => {
    localStorage.setItem("launchpad.rpcs", "https://a.example");
    expect(loadCustomRpcText()).toBe("https://a.example");
  });

  it("migrates the endpoint from the snipe-only key it used to live under", () => {
    localStorage.setItem("launchpad.snipe.rpcs", "https://alchemy.example/v2/key");
    expect(loadCustomRpcText()).toBe("https://alchemy.example/v2/key");
    // Moved, not copied — so a later edit can't be shadowed by the old value.
    expect(localStorage.getItem("launchpad.rpcs")).toBe("https://alchemy.example/v2/key");
    expect(localStorage.getItem("launchpad.snipe.rpcs")).toBeNull();
  });

  it("prefers the shared key over a leftover legacy one", () => {
    localStorage.setItem("launchpad.rpcs", "https://new.example");
    localStorage.setItem("launchpad.snipe.rpcs", "https://old.example");
    expect(loadCustomRpcText()).toBe("https://new.example");
  });

  it("treats a deliberately emptied box as empty, not as missing", () => {
    localStorage.setItem("launchpad.rpcs", "");
    localStorage.setItem("launchpad.snipe.rpcs", "https://old.example");
    expect(loadCustomRpcText()).toBe("");
  });
});
