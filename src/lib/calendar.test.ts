import { describe, expect, it } from "vitest";
import {
  dayFraction,
  eventKey,
  groupByDay,
  layoutDay,
  localMidnight,
  mergeCalendar,
  statusOf,
  weekDays,
  type CalendarEvent,
} from "./calendar";

const HOUR = 3600;
const DAY = 86_400;
/** 2026-08-27 12:00 UTC — a Thursday. */
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0) / 1000;
const MSK = 180;

const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "x",
  source: "scanner",
  name: "Drop",
  startsAt: NOW + HOUR,
  ...over,
});

describe("statusOf", () => {
  it("separates the next hour from the rest of the future", () => {
    expect(statusOf({ startsAt: NOW + 30 * 60 }, NOW)).toBe("soon");
    expect(statusOf({ startsAt: NOW + 5 * HOUR }, NOW)).toBe("upcoming");
  });

  it("calls a running window live and a finished one ended", () => {
    expect(statusOf({ startsAt: NOW - HOUR, endsAt: NOW + HOUR }, NOW)).toBe("live");
    expect(statusOf({ startsAt: NOW - 2 * HOUR, endsAt: NOW - HOUR }, NOW)).toBe("ended");
  });

  it("gives an open-ended stage three days before calling it over", () => {
    // The chain allows a window with no end and plenty of drops use one, so
    // "started" cannot mean "live forever".
    expect(statusOf({ startsAt: NOW - 40 * HOUR }, NOW)).toBe("live");
    expect(statusOf({ startsAt: NOW - 80 * HOUR }, NOW)).toBe("ended");
  });

  it("calls a drop nobody has dated undated, not upcoming", () => {
    expect(statusOf({ startsAt: 0 }, NOW)).toBe("undated");
  });
});

describe("eventKey", () => {
  it("uses the contract when there is one, whatever its case", () => {
    expect(eventKey({ contract: "0xAB", name: "x", startsAt: NOW }, MSK)).toBe("c:0xab");
  });

  it("falls back to the name and the local day", () => {
    const a = eventKey({ name: "Pipe Dogs", startsAt: NOW }, MSK);
    const b = eventKey({ name: " pipe dogs ", startsAt: NOW + HOUR }, MSK);
    expect(a).toBe(b);
  });

  it("keeps two drops of the same name on different days apart", () => {
    expect(eventKey({ name: "X", startsAt: NOW }, MSK)).not.toBe(
      eventKey({ name: "X", startsAt: NOW + DAY }, MSK),
    );
  });
});

describe("mergeCalendar", () => {
  const CONTRACT = "0xcf541a3db9328322e8fdaa6381242061d03875b8";

  it("collapses the same contract from both sources into one event", () => {
    const out = mergeCalendar(
      [ev({ source: "manual", name: "Pipe Dogs", contract: CONTRACT, twitter: "pipedogsnft" })],
      [ev({ source: "scanner", name: "pipe dogs", contract: CONTRACT, supply: 9999, minted: 12 })],
      MSK,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "both",
      name: "Pipe Dogs",
      supply: 9999,
      minted: 12,
      twitter: "pipedogsnft",
    });
  });

  it("lets what a person typed win over what was read", () => {
    // They wrote "Pipe Dogs" and the contract says "pipe dogs". Theirs.
    const out = mergeCalendar(
      [ev({ source: "manual", name: "Pipe Dogs", contract: CONTRACT, supply: 5000 })],
      [ev({ source: "scanner", name: "pipe dogs", contract: CONTRACT, supply: 9999 })],
      MSK,
      NOW,
    );
    expect(out[0].name).toBe("Pipe Dogs");
    expect(out[0].supply).toBe(5000);
  });

  it("matches a typed row with no contract against the scanner by name and day", () => {
    const out = mergeCalendar(
      [ev({ source: "manual", name: "Pipe Dogs" })],
      [ev({ source: "scanner", name: "pipe dogs", contract: CONTRACT, supply: 9999 })],
      MSK,
      NOW,
    );
    expect(out).toHaveLength(1);
    // …and the contract the scanner brought becomes the event's identity.
    expect(out[0].id).toBe(`c:${CONTRACT}`);
    expect(out[0].contract).toBe(CONTRACT);
  });

  it("keeps genuinely different drops apart", () => {
    const out = mergeCalendar(
      [ev({ source: "manual", name: "One" })],
      [ev({ source: "scanner", name: "Two", contract: "0xother" })],
      MSK,
      NOW,
    );
    expect(out).toHaveLength(2);
  });

  it("marks a start that has moved rather than replacing it silently", () => {
    // Teams postpone constantly, and the row quietly showing a new time is
    // how a mint gets missed.
    const before = mergeCalendar([], [ev({ contract: CONTRACT, startsAt: NOW + HOUR })], MSK, NOW);
    const after = mergeCalendar(
      [],
      [ev({ contract: CONTRACT, startsAt: NOW + 5 * HOUR })],
      MSK,
      NOW + 60,
      before,
    );
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].startsAt).toBe(NOW + 5 * HOUR);
    expect(after[0].rescheduledAt).toBe(NOW + 60);
  });

  it("does not cry reschedule when nothing moved", () => {
    const before = mergeCalendar([], [ev({ contract: CONTRACT })], MSK, NOW);
    const after = mergeCalendar([], [ev({ contract: CONTRACT })], MSK, NOW + 60, before);
    expect(after[0].rescheduledAt).toBeUndefined();
  });
});

