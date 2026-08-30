/**
 * An append-only record of everything that touches wallets or moves money.
 *
 * The server's ordinary log says what it is doing; it is written for a person
 * reading it now, it is not structured, and pm2 rotates it away. That is fine
 * for "index: +632 blocks" and useless for the question this file exists to
 * answer: *who emptied that wallet, and when*.
 *
 * That question does not come up while the only wallets are yours. It comes up
 * the first time someone else's are on the box and something is missing — and
 * at that moment either there is a record or there is your word. So the record
 * starts before the first stranger's key arrives, not after the first dispute.
 *
 * One JSON object per line, so it can be grepped, tailed, and read a line at a
 * time without parsing a file that only grows. Written 0600, beside the config
 * with everything else.
 *
 * What never goes in: private keys, the keystore passphrase, session tokens.
 * Addresses do — they are public by construction, and an audit trail that
 * cannot name the wallet it is about is not one.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Events worth a line.
 *
 * Deliberately a closed set. An audit log that anything can write anything to
 * becomes a second application log, and then nobody reads it.
 */
export type AuditEvent =
  /** Wallets appeared on the box. */
  | "wallets.added"
  /** Wallets were struck off. The keys go with them — this is irreversible. */
  | "wallets.removed"
  /** ETH sent out of stored wallets. */
  | "funds.collected"
  /** ETH sent into stored wallets. */
  | "funds.dispersed"
  /** NFTs moved out of stored wallets. */
  | "nfts.swept"
  /** A mint job was armed, and with how much. */
  | "run.armed"
  /** A mint job finished, however it finished. */
  | "run.finished"
  /** The state of the key file at startup. */
  | "keys.state";

export interface AuditLine {
  /** ISO 8601, in UTC. Local time in an audit trail is an argument waiting. */
  at: string;
  event: AuditEvent;
  [key: string]: unknown;
}

/** Beside the config, like the queue and the drop index. */
export function auditPath(configPath: string): string {
  return `${resolve(configPath)}.audit.log`;
}

/**
 * How large the file gets before the previous one is set aside.
 *
 * A log that only grows fills a disk, and a full disk on this box means a
 * missed drop. One rotation is kept: enough to survive a burst of writes
 * without losing the week, bounded enough that it can never be the thing that
 * fills the volume.
 */
export const MAX_BYTES = 8 * 1024 * 1024;

/** Anything that must never reach the file, whatever a caller passes. */
const FORBIDDEN = /(^|_|\.)(key|keys|privatekey|passphrase|password|secret|token|mnemonic|seed)$/i;

/**
 * Strip anything that looks like a secret, at the last possible moment.
 *
 * Not a substitute for callers being careful — it is the backstop for when one
 * is not. A private key written into an append-only file is a private key that
 * cannot be unwritten, so the check belongs here, where every line passes.
 */
export function scrub(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (FORBIDDEN.test(k)) continue;
    // A 64-hex string is a private key far more often than it is anything
    // else worth recording, and there is no safe way to tell from here.
    if (typeof v === "string" && /^0x?[0-9a-fA-F]{64}$/.test(v.trim())) continue;
    out[k] = v;
  }
  return out;
}

function rotate(file: string): void {
  try {
    if (statSync(file).size >= MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or a rename that lost a race with another write. Neither is
    // a reason to drop the line that is about to be appended.
  }
}

/**
 * Write one line.
 *
 * Never throws. An audit record failing to write must not take down a mint —
 * losing the drop to protect the paperwork is the wrong trade — so a failure
 * goes to the ordinary log through `onError` and the caller carries on.
 */
export function audit(
  configPath: string,
  event: AuditEvent,
  detail: Record<string, unknown> = {},
  onError?: (message: string) => void,
): void {
  const file = auditPath(configPath);
  const line: AuditLine = { at: new Date().toISOString(), event, ...scrub(detail) };
  try {
    rotate(file);
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (e) {
    onError?.(`audit: could not record ${event} (${e instanceof Error ? e.message : e})`);
  }
}
