/**
 * The collections this server knows about.
 *
 * Reading holdings from Transfer logs is fast but has to be told which
 * contract to read — logs are filtered by address. Almost always the answer is
 * "the ones we minted", which the server watches happen and can simply
 * remember, so the common case needs no index at all.
 *
 * Kept beside the config as plain JSON, so it survives a restart and can be
 * read or edited by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface KnownCollection {
  address: `0x${string}`;
  name?: string;
  /** When this server first minted or was pointed at it. */
  firstSeen: number;
  /** Block it was first minted in — where a log scan can start. */
  fromBlock?: string;
}

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.collections`;
}

export function loadCollections(configPath: string): KnownCollection[] {
  try {
    const raw = JSON.parse(readFileSync(pathFor(configPath), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is KnownCollection =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as KnownCollection).address === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test((c as KnownCollection).address),
    );
  } catch {
    // Absent or unreadable is the normal state before the first mint.
    return [];
  }
}

/**
 * Record a collection, keeping the earliest block seen for it.
 *
 * @returns the full list after the addition.
 */
export function rememberCollection(
  configPath: string,
  entry: { address: `0x${string}`; name?: string; fromBlock?: bigint },
): KnownCollection[] {
  const list = loadCollections(configPath);
  const key = entry.address.toLowerCase();
  const existing = list.find((c) => c.address.toLowerCase() === key);

  if (existing) {
    if (entry.name && !existing.name) existing.name = entry.name;
    if (entry.fromBlock !== undefined) {
      const known = existing.fromBlock === undefined ? undefined : BigInt(existing.fromBlock);
      if (known === undefined || entry.fromBlock < known) {
        existing.fromBlock = entry.fromBlock.toString();
      }
    }
  } else {
    list.push({
      address: entry.address,
      name: entry.name,
      firstSeen: Date.now(),
      fromBlock: entry.fromBlock?.toString(),
    });
  }

  try {
    writeFileSync(pathFor(configPath), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Losing the note costs a slower scan later, not correctness.
  }
  return list;
}
