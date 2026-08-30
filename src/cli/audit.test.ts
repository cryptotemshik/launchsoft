import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { audit, auditPath, MAX_BYTES, scrub, type AuditLine } from "./audit";

const configIn = () => join(mkdtempSync(join(tmpdir(), "audit-")), "snipe.config.json");
const lines = (cfg: string): AuditLine[] =>
  readFileSync(auditPath(cfg), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AuditLine);

describe("recording a line", () => {
  it("writes the event and what came with it", () => {
    const cfg = configIn();
    audit(cfg, "wallets.added", { count: 3 });
    expect(lines(cfg)).toHaveLength(1);
    expect(lines(cfg)[0].event).toBe("wallets.added");
    expect(lines(cfg)[0].count).toBe(3);
  });

  it("stamps every line in UTC", () => {
    // Local time in an audit trail is an argument waiting to happen.
    const cfg = configIn();
    audit(cfg, "run.armed", {});
    expect(lines(cfg)[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("appends rather than replacing", () => {
    const cfg = configIn();
    audit(cfg, "wallets.added", { count: 1 });
    audit(cfg, "wallets.removed", { count: 1 });
    expect(lines(cfg).map((l) => l.event)).toEqual(["wallets.added", "wallets.removed"]);
  });

  it("keeps one object per line, so the file can be read a line at a time", () => {
    const cfg = configIn();
    audit(cfg, "funds.collected", { to: "0xabc" });
    audit(cfg, "funds.dispersed", { to: 4 });
    expect(readFileSync(auditPath(cfg), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("what never reaches the file", () => {
  it("drops anything named like a secret", () => {
    expect(scrub({ key: "a", privateKey: "b", passphrase: "c", token: "d", count: 2 })).toEqual({
      count: 2,
    });
  });

  it("drops a 64-hex value whatever it is called", () => {
    // A private key written into an append-only file cannot be unwritten, so
    // the shape is refused as well as the name.
    const secret = `0x${"ab".repeat(32)}`;
    expect(scrub({ note: secret, wallet: "0x1234", n: 1 })).toEqual({ wallet: "0x1234", n: 1 });
  });

  it("keeps addresses, which are the point of the record", () => {
    const addr = `0x${"cd".repeat(20)}`;
    expect(scrub({ to: addr })).toEqual({ to: addr });
  });

  it("scrubs on the way in, not just in tests", () => {
    const cfg = configIn();
    audit(cfg, "funds.collected", { to: "0x1111", fromKey: `0x${"ff".repeat(32)}` });
    const text = readFileSync(auditPath(cfg), "utf8");
    expect(text).not.toContain("ff".repeat(32));
    expect(text).toContain("0x1111");
  });
});

describe("keeping the file from filling the disk", () => {
  it("sets the previous one aside once it is large", () => {
    const cfg = configIn();
    writeFileSync(auditPath(cfg), "x".repeat(MAX_BYTES));
    audit(cfg, "keys.state", { sealed: true });
    expect(existsSync(`${auditPath(cfg)}.1`)).toBe(true);
    // The new file holds only the new line, not the old bulk.
    expect(lines(cfg)).toHaveLength(1);
  });

  it("leaves a small file alone", () => {
    const cfg = configIn();
    audit(cfg, "keys.state", { sealed: true });
    audit(cfg, "keys.state", { sealed: true });
    expect(existsSync(`${auditPath(cfg)}.1`)).toBe(false);
    expect(lines(cfg)).toHaveLength(2);
  });
});

describe("when the file cannot be written", () => {
  it("reports it and does not throw", () => {
    // Losing a drop to protect the paperwork is the wrong trade: a failed
    // audit write must never propagate into the mint path.
    const onError = vi.fn();
    const unwritable = join(tmpdir(), "no-such-dir-8813", "snipe.config.json");
    expect(() => audit(unwritable, "run.armed", {}, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("could not record run.armed"));
  });
});
