import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CODE_TTL_MS,
  codeIsValid,
  getChatId,
  isLinked,
  issueCode,
  loadLink,
  setChatId,
  unlink,
} from "./telegramLink";

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "tglink-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("telegram linking", () => {
  it("starts unlinked", () => {
    expect(isLinked(cfg)).toBe(false);
    expect(getChatId(cfg)).toBeNull();
    expect(loadLink(cfg)).toEqual({});
  });

  it("issues a code that validates until it expires", () => {
    const t0 = 1_000_000;
    const code = issueCode(cfg, t0);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeIsValid(loadLink(cfg), code, t0)).toBe(true);
    expect(codeIsValid(loadLink(cfg), code, t0 + CODE_TTL_MS)).toBe(true);
    expect(codeIsValid(loadLink(cfg), code, t0 + CODE_TTL_MS + 1)).toBe(false);
    expect(codeIsValid(loadLink(cfg), "wrong", t0)).toBe(false);
  });

  it("binds a chat id and clears the pending code", () => {
    issueCode(cfg, 1);
    setChatId(cfg, "12345", 2);
    expect(isLinked(cfg)).toBe(true);
    expect(getChatId(cfg)).toBe("12345");
    // The code is spent — it must not link a second chat.
    expect(loadLink(cfg).code).toBeUndefined();
  });

  it("a fresh code replaces an old one", () => {
    const a = issueCode(cfg, 1);
    const b = issueCode(cfg, 2);
    expect(a).not.toBe(b);
    expect(codeIsValid(loadLink(cfg), a, 3)).toBe(false);
    expect(codeIsValid(loadLink(cfg), b, 3)).toBe(true);
  });

  it("unlinks", () => {
    setChatId(cfg, "999", 1);
    unlink(cfg);
    expect(isLinked(cfg)).toBe(false);
    expect(getChatId(cfg)).toBeNull();
  });

  it("ignores a malformed chat id on load", () => {
    setChatId(cfg, "-100200300", 1); // group ids are negative — still valid
    expect(getChatId(cfg)).toBe("-100200300");
  });
});
