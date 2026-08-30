import { describe, expect, it } from "vitest";
import { loadSqlite } from "./nodeSqlite";

describe("loadSqlite", () => {
  it("hands back the builtin, and the same one every time", () => {
    const a = loadSqlite();
    expect(typeof a.DatabaseSync).toBe("function");
    expect(loadSqlite()).toBe(a);
  });

  // The reason this is a function at all: importing the module must not
  // require anything, so a Node without node:sqlite fails where the caller
  // can catch it rather than while the server is still loading its modules.
  it("does nothing until it is called", async () => {
    const mod = await import("./nodeSqlite");
    expect(Object.keys(mod)).toEqual(["loadSqlite"]);
  });
});
