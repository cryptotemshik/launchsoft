/**
 * One list of what is coming, however it got there.
 *
 * Two things already know about future drops and neither knew about the other:
 * the scanner, which reads stages configured on-chain before anyone announces
 * them, and the watchlist, which holds what a person typed in — often days
 * before there is a contract to read. A drop usually starts life in the second
 * and turns up later in the first, and until now that meant seeing it twice.
 *
 * So this is the merge. An event carries whichever fields are known from
 * whichever side knew them, with what a person typed winning over what was
 * read: they wrote "Pipe Dogs" and the contract says "pipe dogs", and the one
 * worth showing is theirs.
 *
 * Everything here is pure, and the calendar is assembled in the browser from
 * the two endpoints that already exist. There is no third store to keep
 * correct, which is the only reason this is a small file.
 */

export type EventSource = "scanner" | "manual" | "both";

export interface CalendarEvent {
  /** Stable across refreshes: the contract when known, else name and day. */
  id: string;
  source: EventSource;
  name: string;
  contract?: string;
  /** Unix seconds. Zero means a drop nobody has dated yet. */
  startsAt: number;
  endsAt?: number;
  priceWei?: string;
  supply?: number;
  minted?: number;
  perWallet?: number;
  twitter?: string | null;
  /** The scanner's risk score, when it has one. */
  risk?: number | null;
  /** A start that moved since it was last seen, and when it moved. */
  rescheduledAt?: number;
}

export type EventStatus = "undated" | "upcoming" | "soon" | "live" | "ended";

/** Inside this, a drop is close enough to warrant the live-dot treatment. */
export const SOON_SEC = 3600;

/**
 * A stage that started and never said when it finishes.
 *
 * The chain allows an open-ended window and plenty of drops use one, so
 * "started" cannot mean "live forever". Three days is long enough to cover a
 * weekend mint and short enough that a stale row stops pretending.
 */
export const OPEN_ENDED_SEC = 72 * 3600;

export function statusOf(e: Pick<CalendarEvent, "startsAt" | "endsAt">, now: number): EventStatus {
  if (!e.startsAt) return "undated";
  if (now < e.startsAt) return e.startsAt - now <= SOON_SEC ? "soon" : "upcoming";
  if (e.endsAt) return now < e.endsAt ? "live" : "ended";
  return now - e.startsAt < OPEN_ENDED_SEC ? "live" : "ended";
}

/** Midnight local to a timezone, as a unix second. */
export function localMidnight(t: number, tzOffsetMin: number): number {
  const off = tzOffsetMin * 60;
  return Math.floor((t + off) / 86_400) * 86_400 - off;
}

/**
 * What two records of the same drop have in common.
 *
 * A contract is the real identity; before there is one, a name and a day is
 * the best available, and it is what a person typing "Pipe Dogs, 1 Sep" and a
 * scanner finding the same drop would agree on.
 */
export function eventKey(
  e: Pick<CalendarEvent, "contract" | "name" | "startsAt">,
  tzOffsetMin: number,
): string {
  if (e.contract) return `c:${e.contract.toLowerCase()}`;
  const day = e.startsAt ? localMidnight(e.startsAt, tzOffsetMin) : 0;
  return `n:${e.name.trim().toLowerCase()}:${day}`;
}

/** Prefer the first defined value — used to let typed fields win over read ones. */
function pick<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) if (v !== undefined && v !== null && v !== "") return v as T;
  return undefined;
}

/** Every name this event could be known by. Contract first: it is the real one. */
function keysOf(e: CalendarEvent, tzOffsetMin: number): string[] {
  const day = e.startsAt ? localMidnight(e.startsAt, tzOffsetMin) : 0;
  const byName = `n:${e.name.trim().toLowerCase()}:${day}`;
  return e.contract ? [`c:${e.contract.toLowerCase()}`, byName] : [byName];
}

