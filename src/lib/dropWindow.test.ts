import { describe, expect, it } from "vitest";
import {
  describeWindow,
  durationToSeconds,
  formatDuration,
  secondsToDuration,
  windowFromDuration,
  windowWarnings,
} from "./dropWindow";

const HOUR = 3_600;
const DAY = 86_400;

describe("durationToSeconds / secondsToDuration", () => {
  it("round-trips", () => {
    const d = { days: 2, hours: 3, mins: 15 };
    expect(durationToSeconds(d)).toBe(2 * DAY + 3 * HOUR + 15 * 60);
    expect(secondsToDuration(durationToSeconds(d))).toEqual(d);
  });
  it("clamps negatives to zero", () => {
    expect(durationToSeconds({ days: -1, hours: -2, mins: -3 })).toBe(0);
    expect(secondsToDuration(-500)).toEqual({ days: 0, hours: 0, mins: 0 });
  });
  it("drops sub-minute remainders", () => {
    expect(secondsToDuration(119)).toEqual({ days: 0, hours: 0, mins: 1 });
  });
});

describe("formatDuration", () => {
  it("renders compact human durations", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(2 * HOUR + 5 * 60)).toBe("2h 5m");
    expect(formatDuration(2 * DAY + 3 * HOUR)).toBe("2d 3h");
  });
});

describe("describeWindow", () => {
  const start = 1_000_000;
  const end = start + 2 * HOUR;

  it("reports an unconfigured drop", () => {
    expect(describeWindow(0, 0, start).state).toBe("unconfigured");
  });
  it("reports pending before the start", () => {
    const w = describeWindow(start, end, start - 600);
    expect(w.state).toBe("pending");
    expect(w.startsInSeconds).toBe(600);
    expect(w.remainingSeconds).toBe(2 * HOUR + 600);
    expect(w.elapsedSeconds).toBe(0);
  });
  it("reports live mid-window with remaining time", () => {
    const w = describeWindow(start, end, start + 4 * 60);
    expect(w.state).toBe("live");
    expect(w.remainingSeconds).toBe(2 * HOUR - 4 * 60);
    expect(w.elapsedSeconds).toBe(4 * 60);
    expect(w.totalSeconds).toBe(2 * HOUR);
  });
  it("reports ended after the end", () => {
    const w = describeWindow(start, end, end + 60);
    expect(w.state).toBe("ended");
    expect(w.remainingSeconds).toBe(0);
    expect(w.elapsedSeconds).toBe(2 * HOUR);
  });
});

describe("windowWarnings", () => {
  const start = 1_000_000;

  it("flags a missing drop", () => {
    expect(windowWarnings(0, 0, start)[0]).toContain("No public drop configured");
  });

  it("flags end at or before start", () => {
    expect(windowWarnings(start, start, start)[0]).toContain(
      "End time is at or before start time",
    );
    expect(windowWarnings(start, start - 60, start)[0]).toContain(
      "End time is at or before start time",
    );
  });

  it("flags a closed drop", () => {
    const w = windowWarnings(start, start + HOUR, start + 2 * HOUR);
    expect(w.some((m) => m.includes("CLOSED"))).toBe(true);
  });

  it("flags a window about to expire", () => {
    const w = windowWarnings(start, start + 2 * HOUR, start + 2 * HOUR - 120);
    expect(w.some((m) => m.includes("of minting left"))).toBe(true);
  });

  // The reported failure mode: a stage that comes back only minutes long after
  // being edited through a duration-shaped dialog.
  it("flags a collapsed window and names the duration-dialog cause", () => {
    const w = windowWarnings(start, start + 120, start + 1);
    expect(w.some((m) => m.includes("whole window is just"))).toBe(true);
    expect(w.some((m) => m.includes("Duration field re-derives"))).toBe(true);
  });

  it("says nothing about a healthy long window", () => {
    expect(windowWarnings(start, start + 30 * DAY, start + HOUR)).toEqual([]);
  });
});

describe("windowFromDuration", () => {
  const now = 5_000_000;

  it("runs from now for the given duration", () => {
    const w = windowFromDuration({ days: 1, hours: 2, mins: 30 }, now);
    expect(w.startTime).toBe(now);
    expect(w.endTime).toBe(now + DAY + 2 * HOUR + 30 * 60);
  });

  it("keeps an already-open start so a live drop isn't restarted", () => {
    const started = now - 3 * HOUR;
    const w = windowFromDuration({ days: 0, hours: 2, mins: 0 }, now, {
      keepStart: started,
    });
    expect(w.startTime).toBe(started);
    // End is measured from NOW, not from the old start — that's the whole point.
    expect(w.endTime).toBe(now + 2 * HOUR);
  });

  it("ignores a future keepStart and starts now", () => {
    const w = windowFromDuration({ days: 0, hours: 1, mins: 0 }, now, {
      keepStart: now + HOUR,
    });
    expect(w.startTime).toBe(now);
  });
});