describe("groupByDay", () => {
  it("names today, tomorrow and the rest", () => {
    const groups = groupByDay(
      [ev({ startsAt: NOW + HOUR }), ev({ startsAt: NOW + DAY }), ev({ startsAt: NOW + 5 * DAY })],
      NOW,
      MSK,
    );
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(["TODAY", "TOMORROW"]);
    expect(groups).toHaveLength(3);
  });

  it("puts a late-UTC drop on the local day it happens", () => {
    // 23:30 UTC is half past two the next morning in Moscow, and filing it
    // under today because the server said so is the bug this guards.
    const lateUtc = Date.UTC(2026, 7, 27, 23, 30, 0) / 1000;
    const [group] = groupByDay([ev({ startsAt: lateUtc })], NOW, MSK);
    expect(group.label).toBe("TOMORROW");
    // …and under UTC itself it is still today.
    expect(groupByDay([ev({ startsAt: lateUtc })], NOW, 0)[0].label).toBe("TODAY");
  });

  it("sorts what is live to the top of its day", () => {
    const g = groupByDay(
      [
        ev({ id: "later", startsAt: NOW + 6 * HOUR }),
        ev({ id: "running", startsAt: NOW - HOUR, endsAt: NOW + HOUR }),
      ],
      NOW,
      MSK,
    );
    expect(g[0].events.map((e) => e.id)).toEqual(["running", "later"]);
  });

  it("puts the undated last, not in 1970", () => {
    const g = groupByDay([ev({ startsAt: 0 }), ev({ startsAt: NOW + HOUR })], NOW, MSK);
    expect(g.map((x) => x.label)).toEqual(["TODAY", "NOT DATED"]);
  });
});

describe("the week view's arithmetic", () => {
  it("gives seven local midnights in order", () => {
    const days = weekDays(NOW, MSK);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(localMidnight(NOW, MSK));
    expect(days[6] - days[0]).toBe(6 * DAY);
  });

  it("places an event down its column by time of day", () => {
    const day = localMidnight(NOW, MSK);
    expect(dayFraction(day, day)).toBe(0);
    expect(dayFraction(day + DAY / 2, day)).toBeCloseTo(0.5, 5);
  });

  it("clamps something outside the day rather than drawing off the column", () => {
    const day = localMidnight(NOW, MSK);
    expect(dayFraction(day - HOUR, day)).toBe(0);
    expect(dayFraction(day + 2 * DAY, day)).toBe(1);
  });
});

describe("layoutDay", () => {
  const at = (h: number, m = 0) => ({ startsAt: h * HOUR + m * 60 });

  it("leaves events that do not collide at full width", () => {
    // The bug this replaced: lanes assigned by position put an 11am drop and
    // a 3pm one side by side, which reads as a clash that isn't there.
    const out = layoutDay([at(11), at(15)]);
    expect(out.map((p) => p.lanes)).toEqual([1, 1]);
    expect(out.map((p) => p.lane)).toEqual([0, 0]);
  });

  it("splits two drops close enough to overlap on screen", () => {
    const out = layoutDay([at(12), at(12, 40)]);
    expect(out.map((p) => p.lane)).toEqual([0, 1]);
    expect(out.every((p) => p.lanes === 2)).toBe(true);
  });

  it("gives a whole colliding group the same width", () => {
    const out = layoutDay([at(12), at(12, 20), at(12, 40)]);
    expect(out.every((p) => p.lanes === 3)).toBe(true);
    expect(out.map((p) => p.lane)).toEqual([0, 1, 2]);
  });

  it("reuses a lane once its event has cleared the screen", () => {
    const out = layoutDay([at(12), at(12, 30), at(13, 5)]);
    // The third starts after the first's block ends, so it takes lane 0 back.
    expect(out.map((p) => p.lane)).toEqual([0, 1, 0]);
  });

  it("orders by time whatever order it was handed", () => {
    expect(layoutDay([at(15), at(11)]).map((p) => p.event.startsAt)).toEqual([
      11 * HOUR,
      15 * HOUR,
    ]);
  });

  it("handles an empty day", () => {
    expect(layoutDay([])).toEqual([]);
  });
});