/** Two records of one drop. What a person typed leads; the chain fills in. */
function combine(a: CalendarEvent, b: CalendarEvent): CalendarEvent {
  const typed = a.source === "manual" ? a : b.source === "manual" ? b : a;
  const read = typed === a ? b : a;
  return {
    id: typed.id,
    source: a.source === b.source ? a.source : "both",
    name: pick(typed.name, read.name) ?? read.name,
    contract: pick(typed.contract, read.contract),
    startsAt: typed.startsAt || read.startsAt,
    endsAt: pick(typed.endsAt, read.endsAt),
    priceWei: pick(typed.priceWei, read.priceWei),
    supply: pick(typed.supply, read.supply),
    // Minted is a fact about the chain right now; nobody types it.
    minted: pick(read.minted, typed.minted),
    perWallet: pick(typed.perWallet, read.perWallet),
    twitter: pick(typed.twitter, read.twitter) ?? null,
    risk: pick(read.risk, typed.risk) ?? null,
  };
}

/**
 * Fold the two sources into one list.
 *
 * The awkward part is that a typed row usually has no contract and the
 * scanner's always does, so the two describe the same drop under different
 * names. Each event is therefore filed under every key it could be known by,
 * and learning a contract re-files the whole entry under it — which is what
 * lets "Pipe Dogs, 1 Sep" and the address the scanner found become one row the
 * moment the chain catches up.
 *
 * @param manual what a person entered — its fields win.
 * @param scanner what was read on-chain — it fills the gaps and supplies the
 *   contract.
 * @param previous the last merge, so a start time that has moved can be
 *   noticed rather than silently replaced.
 */
export function mergeCalendar(
  manual: readonly CalendarEvent[],
  scanner: readonly CalendarEvent[],
  tzOffsetMin: number,
  now: number,
  previous: readonly CalendarEvent[] = [],
): CalendarEvent[] {
  const byKey = new Map<string, CalendarEvent>();
  /** Any key this drop has ever been known by → where it lives now. */
  const alias = new Map<string, string>();

  const put = (incoming: CalendarEvent) => {
    const keys = keysOf(incoming, tzOffsetMin);
    const canon = keys.map((k) => alias.get(k)).find(Boolean) ?? keys[0];
    const prev = byKey.get(canon);
    const merged = prev ? combine(prev, incoming) : incoming;

    // A contract promotes the entry out of its name-and-day key for good.
    const home = merged.contract ? `c:${merged.contract.toLowerCase()}` : canon;
    if (home !== canon) byKey.delete(canon);
    byKey.set(home, { ...merged, id: home });
    for (const k of [...keys, canon]) alias.set(k, home);
  };

  for (const e of manual) put(e);
  for (const e of scanner) put(e);

  const was = new Map(previous.map((e) => [e.id, e]));
  return [...byKey.values()].map((e) => {
    const before = was.get(e.id);
    const moved = before && before.startsAt && e.startsAt && before.startsAt !== e.startsAt;
    return moved ? { ...e, rescheduledAt: now } : { ...e, rescheduledAt: before?.rescheduledAt };
  });
}

export interface CalendarFilter {
  /** Wei, inclusive. */
  maxPriceWei?: bigint;
  freeOnly?: boolean;
  minSupply?: number;
  maxSupply?: number;
  /** Only drops with an account attached. */
  withTwitter?: boolean;
  minRisk?: number;
  /** Contracts and ids the user has hidden. */
  hidden?: ReadonlySet<string>;
  sources?: ReadonlySet<EventSource>;
}

/**
 * Filtering happens here, at display time, never at ingest.
 *
 * Loosening a filter has to reveal what it was hiding without re-reading the
 * chain — which it only can if nothing was thrown away on the way in.
 */
export function applyCalendarFilter(
  events: readonly CalendarEvent[],
  f: CalendarFilter,
): CalendarEvent[] {
  return events.filter((e) => {
    if (f.hidden?.has(e.id)) return false;
    if (f.sources && !f.sources.has(e.source)) return false;
    if (f.freeOnly && e.priceWei !== undefined && BigInt(e.priceWei) !== 0n) return false;
    if (f.maxPriceWei !== undefined && e.priceWei !== undefined && BigInt(e.priceWei) > f.maxPriceWei)
      return false;
    if (f.minSupply !== undefined && (e.supply ?? 0) < f.minSupply) return false;
    if (f.maxSupply !== undefined && (e.supply ?? Infinity) > f.maxSupply) return false;
    if (f.withTwitter && !e.twitter) return false;
    if (f.minRisk !== undefined && (e.risk ?? -1) < f.minRisk) return false;
    return true;
  });
}

