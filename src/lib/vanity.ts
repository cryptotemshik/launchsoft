/**
 * Wallet generation, optionally with a chosen start and/or end of the address.
 *
 * Plain random wallets are one fresh key each. A pattern ("0xabc…", "…f00")
 * has no shortcut: keys are tried until an address happens to match, 16× more
 * tries for every hex character asked for. So the search is built for speed:
 * instead of deriving every candidate from scratch (a full scalar
 * multiplication each), it walks k, k+1, k+2, … — the next public key is the
 * previous plus G, one point addition — and turns a batch of those into
 * addresses with a single field inversion. That is roughly 12× faster than
 * the naive loop.
 *
 * Walking consecutive keys is safe only while nothing found is related to
 * anything else found. So after every match the walk restarts from a fresh
 * random key: two wallets from one run never sit a small step apart, where
 * knowing one would give away the other.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

/** Hex characters that can be asked for at each end together, at most. */
export const MAX_PATTERN_CHARS = 8;

/** Lower-case hex without "0x", or throws on anything that is not hex. */
export function normalizePattern(raw: string): string {
  const t = raw.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(t)) throw new Error(`"${raw.trim()}" — only 0-9 and a-f can appear in an address`);
  return t;
}

/** Average number of keys to try for one match. */
export function expectedTries(prefix: string, suffix: string): number {
  return 16 ** (prefix.length + suffix.length);
}

/** A uniformly random scalar in [1, n-1], from the platform CSPRNG. */
export function randomScalar(): bigint {
  for (;;) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    const k = BigInt(`0x${bytesToHex(b)}`);
    if (k > 0n && k < N) return k;
  }
}

export function keyHex(k: bigint): `0x${string}` {
  return `0x${k.toString(16).padStart(64, "0")}`;
}

/** Lower-case address (no checksum) of a public point. */
function addressOf(affine: { toRawBytes(compressed?: boolean): Uint8Array }): string {
  return bytesToHex(keccak_256(affine.toRawBytes(false).subarray(1)).subarray(12));
}

export interface Walk {
  /** The key the next candidate will have. */
  k: bigint;
  /** Its public point, k·G. */
  P: InstanceType<typeof Point>;
}

export function startWalk(k = randomScalar()): Walk {
  return { k, P: Point.BASE.multiply(k) };
}

/**
 * Try `batch` consecutive keys from the walk. Returns the first match, if
 * any, and advances the walk past everything tried.
 */
export function stepWalk(
  walk: Walk,
  prefix: string,
  suffix: string,
  batch = 512,
): { tried: number; found?: { key: `0x${string}`; address: string } } {
  // A batch that would reach the group order would hit the point at
  // infinity. Astronomically unlikely from a random start; restart anyway.
  if (walk.k + BigInt(batch) >= N) Object.assign(walk, startWalk());
  const pts = new Array<InstanceType<typeof Point>>(batch);
  let P = walk.P;
  for (let i = 0; i < batch; i++) {
    pts[i] = P;
    P = P.add(Point.BASE);
  }
  const affine = Point.normalizeZ(pts);
  for (let i = 0; i < batch; i++) {
    const a = addressOf(affine[i]);
    if (a.startsWith(prefix) && a.endsWith(suffix)) {
      const k = walk.k + BigInt(i);
      // Past the match; the caller restarts from a fresh random key anyway.
      walk.k = k + 1n;
      walk.P = Point.BASE.multiply(walk.k);
      return { tried: i + 1, found: { key: keyHex(k), address: `0x${a}` } };
    }
  }
  walk.k += BigInt(batch);
  walk.P = P;
  return { tried: batch };
}

/** One fresh random wallet, no pattern. */
export function randomWallet(): { key: `0x${string}`; address: string } {
  const k = randomScalar();
  return { key: keyHex(k), address: `0x${addressOf(Point.BASE.multiply(k))}` };
}
