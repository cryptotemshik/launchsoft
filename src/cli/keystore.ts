/**
 * The private keys, encrypted on disk.
 *
 * Until now they sat in a text file in plain sight. That was defensible while
 * the only wallets on the box were yours and the only person with the box was
 * you. It stops being defensible the moment someone else's wallet is on it:
 * one `cat`, one stray backup, one EBS snapshot, one path-traversal bug in an
 * API that faces the internet through a tunnel, and every wallet is gone at
 * once.
 *
 * So the file is sealed with AES-256-GCM under a key derived from a passphrase
 * the process is started with. Be clear about what that buys and what it does
 * not: it defeats anything that reads the disk without also being the running
 * process — snapshots, backups, a leaked file, a bug that can read a path but
 * not the environment. It does not defeat root on a live box, because the
 * passphrase is in that process's environment and the decrypted keys are in
 * its memory. Nothing that can sign a transaction unattended ever could.
 *
 * Unattended is the whole constraint. A sniper has to come back by itself
 * after `pm2 restart` at three in the morning, so there is nobody to type a
 * passphrase — it comes from the environment or the file stays plain. Which is
 * why the passphrase is optional and its absence is a loud line in the log
 * rather than a refusal to start: a server that will not boot is a lost drop.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

/** Where the passphrase comes from. Unset means "keep the file in the clear". */
export const PASSPHRASE_ENV = "SNIPE_KEYSTORE_PASSPHRASE";

/**
 * scrypt, tuned to cost about a tenth of a second here.
 *
 * The point of a KDF is that a stolen file cannot be brute-forced faster than
 * the KDF allows. N is the whole of that cost, and it is stored in the file
 * rather than assumed, so raising it later still leaves old files readable.
 */
const KDF = { name: "scrypt" as const, N: 32_768, r: 8, p: 1, keyLen: 32 };

/**
 * scrypt at this N wants 128 · N · r bytes — about 33MB — and Node refuses at
 * 32MB by default. Without this it throws "memory limit exceeded" rather than
 * doing anything useful.
 */
const MAXMEM = 96 * 1024 * 1024;

/** The marker that tells a sealed file from a plain one, at a glance. */
const MAGIC = "launchpadKeystore";

interface Envelope {
  [MAGIC]: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

/**
 * Bring the passphrase into the environment before anything needs it.
 *
 * If it is already set (snipe.env, an inline var) that stands. Otherwise, when
 * SNIPE_KEYSTORE_SECRET_ID names a Secrets Manager secret, the passphrase is
 * fetched from AWS with the instance role and put in the environment in memory
 * — so the disk holds nothing that can open the keys. Anything else is left
 * as-is: no secret configured means the on-disk env is the source, exactly as
 * before.
 *
 * Called once at startup, before the key file is read.
 */
export async function resolveKeystorePassphrase(env = process.env): Promise<void> {
  if (keystorePassphrase(env)) return;
  const secretId = env.SNIPE_KEYSTORE_SECRET_ID?.trim();
  if (!secretId) return;
  const { fetchSecret } = await import("./awsSecret");
  env[PASSPHRASE_ENV] = await fetchSecret(secretId, env.SNIPE_AWS_REGION?.trim() || undefined);
}

export function keystorePassphrase(env = process.env): string | null {
  const raw = env[PASSPHRASE_ENV];
  // A blank passphrase is not a passphrase. Treating "" as one would encrypt
  // every key file on the planet under the same trivially-guessed secret.
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/** True when this text is a sealed keystore rather than keys in the clear. */
export function isEncrypted(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{")) return false;
  try {
    const v: unknown = JSON.parse(t);
    return Boolean(v && typeof v === "object" && MAGIC in (v as Record<string, unknown>));
  } catch {
    return false;
  }
}

function deriveKey(passphrase: string, salt: Buffer, kdf: Envelope["kdf"]): Buffer {
  return scryptSync(passphrase, salt, KDF.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: MAXMEM,
  });
}

export function seal(plaintext: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = { ...KDF, salt: salt.toString("hex") };
  const key = deriveKey(passphrase, salt, kdf);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const envelope: Envelope = {
    [MAGIC]: 1,
    kdf,
    cipher: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: c.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function unseal(text: string, passphrase: string): string {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(text) as Envelope;
  } catch {
    throw new Error("the key file is not a keystore and not readable as one");
  }
  if (!envelope[MAGIC]) throw new Error("the key file is not a keystore");
  const kdf = envelope.kdf;
  if (kdf?.name !== "scrypt") throw new Error(`unknown key derivation: ${String(kdf?.name)}`);
  const key = deriveKey(passphrase, Buffer.from(kdf.salt, "hex"), kdf);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
  d.setAuthTag(Buffer.from(envelope.tag, "hex"));
  try {
    return Buffer.concat([d.update(Buffer.from(envelope.data, "hex")), d.final()]).toString("utf8");
  } catch {
    // GCM refusing to authenticate means the passphrase is wrong or the file
    // was altered, and there is no way to tell which from here. Both are the
    // same instruction to the reader, and neither must ever lead to a write.
    throw new Error(
      `could not decrypt the key file — check ${PASSPHRASE_ENV}. Nothing was changed.`,
    );
  }
}

/**
 * The keys as text, whatever form the file is in.
 *
 * A sealed file with no passphrase is an error rather than an empty list: a
 * server that quietly reports "no wallets" after someone forgot an environment
 * variable would arm a run with nothing in it and lose the drop silently.
 */
export function readKeysText(abs: string, passphrase: string | null): string | null {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (!isEncrypted(text)) return text;
  if (!passphrase) {
    throw new Error(
      `the key file is encrypted but ${PASSPHRASE_ENV} is not set — the wallets cannot be read`,
    );
  }
  return unseal(text, passphrase);
}

/** Write via a temporary file and rename, so a crash mid-write loses nothing. */
export function writeKeysText(abs: string, plaintext: string, passphrase: string | null): void {
  const body = passphrase ? seal(plaintext, passphrase) : plaintext;
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, abs);
}

export type MigrationResult =
  | { state: "absent" }
  | { state: "already-encrypted" }
  | { state: "left-plain" }
  | { state: "migrated" };

/**
 * Seal a file that is still in the clear.
 *
 * Read back and compared before the original is replaced. Encrypting a key
 * file is the one operation where a silent failure is unrecoverable — there is
 * no second copy of a private key — so the new bytes have to be proven to
 * decrypt to exactly what went in before anything is overwritten.
 *
 * No plaintext backup is left behind, deliberately. A `.bak` next to a sealed
 * file would undo the entire point of sealing it.
 */
export function migrateToEncrypted(abs: string, passphrase: string | null): MigrationResult {
  if (!existsSync(abs)) return { state: "absent" };
  const text = readFileSync(abs, "utf8");
  if (isEncrypted(text)) return { state: "already-encrypted" };
  if (!passphrase) return { state: "left-plain" };

  const sealed = seal(text, passphrase);
  const roundTrip = unseal(sealed, passphrase);
  const a = Buffer.from(roundTrip, "utf8");
  const b = Buffer.from(text, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("refusing to encrypt the key file: it did not read back identically");
  }
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, sealed, { mode: 0o600 });
  renameSync(tmp, abs);
  return { state: "migrated" };
}
