import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addressBookPath, loadAddressBook, writeAddressBook } from "./addressBook";

const configIn = () => join(mkdtempSync(join(tmpdir(), "book-")), "snipe.config.json");
const A = `0x${"ab".repeat(20)}` as `0x${string}`;
const B = `0x${"cd".repeat(20)}` as `0x${string}`;

describe("the public address book", () => {
  it("round-trips addresses and labels", () => {
    const cfg = configIn();
    writeAddressBook(cfg, "snipe.keys", [
      { address: A, label: "one" },
      { address: B },
    ]);
    expect(loadAddressBook(cfg, "snipe.keys")).toEqual([{ address: A, label: "one" }, { address: B }]);
  });

  it("returns null when there is no book, so the caller can derive it", () => {
    expect(loadAddressBook(configIn(), "snipe.keys")).toBeNull();
  });

  it("holds no secret — just addresses and nicknames", () => {
    // The whole reason it can be read by a process with no passphrase.
    const cfg = configIn();
    writeAddressBook(cfg, "snipe.keys", [{ address: A, label: "cold" }]);
    const raw = readFileSync(addressBookPath(cfg, "snipe.keys"), "utf8");
    expect(raw).toContain(A);
    expect(raw).not.toMatch(/[0-9a-fA-F]{64}/); // no private key shaped value
  });

  it("ignores junk rather than trusting a hand-edited file", () => {
    const cfg = configIn();
    writeFileSync(addressBookPath(cfg, "snipe.keys"), JSON.stringify([
      { address: A, label: "ok" },
      { address: "not-an-address" },
      { nonsense: true },
      "a string",
    ]));
    expect(loadAddressBook(cfg, "snipe.keys")).toEqual([{ address: A, label: "ok" }]);
  });

  it("survives a file that is not JSON at all", () => {
    const cfg = configIn();
    writeFileSync(addressBookPath(cfg, "snipe.keys"), "{ broken");
    expect(loadAddressBook(cfg, "snipe.keys")).toBeNull();
  });
});
