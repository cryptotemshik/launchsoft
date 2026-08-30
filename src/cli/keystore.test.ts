import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKeyEntries } from "./config";
import {
  isEncrypted,
  keystorePassphrase,
  migrateToEncrypted,
  PASSPHRASE_ENV,
  readKeysText,
  seal,
  unseal,
  writeKeysText,
} from "./keystore";

const KEYS = `# Private keys, one per line
0x${"11".repeat(32)}  # first
0x${"22".repeat(32)}  # second
`;

const fileIn = () => join(mkdtempSync(join(tmpdir(), "keystore-")), "keys.txt");
const PASS = "correct horse battery staple";

describe("sealing and opening", () => {
  it("gives back exactly what went in", () => {
    expect(unseal(seal(KEYS, PASS), PASS)).toBe(KEYS);
  });

  it("does not leave the keys anywhere in the sealed text", () => {
    const sealed = seal(KEYS, PASS);
    expect(sealed).not.toContain("11".repeat(32));
    expect(sealed).not.toContain("first");
  });

  it("seals the same text differently every time", () => {
    // A fresh salt and iv per write: two files with the same wallets must not
    // be recognisable as the same file.
    expect(seal(KEYS, PASS)).not.toBe(seal(KEYS, PASS));
  });

  it("refuses the wrong passphrase rather than returning rubbish", () => {
    expect(() => unseal(seal(KEYS, PASS), "wrong")).toThrow(/could not decrypt/);
  });

  it("refuses a file somebody edited", () => {
    // GCM authenticates as well as encrypts, so a flipped byte is caught
    // rather than decrypted into a key that is subtly not the one stored.
    const envelope = JSON.parse(seal(KEYS, PASS)) as { data: string };
    const bytes = Buffer.from(envelope.data, "hex");
    bytes[0] ^= 0xff;
    const tampered = JSON.stringify({ ...envelope, data: bytes.toString("hex") });
    expect(() => unseal(tampered, PASS)).toThrow(/could not decrypt/);
  });

  it("carries its own derivation settings, so today's files open tomorrow", () => {
    const envelope = JSON.parse(seal(KEYS, PASS)) as { kdf: { N: number; salt: string } };
    expect(envelope.kdf.N).toBeGreaterThanOrEqual(16_384);
    expect(envelope.kdf.salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("telling a sealed file from a plain one", () => {
  it("knows a sealed one", () => {
    expect(isEncrypted(seal(KEYS, PASS))).toBe(true);
  });

  it("knows keys in the clear", () => {
    expect(isEncrypted(KEYS)).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("{ not json")).toBe(false);
  });

  it("does not mistake some other JSON for one", () => {
    expect(isEncrypted('{"hello":"world"}')).toBe(false);
  });
});

describe("the passphrase", () => {
  it("comes from the environment", () => {
    expect(keystorePassphrase({ [PASSPHRASE_ENV]: "hunter2" })).toBe("hunter2");
  });

  it("counts blank as not set", () => {
    // Otherwise every unset deployment encrypts under the same empty secret,
    // which is worse than not encrypting at all — it looks safe.
    expect(keystorePassphrase({ [PASSPHRASE_ENV]: "" })).toBeNull();
    expect(keystorePassphrase({ [PASSPHRASE_ENV]: "   " })).toBeNull();
    expect(keystorePassphrase({})).toBeNull();
  });
});

describe("reading and writing the file", () => {
  it("round-trips through a sealed file", () => {
    const f = fileIn();
    writeKeysText(f, KEYS, PASS);
    expect(isEncrypted(readFileSync(f, "utf8"))).toBe(true);
    expect(readKeysText(f, PASS)).toBe(KEYS);
  });

  it("round-trips without a passphrase, exactly as before", () => {
    const f = fileIn();
    writeKeysText(f, KEYS, null);
    expect(readFileSync(f, "utf8")).toBe(KEYS);
    expect(readKeysText(f, null)).toBe(KEYS);
  });

  it("reads a plain file even when a passphrase is set", () => {
    // The order of a migration is not guaranteed, and a server that could not
    // read its own keys until it had rewritten them would be a bad trade.
    const f = fileIn();
    writeFileSync(f, KEYS);
    expect(readKeysText(f, PASS)).toBe(KEYS);
  });

  it("says so loudly when the file is sealed and the passphrase is missing", () => {
    // Never an empty list: a run armed with no wallets loses the drop in
    // silence, which is the worst outcome available.
    const f = fileIn();
    writeKeysText(f, KEYS, PASS);
    expect(() => readKeysText(f, null)).toThrow(/encrypted but/);
  });

  it("treats a missing file as no wallets yet", () => {
    expect(readKeysText(join(tmpdir(), "definitely-not-here-9182"), null)).toBeNull();
  });

  it("writes at 0600, readable only by the user running the server", () => {
    const f = fileIn();
    writeKeysText(f, KEYS, PASS);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("migrating a file that is still in the clear", () => {
  it("seals it and reads back the same keys", () => {
    const f = fileIn();
    writeFileSync(f, KEYS);
    expect(migrateToEncrypted(f, PASS)).toEqual({ state: "migrated" });
    expect(isEncrypted(readFileSync(f, "utf8"))).toBe(true);
    expect(readKeysText(f, PASS)).toBe(KEYS);
  });

  it("leaves no plaintext copy behind", () => {
    // A .bak next to a sealed file would undo the whole point of sealing it.
    const f = fileIn();
    writeFileSync(f, KEYS);
    migrateToEncrypted(f, PASS);
    for (const suffix of [".bak", ".plain", ".orig", ".tmp"]) {
      expect(existsSync(`${f}${suffix}`)).toBe(false);
    }
  });

  it("does nothing to a file that is already sealed", () => {
    const f = fileIn();
    writeKeysText(f, KEYS, PASS);
    const before = readFileSync(f, "utf8");
    expect(migrateToEncrypted(f, PASS)).toEqual({ state: "already-encrypted" });
    expect(readFileSync(f, "utf8")).toBe(before);
  });

  it("leaves the file alone when there is no passphrase", () => {
    const f = fileIn();
    writeFileSync(f, KEYS);
    expect(migrateToEncrypted(f, null)).toEqual({ state: "left-plain" });
    expect(readFileSync(f, "utf8")).toBe(KEYS);
  });

  it("says nothing to do when there is no file", () => {
    expect(migrateToEncrypted(join(tmpdir(), "nope-4471"), PASS)).toEqual({ state: "absent" });
  });
});

describe("the seam the rest of the server uses", () => {
  /** A config beside a keys file, the way the runner lays them out. */
  function project(keysText: string): string {
    const dir = mkdtempSync(join(tmpdir(), "keyseam-"));
    const cfg = join(dir, "snipe.config.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        chainId: 4663,
        collection: `0x${"ab".repeat(20)}`,
        keysFile: "keys.txt",
      }),
    );
    writeFileSync(join(dir, "keys.txt"), keysText);
    return cfg;
  }

  it("reads a sealed file through loadKeyEntries, labels and all", () => {
    // The unit tests above prove the crypto; this proves the wiring, which is
    // the part that silently returns an empty wallet list when it is wrong.
    const cfg = project("");
    const keys = join(cfg, "..", "keys.txt");
    writeKeysText(keys, KEYS, PASS);
    process.env[PASSPHRASE_ENV] = PASS;
    try {
      const entries = loadKeyEntries(cfg, "keys.txt");
      expect(entries.map((e) => e.label)).toEqual(["first", "second"]);
      expect(entries[0].key).toBe(`0x${"11".repeat(32)}`);
    } finally {
      delete process.env[PASSPHRASE_ENV];
    }
  });

  it("still reads a plain file when nothing is set", () => {
    const cfg = project(KEYS);
    expect(loadKeyEntries(cfg, "keys.txt")).toHaveLength(2);
  });

  it("throws rather than reporting no wallets when the passphrase is missing", () => {
    const cfg = project("");
    writeKeysText(join(cfg, "..", "keys.txt"), KEYS, PASS);
    expect(() => loadKeyEntries(cfg, "keys.txt")).toThrow(/encrypted but/);
  });
});
