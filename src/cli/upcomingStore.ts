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

/**
 * Is this the same drop as one already on the list?
 *
 * The id cannot answer that: it is minted from the name and the clock, so
 * pressing "watch" on the same collection twice produced two ids and two
 * entries. What identifies a drop is the contract, or the handle when there is
 * no contract yet — the two things the list is keyed on for a reason.
 *
 * Name is deliberately not a fallback. Half the collections on this chain are
 * called something like "Genesis", and folding two different drops together is
 * worse than listing one twice.
 */
export function sameDrop(a: UpcomingMint, b: UpcomingMint): boolean {
  if (a.contract && b.contract) return a.contract.toLowerCase() === b.contract.toLowerCase();
  if (a.twitter && b.twitter) return a.twitter.toLowerCase() === b.twitter.toLowerCase();
  return false;
}

/**
 * Add one, unless the same drop is already there.
 *
 * Returns what is on the list either way, plus the existing entry when it
 * refused — the caller wants to say "already watching", not "failed".
 */
export function addUpcoming(
  configPath: string,
  mint: UpcomingMint,
): { list: UpcomingMint[]; duplicate?: UpcomingMint } {
  const list = loadUpcoming(configPath);
  // Same id means this is the same record being re-saved, which is an update
  // and always allowed. Only a *different* record for a drop already listed is
  // a duplicate.
  const already = list.find((m) => m.id !== mint.id && sameDrop(m, mint));
  if (already) return { list, duplicate: already };
  const next = [...list.filter((m) => m.id !== mint.id), mint];
  saveUpcoming(configPath, next);
  return { list: next };
}

/**
 * Change what a person said about one entry, leaving the drop itself alone.
 *
 * The colour and the note are the two fields that change often and mean
 * nothing to the drop: they are somebody's opinion of it. So they get their
 * own narrow door rather than a general "save this record" that could quietly
 * overwrite a date typed on a phone.
 *
 * A field left out of the patch is left alone, which is what lets the colour
 * picker and the note box write independently without either clearing the
 * other. Setting a field to undefined explicitly is how it gets cleared.
 */
export interface UpcomingAnnotation {
  color?: string | undefined;
  note?: string | undefined;
}

export function annotateUpcoming(
  configPath: string,
  id: string,
  patch: UpcomingAnnotation,
): { updated?: UpcomingMint; list: UpcomingMint[] } {
  const list = loadUpcoming(configPath);
  const found = list.find((m) => m.id === id);
  if (!found) return { list };
  const updated: UpcomingMint = { ...found };
  if ("color" in patch) {
    // "auto" is the absence of a choice, so it is stored as one — an entry set
    // back to automatic looks exactly like one that was never coloured.
    if (patch.color === undefined || patch.color === "auto") delete updated.color;
    else updated.color = patch.color;
  }
  if ("note" in patch) {
    if (patch.note === undefined) delete updated.note;
    else updated.note = patch.note;
  }
  const next = list.map((m) => (m.id === id ? updated : m));
  saveUpcoming(configPath, next);
  return { updated, list: next };
}

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
