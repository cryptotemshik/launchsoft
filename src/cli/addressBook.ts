/**
 * The wallet addresses, in the clear, so the API can list them without a key.
 *
 * Once the keys live in a separate process, the API is started with no
 * passphrase — that is the whole point, so a break-in cannot decrypt anything.
 * But the API still has to know which wallets exist: to show the list, to
 * enforce the policy (whose "our own wallets" set is exactly these), to pick
 * which wallets a job or a sweep touches. All of that needs addresses, and an
 * address is public — it is on-chain the moment the wallet does anything.
 *
 * So the signer writes this alongside the encrypted key file: a plain list of
 * address + label, readable by a process that holds no passphrase. It carries
 * nothing secret; a label is a nickname and an address is public. The keys
 * stay sealed and stay in the one process that can open them.
 *
 * It is a cache of a fact the key file already holds, so it is always written
 * by whoever just changed the keys — never edited by hand — and a reader falls
 * back to deriving it from the key file when there is no book yet and it does
 * hold the passphrase (the single-process case, and the first run).
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { keysPath } from "./config";

export interface WalletRef {
  address: `0x${string}`;
  label?: string;
}

export function addressBookPath(configPath: string, keysFile: string): string {
  return `${keysPath(configPath, keysFile)}.addresses.json`;
}

/** Write the book, atomically. 0644 on purpose: it holds nothing private. */
export function writeAddressBook(
  configPath: string,
  keysFile: string,
  wallets: readonly WalletRef[],
): void {
  const target = addressBookPath(configPath, keysFile);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(wallets, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, target);
}

/** The book, or null when there is none — the caller then derives it. */
export function loadAddressBook(configPath: string, keysFile: string): WalletRef[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(addressBookPath(configPath, keysFile), "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (v): v is WalletRef =>
        !!v &&
        typeof v === "object" &&
        typeof (v as WalletRef).address === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test((v as WalletRef).address),
    );
  } catch {
    return null;
  }
}