export interface DayGroup {
  /** Local midnight of the day, unix seconds. Zero holds the undated. */
  day: number;
  label: string;
  events: CalendarEvent[];
}

/**
 * Grouped by the day they fall on where the reader is.
 *
 * A drop at 23:30 UTC is tomorrow in Moscow, and putting it under today
 * because the server said so is the bug this exists to avoid.
 */
export function groupByDay(
  events: readonly CalendarEvent[],
  now: number,
  tzOffsetMin: number,
): DayGroup[] {
  const today = localMidnight(now, tzOffsetMin);
  const by = new Map<number, CalendarEvent[]>();
  for (const e of events) {
    const day = e.startsAt ? localMidnight(e.startsAt, tzOffsetMin) : 0;
    const list = by.get(day);
    if (list) list.push(e);
    else by.set(day, [e]);
  }

  const label = (day: number): string => {
    if (day === 0) return "NOT DATED";
    if (day === today) return "TODAY";
    if (day === today + 86_400) return "TOMORROW";
    if (day === today - 86_400) return "YESTERDAY";
    return new Date(day * 1000).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  };

  return [...by.entries()]
    // Undated last: unknown is not "infinitely far away", it is unknown.
    .sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0]))
    .map(([day, list]) => ({
      day,
      label: label(day),
      // Live first within the day, then by time.
      events: [...list].sort((x, y) => {
        const rank = (e: CalendarEvent) => (statusOf(e, now) === "live" ? 0 : 1);
        return rank(x) - rank(y) || x.startsAt - y.startsAt;
      }),
    }));
}

/** The seven local days a week view covers, starting from `from`. */
export function weekDays(from: number, tzOffsetMin: number): number[] {
  const start = localMidnight(from, tzOffsetMin);
  return Array.from({ length: 7 }, (_, i) => start + i * 86_400);
}

/** Where in a day column an event sits, as a fraction from midnight. */
export function dayFraction(at: number, day: number): number {
  return Math.min(1, Math.max(0, (at - day) / 86_400));
}


/**
 * How to stack a day's events so none hides another.
 *
 * Only what actually collides gets narrowed. Assigning lanes by position in
 * the list — the obvious shortcut — puts an 11am drop and a 3pm one in
 * separate columns for no reason, which reads as though they clash when they
 * do not.
 *
 * "Collides" is about pixels, not minutes: a block needs roughly an hour of
 * column to be legible, so two drops forty minutes apart overlap on screen
 * even though they do not in time.
 */
export const BLOCK_MINUTES = 60;

export interface Placed<T> {
  event: T;
  lane: number;
  /** How many lanes this event's group needs, for the width. */
  lanes: number;
}

export function layoutDay<T extends { startsAt: number }>(
  events: readonly T[],
  blockSec = BLOCK_MINUTES * 60,
): Placed<T>[] {
  const sorted = [...events].sort((a, b) => a.startsAt - b.startsAt);
  const out: Placed<T>[] = [];
  /** Events sharing screen space, resolved together so they share a width. */
  let group: Placed<T>[] = [];
  let groupEnd = -Infinity;
  /** When each lane frees up. */
  let laneEnds: number[] = [];

  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const p of group) out.push({ ...p, lanes });
    group = [];
    laneEnds = [];
    groupEnd = -Infinity;
  };

  for (const e of sorted) {
    if (e.startsAt >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= e.startsAt);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    const end = e.startsAt + blockSec;
    laneEnds[lane] = end;
    groupEnd = Math.max(groupEnd, end);
    group.push({ event: e, lane, lanes: 1 });
  }
  flush();
  return out;
}
