/**
 * Handing the private keys back — deliberately, and only to the wallet owner.
 *
 * Everything else in this server is built so a stolen session cannot take the
 * money: keys never leave, withdrawals wait an hour on a new address. An
 * export undoes all of that in one response, so it asks for the one thing a
 * session thief does not have: a fresh signature from the wallet itself, over
 * a message that says exactly what it unlocks, good for one use and five
 * minutes. The server writes the message and keeps it; the page only relays
 * the signature, so it cannot be talked into signing something milder.
 *
 * Whose signature counts: the signed-in wallet for a wallet session, or any
 * admin address when the operator token is used (that token alone is not a
 * wallet, so it proves nothing about owning one).
 */
import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";

export const EXPORT_TTL_MS = 5 * 60_000;

interface Pending {
  message: string;
  /** Lower-case addresses whose signature is accepted. */
  signers: string[];
  cfgPath: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

export function exportMessage(opts: {
  signer: string;
  wallets: number;
  nonce: string;
  issuedAt: number;
}): string {
  return [
    "Orvex: EXPORT PRIVATE KEYS",
    "",
    `This reveals the private keys of all ${opts.wallets} wallet(s) in this account.`,
    "Anyone holding them controls the money. Only sign if you started this export yourself.",
    "",
    `Wallet: ${opts.signer}`,
    `Nonce: ${opts.nonce}`,
    `Issued: ${new Date(opts.issuedAt).toISOString()}`,
  ].join("\n");
}

/** Start an export: the message to sign, for whoever is allowed to sign it. */
export function issueExport(opts: {
  cfgPath: string;
  signers: string[];
  wallets: number;
  nowMs?: number;
}): { nonce: string; message: string; signer: string; expiresAt: number } {
  const now = opts.nowMs ?? Date.now();
  for (const [k, p] of pending) if (p.expiresAt <= now) pending.delete(k);
  if (opts.signers.length === 0) {
    throw new Error("no wallet can approve this — sign in with your wallet, or set SNIPE_ADMIN_ADDRESS");
  }
  const nonce = randomBytes(16).toString("hex");
  const signer = opts.signers[0];
  const message = exportMessage({ signer, wallets: opts.wallets, nonce, issuedAt: now });
  const expiresAt = now + EXPORT_TTL_MS;
  pending.set(nonce, {
    message,
    signers: opts.signers.map((s) => s.toLowerCase()),
    cfgPath: opts.cfgPath,
    expiresAt,
  });
  return { nonce, message, signer, expiresAt };
}

/**
 * Check a signature against an issued export. Single use: the nonce is spent
 * whether or not the signature is good, so a wrong guess cannot be retried
 * against the same message.
 */
export async function redeemExport(opts: {
  nonce: string;
  signature: `0x${string}`;
  cfgPath: string;
  nowMs?: number;
}): Promise<{ signer: string }> {
  const now = opts.nowMs ?? Date.now();
  const p = pending.get(opts.nonce);
  pending.delete(opts.nonce);
  if (!p || p.expiresAt <= now) throw new Error("this export expired or was already used — start again");
  if (p.cfgPath !== opts.cfgPath) throw new Error("this export was started for a different account");
  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message: p.message, signature: opts.signature })).toLowerCase();
  } catch {
    throw new Error("that is not a valid signature");
  }
  if (!p.signers.includes(recovered)) throw new Error("signed by a wallet that does not own this account");
  return { signer: recovered };
}
