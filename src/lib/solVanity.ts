/**
 * Solana wallets, optionally with a chosen start and/or end of the address.
 *
 * A Solana address is the base58 of an Ed25519 public key, and the key a
 * wallet imports (Phantom, Solflare, `solana-keygen`) is the base58 of the
 * 64-byte secret: the 32-byte seed followed by the public key. Nothing here
 * talks to a server — the keys exist in the page and in the file you save.
 *
 * Unlike the EVM search there is no cheap walk from one key to the next: the
 * signing scalar is a hash of the seed, and wallets import the seed, so every
 * candidate is a fresh key. What makes it bearable is the platform's own
 * Ed25519 (WebCrypto), several times faster than any JS implementation; the
 * noble implementation is the fallback for browsers without it.
 *
 * Base58 has 58 symbols and is case-sensitive, so every character asked for
 * is ~58× more work (fewer with "ignore case", where a letter matches both).
 */
import { ed25519 } from "@noble/curves/ed25519";

export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Characters at each end together, at most — six would take days. */
export const MAX_SOL_PATTERN = 5;

/**
 * Validate a pattern. With `ignoreCase`, a letter is fine if either case of
 * it exists in base58 ("l" is not, but "L" is).
 */
export function normalizeSolPattern(raw: string, ignoreCase: boolean): string {
  const t = raw.trim();
  for (const ch of t) {
    const ok = ignoreCase
      ? B58.includes(ch.toUpperCase()) || B58.includes(ch.toLowerCase())
      : B58.includes(ch);
    if (!ok) {
      throw new Error(
        `"${ch}" never appears in a Solana address — base58 has no 0, O, I or l`,
      );
    }
  }
  return ignoreCase ? t.toLowerCase() : t;
}

/** Average keys to try for one match. */
export function expectedSolTries(prefix: string, suffix: string, ignoreCase: boolean): number {
  let n = 1;
  for (const ch of prefix + suffix) {
    const variants = ignoreCase
      ? new Set([ch.toUpperCase(), ch.toLowerCase()].filter((c) => B58.includes(c))).size
      : 1;
    n *= 58 / variants;
  }
  return n;
}

export function matches(address: string, prefix: string, suffix: string, ignoreCase: boolean): boolean {
  const a = ignoreCase ? address.toLowerCase() : address;
  return a.startsWith(prefix) && a.endsWith(suffix);
}

export interface SolWallet {
  address: string;
  /** base58 of seed ‖ public key — what Phantom and Solflare import. */
  secret: string;
}

export function walletFromSeed(seed: Uint8Array, pub = ed25519.getPublicKey(seed)): SolWallet {
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { address: base58(pub), secret: base58(full) };
}

/** PKCS#8 for Ed25519 is a fixed 16-byte header and then the 32-byte seed. */
const PKCS8_SEED_OFFSET = 16;

let native: boolean | null = null;
async function hasNativeEd25519(): Promise<boolean> {
  if (native !== null) return native;
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
    native = true;
  } catch {
    native = false;
  }
  return native;
}

/** `count` fresh keypairs as {seed, pub}, the fastest way this platform has. */
export async function freshKeys(count: number): Promise<{ seed: Uint8Array; pub: Uint8Array }[]> {
  if (await hasNativeEd25519()) {
    return Promise.all(
      Array.from({ length: count }, async () => {
        const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])) as CryptoKeyPair;
        const [raw, pkcs8] = await Promise.all([
          crypto.subtle.exportKey("raw", k.publicKey),
          crypto.subtle.exportKey("pkcs8", k.privateKey),
        ]);
        return {
          seed: new Uint8Array(pkcs8).slice(PKCS8_SEED_OFFSET, PKCS8_SEED_OFFSET + 32),
          pub: new Uint8Array(raw),
        };
      }),
    );
  }
  return Array.from({ length: count }, () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    return { seed, pub: ed25519.getPublicKey(seed) };
  });
}

/**
 * Check a found wallet from scratch: the public key re-derived from the seed
 * must be the address. A key that fails this would import as a different
 * wallet than the one shown.
 */
export function verifySolWallet(w: SolWallet): boolean {
  const digits = w.secret;
  // Decode base58 back to bytes.
  let bytes: number[] = [];
  for (const ch of digits) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < digits.length && digits[i] === "1"; i++) bytes.push(0);
  bytes = bytes.reverse();
  while (bytes.length < 64) bytes.unshift(0);
  if (bytes.length !== 64) return false;
  const seed = Uint8Array.from(bytes.slice(0, 32));
  return base58(ed25519.getPublicKey(seed)) === w.address;
}
