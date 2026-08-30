/**
 * Change the passphrase on the wallet file, or seal/unseal it by hand.
 *
 *   npm run keys:rekey -- <config path>
 *
 * Passphrases come from the environment, never argv — argv is visible to
 * every process on the box via `ps`, and shells write it into history:
 *
 *   SNIPE_KEYSTORE_PASSPHRASE      what the file is sealed with now
 *                                  (omit if it is still plain)
 *   SNIPE_KEYSTORE_NEW_PASSPHRASE  what it should be sealed with
 *                                  (set empty to unseal — decrypt to plain)
 *
 * This exists because the first passphrase anyone sets is so often the wrong
 * one — a placeholder pasted verbatim, a word that turned out to be in a chat
 * log — and without a rekey tool the honest options are "live with it" or
 * hand-editing a file where a mistake destroys every wallet at once.
 *
 * Same discipline as the migration: the new bytes are proven to decrypt back
 * to the identical plaintext before the old file is touched, and the swap is
 * a rename. Interrupt it anywhere and you still hold a readable file.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, keysPath } from "./config";
import { isEncrypted, keystorePassphrase, seal, unseal } from "./keystore";

function fail(msg: string): never {
  console.error(`keys:rekey: ${msg}`);
  process.exit(1);
}

const configPath = process.argv[2];
if (!configPath) fail("usage: npm run keys:rekey -- <path/to/snipe.config.json>");

const cfg = loadConfig(configPath);
const abs = keysPath(configPath, cfg.keysFile);

const current = keystorePassphrase();
const newRaw = process.env.SNIPE_KEYSTORE_NEW_PASSPHRASE;
if (newRaw === undefined) {
  fail("set SNIPE_KEYSTORE_NEW_PASSPHRASE (empty string means unseal to plain text)");
}
const next = newRaw.trim() === "" ? null : newRaw;

let text: string;
try {
  text = readFileSync(abs, "utf8");
} catch {
  fail(`no key file at ${abs} — nothing to rekey`);
}

let plain: string;
if (isEncrypted(text)) {
  if (!current) fail("the file is sealed — set SNIPE_KEYSTORE_PASSPHRASE to the current passphrase");
  try {
    plain = unseal(text, current);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
} else {
  plain = text;
}

const out = next ? seal(plain, next) : plain;

// Prove the round trip before touching anything. There is no second copy of a
// private key; a rekey that only usually works is worse than none.
if (next) {
  const back = Buffer.from(unseal(out, next), "utf8");
  const orig = Buffer.from(plain, "utf8");
  if (back.length !== orig.length || !timingSafeEqual(back, orig)) {
    fail("refusing: the resealed file did not read back identically");
  }
}

const tmp = `${abs}.tmp`;
writeFileSync(tmp, out, { mode: 0o600 });
renameSync(tmp, abs);

const wallets = plain.split("\n").filter((l) => /^\s*0x[0-9a-fA-F]{64}/.test(l)).length;
console.log(
  next
    ? `sealed ${abs} under the new passphrase (${wallets} wallet(s)). ` +
        `Update SNIPE_KEYSTORE_PASSPHRASE in snipe.env to match, then restart.`
    : `unsealed ${abs} to plain text (${wallets} wallet(s)). ` +
        `Unset SNIPE_KEYSTORE_PASSPHRASE or the server will reseal it at startup.`,
);
