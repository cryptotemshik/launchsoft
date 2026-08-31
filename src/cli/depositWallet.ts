/**
 * One deposit address per account, and the little bookkeeping that credits a
 * balance when ETH lands on it.
 *
 * Custodial by design: the address is a fresh wallet the service generates and
 * holds the key to (sealed, like every other key here), so an account tops up
 * simply by sending ETH to it — no memo, no matching a sender, no shared
 * treasury to disambiguate. A watcher reads the address's balance over the
 * chain and credits the account the amount it has risen by since last seen, so
 * every deposit is caught exactly once and nothing is credited twice.
 *
 * The private key is only ever needed to move the funds on (a sweep or a
 * refund), which is a later concern; storing it now, sealed, means that path is
 * open without regenerating anyone's address. The address itself is public and
 * stored in the clear so the watcher and the UI can read it with no passphrase.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isEncrypted, seal, unseal } from "./keystore";

interface DepositRecord {
  address: `0x${string}`;
  /** The private key — sealed when a passphrase is set, plain otherwise. */
  key: string;
  /** The on-chain balance last credited, in wei, as a decimal string. */
  seenWei: string;
}

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.deposit.json`;
}

function read(configPath: string): DepositRecord | null {
  try {
    const r = JSON.parse(readFileSync(pathFor(configPath), "utf8")) as Partial<DepositRecord>;
    if (typeof r.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.address) && typeof r.key === "string") {
      return {
        address: r.address.toLowerCase() as `0x${string}`,
        key: r.key,
        seenWei: typeof r.seenWei === "string" && /^\d+$/.test(r.seenWei) ? r.seenWei : "0",
      };
    }
  } catch {
    /* none yet */
  }
  return null;
}

function write(configPath: string, rec: DepositRecord): void {
  const target = pathFor(configPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * The account's deposit address, generating one the first time.
 *
 * Idempotent: an existing address is returned untouched — a deposit address
 * must never move, or funds sent to the old one are lost. The key is sealed
 * with the passphrase when there is one.
 */
export function ensureDeposit(configPath: string, passphrase: string | null): `0x${string}` {
  const existing = read(configPath);
  if (existing) return existing.address;
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address.toLowerCase() as `0x${string}`;
  write(configPath, {
    address,
    key: passphrase ? seal(key, passphrase) : key,
    seenWei: "0",
  });
  return address;
}

/** The deposit address if one exists, without needing a passphrase. */
export function depositAddress(configPath: string): `0x${string}` | null {
  return read(configPath)?.address ?? null;
}

/** The wei last credited from this address. */
export function seenWei(configPath: string): bigint {
  return BigInt(read(configPath)?.seenWei ?? "0");
}

/** Record the on-chain balance now credited, so the next rise is the next deposit. */
export function setSeenWei(configPath: string, wei: bigint): void {
  const rec = read(configPath);
  if (!rec) return;
  rec.seenWei = wei.toString();
  write(configPath, rec);
}

/** The deposit wallet's private key — for a sweep or refund. Needs the passphrase. */
export function depositKey(configPath: string, passphrase: string | null): `0x${string}` | null {
  const rec = read(configPath);
  if (!rec) return null;
  if (!isEncrypted(rec.key)) return rec.key as `0x${string}`;
  if (!passphrase) throw new Error("the deposit key is sealed but no passphrase is set");
  return unseal(rec.key, passphrase) as `0x${string}`;
}
