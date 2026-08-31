/**
 * Who is talking to the server, proven by their wallet.
 *
 * The account model is deliberately keyless as an identity: you are your
 * address, and you prove it by signing a one-time challenge. There is no
 * password to store, nothing to leak, nothing to reset — and it dovetails with
 * everything else here, because the address you sign in with is the same one
 * withdrawals are allowed to go to instantly (a session thief provably does
 * not hold that key).
 *
 * Two short-lived things live here. A *challenge* is a nonce the server hands
 * out and will accept a signature over exactly once, within a few minutes — so
 * a signature captured off the wire cannot be replayed, and a signature for
 * one login cannot be reused for another. A *session* is what a successful
 * login returns: a bearer token good for a week, which every later request
 * carries instead of signing again.
 *
 * Pure logic and an in-memory store, so it is testable without a socket; the
 * server persists the store so a restart does not sign everyone out.
 */
import { recoverMessageAddress } from "viem";
import { randomBytes } from "node:crypto";

export const NONCE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  address: `0x${string}`;
  issuedAt: number;
  expiresAt: number;
}

interface Nonce {
  address: string;
  expiresAt: number;
}

const nonces = new Map<string, Nonce>();
const sessions = new Map<string, Session>();

/** The admin addresses, lower-case, from the environment. */
function adminAddresses(env = process.env): Set<string> {
  return new Set(
    (env.SNIPE_ADMIN_ADDRESS ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
  );
}

export function isAdmin(address: string, env = process.env): boolean {
  return adminAddresses(env).has(address.toLowerCase());
}

/**
 * The message a wallet signs to log in.
 *
 * Human-readable on purpose: a wallet shows the signer the raw text, and a
 * login prompt that reads like a login is the difference between a user who
 * signs with confidence and one who has learned to click through anything.
 * The address and nonce are inside the text, so the signature commits to both.
 */
export function loginMessage(address: string, nonce: string, issuedAt: number): string {
  return [
    "LaunchPad — sign in",
    "",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    "",
    "Signing proves you hold this wallet. It costs no gas and sends no transaction.",
  ].join("\n");
}

/** Hand out a challenge for an address. */
export function createChallenge(
  address: string,
  nowMs = Date.now(),
): { nonce: string; message: string } {
  const lower = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error("not a wallet address");
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, { address: lower, expiresAt: nowMs + NONCE_TTL_MS });
  return { nonce, message: loginMessage(lower, nonce, nowMs) };
}

/**
 * Check a signature against a challenge and, if it holds, open a session.
 *
 * The nonce is consumed whether or not the signature verifies: a challenge is
 * one attempt, so a wrong signature burns it rather than leaving it open to
 * guess against. Recovery is local — an EOA signature carries its own signer —
 * so this needs no chain.
 */
export async function verifyLogin(
  input: { address: string; nonce: string; signature: `0x${string}` },
  nowMs = Date.now(),
): Promise<{ token: string; session: Session }> {
  const lower = input.address.toLowerCase();
  const record = nonces.get(input.nonce);
  nonces.delete(input.nonce);
  if (!record) throw new Error("unknown or already-used challenge — ask for a new one");
  if (record.expiresAt < nowMs) throw new Error("challenge expired — ask for a new one");
  if (record.address !== lower) throw new Error("challenge was issued for a different wallet");

  const message = loginMessage(lower, input.nonce, record.expiresAt - NONCE_TTL_MS);
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({ message, signature: input.signature });
  } catch {
    throw new Error("signature is not readable");
  }
  if (recovered.toLowerCase() !== lower) throw new Error("signature does not match the wallet");

  const token = randomBytes(32).toString("hex");
  const session: Session = {
    address: lower as `0x${string}`,
    issuedAt: nowMs,
    expiresAt: nowMs + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  return { token, session };
}

/** The address a session token belongs to, or null when it is unknown/expired. */
export function sessionOf(token: string | undefined, nowMs = Date.now()): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < nowMs) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/** End one session — a logout. */
export function endSession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/** Drop expired nonces and sessions. Cheap; call it on a timer. */
export function sweepExpired(nowMs = Date.now()): void {
  for (const [k, v] of nonces) if (v.expiresAt < nowMs) nonces.delete(k);
  for (const [k, v] of sessions) if (v.expiresAt < nowMs) sessions.delete(k);
}

// ── Persistence, so a restart does not sign everyone out ────────────────────
// Only sessions are worth keeping; a nonce lives five minutes and a restart
// losing one just means asking for another.

export function exportSessions(): [string, Session][] {
  return [...sessions.entries()];
}

export function importSessions(entries: [string, Session][], nowMs = Date.now()): void {
  for (const [token, s] of entries) {
    if (s && s.expiresAt > nowMs) sessions.set(token, s);
  }
}

/** For tests: forget everything. */
export function resetAuth(): void {
  nonces.clear();
  sessions.clear();
}
