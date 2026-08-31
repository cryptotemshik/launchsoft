import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createChallenge,
  endSession,
  exportSessions,
  importSessions,
  isAdmin,
  loginMessage,
  NONCE_TTL_MS,
  resetAuth,
  sessionOf,
  sweepExpired,
  verifyLogin,
  SESSION_TTL_MS,
} from "./auth";

const KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const account = privateKeyToAccount(KEY);
const ADDR = account.address;

afterEach(() => resetAuth());

/** Go through the real flow: challenge, sign it, verify. */
async function login(nowMs = Date.now()) {
  const { nonce } = createChallenge(ADDR, nowMs);
  // The client signs the exact message the server will reconstruct.
  const message = loginMessage(ADDR.toLowerCase(), nonce, nowMs);
  const signature = await account.signMessage({ message });
  return verifyLogin({ address: ADDR, nonce, signature }, nowMs);
}

describe("logging in with a wallet", () => {
  it("opens a session for a valid signature", async () => {
    const { token, session } = await login();
    expect(session.address).toBe(ADDR.toLowerCase());
    expect(sessionOf(token)?.address).toBe(ADDR.toLowerCase());
  });

  it("refuses a signature from a different wallet", async () => {
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const { nonce } = createChallenge(ADDR);
    const message = loginMessage(ADDR.toLowerCase(), nonce, Date.now());
    const signature = await other.signMessage({ message });
    await expect(verifyLogin({ address: ADDR, nonce, signature })).rejects.toThrow(
      /does not match/,
    );
  });

  it("spends the challenge whether or not it verified", async () => {
    // A challenge is one attempt: a wrong guess must not leave it open to try
    // again and again.
    const { nonce } = createChallenge(ADDR);
    const bad = (`0x${"00".repeat(65)}`) as `0x${string}`;
    await expect(verifyLogin({ address: ADDR, nonce, signature: bad })).rejects.toThrow();
    // A correct signature over the same, now-spent nonce is refused.
    const message = loginMessage(ADDR.toLowerCase(), nonce, Date.now());
    const signature = await account.signMessage({ message });
    await expect(verifyLogin({ address: ADDR, nonce, signature })).rejects.toThrow(
      /already-used|unknown/,
    );
  });

  it("refuses an expired challenge", async () => {
    const t0 = 1_000_000;
    const { nonce } = createChallenge(ADDR, t0);
    const message = loginMessage(ADDR.toLowerCase(), nonce, t0);
    const signature = await account.signMessage({ message });
    await expect(
      verifyLogin({ address: ADDR, nonce, signature }, t0 + NONCE_TTL_MS + 1),
    ).rejects.toThrow(/expired/);
  });

  it("refuses a challenge issued for another wallet", async () => {
    const { nonce } = createChallenge(`0x${"cd".repeat(20)}`);
    const message = loginMessage(ADDR.toLowerCase(), nonce, Date.now());
    const signature = await account.signMessage({ message });
    await expect(verifyLogin({ address: ADDR, nonce, signature })).rejects.toThrow(
      /different wallet/,
    );
  });
});

describe("sessions", () => {
  it("expires on its own clock", async () => {
    const { token } = await login(1_000_000);
    expect(sessionOf(token, 1_000_000 + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(sessionOf(token, 1_000_000 + SESSION_TTL_MS + 1)).toBeNull();
  });

  it("ends on logout", async () => {
    const { token } = await login();
    endSession(token);
    expect(sessionOf(token)).toBeNull();
  });

  it("treats a missing or unknown token as no session", () => {
    expect(sessionOf(undefined)).toBeNull();
    expect(sessionOf("nope")).toBeNull();
  });

  it("survives a restart through export/import, dropping the expired", async () => {
    const { token } = await login(1_000_000);
    const dumped = exportSessions();
    resetAuth();
    importSessions(dumped, 1_000_000 + 1000);
    expect(sessionOf(token, 1_000_000 + 1000)?.address).toBe(ADDR.toLowerCase());
    // A restart far in the future restores nothing stale.
    resetAuth();
    importSessions(dumped, 1_000_000 + SESSION_TTL_MS + 1);
    expect(sessionOf(token, 1_000_000 + SESSION_TTL_MS + 1)).toBeNull();
  });
});

describe("sweeping", () => {
  it("clears expired sessions", async () => {
    const { token } = await login(1_000_000);
    sweepExpired(1_000_000 + SESSION_TTL_MS + 1);
    // Even at a time it would still be valid, the sweep already removed it.
    expect(sessionOf(token, 1_000_000 + 1)).toBeNull();
  });
});

describe("admin", () => {
  it("reads admin addresses from the environment, case-insensitively", () => {
    const env = { SNIPE_ADMIN_ADDRESS: `${ADDR.toUpperCase().replace("0X", "0x")}, 0x${"ab".repeat(20)}` };
    expect(isAdmin(ADDR, env)).toBe(true);
    expect(isAdmin(`0x${"ab".repeat(20)}`, env)).toBe(true);
    expect(isAdmin(`0x${"99".repeat(20)}`, env)).toBe(false);
  });

  it("nobody is admin when none is configured", () => {
    expect(isAdmin(ADDR, {})).toBe(false);
  });
});
