/**
 * Public-drop window maths.
 *
 * SeaDrop stores an absolute `startTime` and `endTime` (uint48 unix seconds).
 * OpenSea's "Edit drop stage" dialog instead shows a *duration*, which is a
 * different mental model: a duration only becomes a window once you say what
 * it counts from. Editing there re-derives `endTime`, so a stage that has
 * already been running can come back shorter than it was. These helpers let
 * LaunchPad speak both languages and spot a window that has collapsed.
 */

export interface Duration {
  days: number;
  hours: number;
  mins: number;
}

export const ZERO_DURATION: Duration = { days: 0, hours: 0, mins: 0 };

export function durationToSeconds(d: Duration): number {
  return (
    Math.max(0, Math.floor(d.days)) * 86_400 +
    Math.max(0, Math.floor(d.hours)) * 3_600 +
    Math.max(0, Math.floor(d.mins)) * 60
  );
}

export function secondsToDuration(seconds: number): Duration {
  const s = Math.max(0, Math.floor(seconds));
  return {
    days: Math.floor(s / 86_400),
    hours: Math.floor((s % 86_400) / 3_600),
    mins: Math.floor((s % 3_600) / 60),
  };
}

/** "2d 3h 15m" / "45m" / "—" for a duration in seconds. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "0m";
  const { days, hours, mins } = secondsToDuration(s);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

export type WindowState = "unconfigured" | "pending" | "live" | "ended";

export interface WindowInfo {
  state: WindowState;
  /** Total length of the window in seconds (end − start). */
  totalSeconds: number;
  /** Seconds until the drop opens (0 once it has). */
  startsInSeconds: number;
  /** Seconds of minting left (0 once over). */
  remainingSeconds: number;
  /** Seconds already elapsed since the drop opened (0 before it does). */
  elapsedSeconds: number;
}

export function describeWindow(
  startTime: number,
  endTime: number,
  now: number,
): WindowInfo {
  if (startTime === 0) {
    return {
      state: "unconfigured",
      totalSeconds: 0,
      startsInSeconds: 0,
      remainingSeconds: 0,
      elapsedSeconds: 0,
    };
  }
  const totalSeconds = Math.max(0, endTime - startTime);
  const state: WindowState =
    now < startTime ? "pending" : now > endTime ? "ended" : "live";
  return {
    state,
    totalSeconds,
    startsInSeconds: Math.max(0, startTime - now),
    remainingSeconds: Math.max(0, endTime - now),
    elapsedSeconds: Math.max(0, Math.min(now, endTime) - startTime),
  };
}

/**
 * Problems worth shouting about before a drop goes live — or right after an
 * edit made somewhere else (OpenSea's dialog) silently reshaped the window.
 */
export function windowWarnings(
  startTime: number,
  endTime: number,
  now: number,
): string[] {
  const out: string[] = [];
  if (startTime === 0) {
    out.push("No public drop configured — nobody can mint until a window is set.");
    return out;
  }
  if (endTime <= startTime) {
    out.push(
      "End time is at or before start time — the drop can never be open. Set a new window.",
    );
    return out;
  }
  const { state, totalSeconds, remainingSeconds } = describeWindow(
    startTime,
    endTime,
    now,
  );
  if (state === "ended") {
    out.push(
      `Drop is CLOSED — it ended ${formatDuration(now - endTime)} ago. Minting is off until you set a new end time.`,
    );
  } else if (state === "live" && remainingSeconds < 600) {
    out.push(
      `Only ${formatDuration(remainingSeconds)} of minting left — extend the end time if this wasn't intended.`,
    );
  }
  if (totalSeconds > 0 && totalSeconds < 600) {
    out.push(
      `The whole window is just ${formatDuration(totalSeconds)} long. If you edited the stage on OpenSea, its Duration field re-derives the end time and can shorten a running stage.`,
    );
  }
  return out;
}

/**
 * A window that runs for `duration` starting now (or keeping the original
 * start when the drop is already open and the caller wants to preserve it).
 */
export function windowFromDuration(
  duration: Duration,
  now: number,
  opts: { keepStart?: number } = {},
): { startTime: number; endTime: number } {
  const seconds = durationToSeconds(duration);
  const startTime =
    opts.keepStart !== undefined && opts.keepStart > 0 && opts.keepStart <= now
      ? opts.keepStart
      : now;
  return { startTime, endTime: now + seconds };
}
