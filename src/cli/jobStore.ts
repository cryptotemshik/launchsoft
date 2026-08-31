/**
 * Keeping the queue across a restart.
 *
 * The queue used to be a plain array in memory, and that lost a drop. A job
 * queued hours ahead vanished the moment anyone ran `pm2 restart` — no
 * warning, no line in the log, nothing at the appointed time. Updating the
 * server is a routine thing to do between drops, so the queue has to survive
 * it; anything else makes "git pull && pm2 restart" a way to silently throw
 * away work that was already set up.
 *
 * Only pending work is written. A finished job is history, and history that
 * outlives the process it happened in is a different feature — one that would
 * need pruning, growth limits and a decision about how long is long enough.
 * What must never be lost is a job that has not run yet.
 *
 * Logs and results are deliberately left out too: a run's log is thousands of
 * lines, and rewriting the file on every one of them would turn the fire path
 * into a disk-bound loop.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { RunOptions } from "./runner";

/** Statuses a stored job can have. Anything finished is not stored at all. */
export type StoredStatus = "queued" | "armed";

export interface StoredJob {
  id: string;
  label: string;
  addedAt: number;
  status: StoredStatus;
  request: Omit<RunOptions, "signer" | "wallets">;
  startTime?: number;
  wallets?: string[];
  /** The account this job belongs to (lower-case), or null for the main world. */
  account?: string | null;
  /** The config path whose wallets/signer this job runs on. */
  cfgPath?: string;
}

export function jobsPath(configPath: string): string {
  return `${resolve(configPath)}.jobs.json`;
}

export function loadJobs(configPath: string): StoredJob[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jobsPath(configPath), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredJob);
  } catch {
    // No file yet, or one nobody can parse. Either way there is no queue to
    // restore, and saving over it is how it gets fixed.
    return [];
  }
}

function isStoredJob(v: unknown): v is StoredJob {
  if (!v || typeof v !== "object") return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j.id === "string" &&
    typeof j.label === "string" &&
    (j.status === "queued" || j.status === "armed") &&
    !!j.request &&
    typeof j.request === "object"
  );
}

/**
 * Write via a temporary file and rename, at 0600.
 *
 * A rename is atomic, so a crash mid-write leaves the previous queue intact
 * rather than half a file that parses as nothing. The mode matters because a
 * job's request carries the endpoint URLs it will mint through, and on a paid
 * plan those URLs are the API key.
 */
export function saveJobs(configPath: string, jobs: readonly StoredJob[]): void {
  const target = jobsPath(configPath);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * What a restored job should become.
 *
 * A job that was `armed` when the process died was already firing, or about to.
 * Its transactions may or may not have gone out, and the run cannot be picked
 * up mid-flight — so it goes back on the queue only if its stage has not opened
 * yet, and otherwise says plainly that it was interrupted rather than
 * pretending to still be waiting for a moment that has passed.
 *
 * @param nowMs so the decision is testable without waiting for a clock.
 */
export function restoreStatus(
  job: StoredJob,
  nowMs: number,
): { status: "queued"; } | { status: "error"; error: string } {
  if (job.status === "queued") return { status: "queued" };
  if (job.startTime === undefined) {
    return {
      status: "error",
      error: "the server restarted while this job was arming — requeue it if the stage is still ahead",
    };
  }
  if (job.startTime * 1000 > nowMs) return { status: "queued" };
  return {
    status: "error",
    error: "the server restarted while this job was firing, and its stage has since opened",
  };
}
