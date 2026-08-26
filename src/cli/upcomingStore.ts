/**
 * Where upcoming drops are kept.
 *
 * A small JSON file beside the config, rewritten whole on every change. The
 * mint ledger is append-only because it records history that must never be
 * edited; this is the opposite — a working list that gets things added and
 * struck off — so a plain array that can be opened, read and hand-fixed is the
 * right shape.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { UpcomingMint } from "../lib/upcoming";

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.upcoming.json`;
}

export function loadUpcoming(configPath: string): UpcomingMint[] {
  try {
    const parsed = JSON.parse(readFileSync(pathFor(configPath), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is UpcomingMint =>
        m && typeof m.id === "string" && typeof m.name === "string" && typeof m.twitter === "string",
    );
  } catch {
    // No file yet, or one nobody can parse. Either way the list is empty, and
    // saving over it is how it gets fixed.
    return [];
  }
}

/**
 * Write via a temporary file and rename.
 *
 * A rename is atomic, so a crash mid-write leaves the previous list intact
 * rather than half a file that parses as nothing.
 */
export function saveUpcoming(configPath: string, list: readonly UpcomingMint[]): void {
  const target = pathFor(configPath);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** Add one, replacing any entry that already has its id. */
export function addUpcoming(configPath: string, mint: UpcomingMint): UpcomingMint[] {
  const list = loadUpcoming(configPath).filter((m) => m.id !== mint.id);
  const next = [...list, mint];
  saveUpcoming(configPath, next);
  return next;
}

/** Remove one by id. Returns what it removed, so the caller can name it. */
export function removeUpcoming(
  configPath: string,
  id: string,
): { removed?: UpcomingMint; list: UpcomingMint[] } {
  const list = loadUpcoming(configPath);
  const removed = list.find((m) => m.id === id);
  if (!removed) return { list };
  const next = list.filter((m) => m.id !== id);
  saveUpcoming(configPath, next);
  return { removed, list: next };
}
