/**
 * Your watchlist, on a calendar.
 *
 * This used to show every stage the scanner could find on-chain, which is a
 * firehose: hundreds of drops a week, of which you care about ten. So the
 * calendar is now the watchlist and nothing else — what you added is what is
 * on it — and discovery stays where it belongs, in the scanner.
 *
 * That change pays for itself twice. Populating the calendar used to mean
 * asking the server to read three days of logs, close to six million blocks on
 * this chain and the heaviest thing it does; now it asks for the public stage
 * of the handful of contracts you actually watch, which is one multicall. The
 * calendar opens at once, and it no longer depends on whether a stage happened
 * to fall inside the window someone picked.
 *
 * The watchlist is still the only store. A row's date and name come from what
 * you typed, the chain fills in price, supply and the real start, and what you
 * typed wins where the two disagree.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import { createTabStore } from "../lib/tabStore";
import { notifyWatchlistChanged, onWatchlistChanged } from "../lib/watchlistSignal";
import { ColorPicker, NoteBox } from "./DropNote";
import {
  dayFraction,
  groupByDay,
  layoutDay,
  localMidnight,
  mergeCalendar,
  statusOf,
  weekDays,
  type CalendarEvent,
  type EventStatus,
} from "../lib/calendar";
import type { ScannedDrop } from "../lib/dropScan";
import type { CollectionInfo } from "../lib/collectionInfo";
import { seedWatched } from "../lib/watchedStore";
import { colorClass, type Pickable } from "../lib/calendarColor";
import { twitterUrl } from "../lib/collectionInfo";
import type { UpcomingMint } from "../lib/upcoming";
import { openSeaCollectionUrlBySlug } from "../chains";
import { setPendingTarget } from "../lib/snipeTarget";
import Addr from "./Addr";
import StaleServer from "./StaleServer";

type View = "list" | "week";

const STATUS_CLASS: Record<EventStatus, string> = {
  live: "ok",
  soon: "warn",
  upcoming: "",
  undated: "dim",
  ended: "dim",
};

/** A countdown a person reads at a glance. Fixed width, so it cannot jitter. */
function countdown(secs: number): string {
  const s = Math.max(0, secs);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

function timeOf(at: number): string {
  return new Date(at * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The reader's own zone, named the way a terminal would label it. */
function tzChip(): { label: string; offsetMin: number } {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin < 0 ? "−" : "+";
  const h = Math.floor(Math.abs(offsetMin) / 60);
  const m = Math.abs(offsetMin) % 60;
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "LOCAL";
  return {
    label: `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""} · ${name.split("/").pop()}`,
    offsetMin,
  };
}

/**
 * What this tab has read, kept where leaving the tab cannot throw it away.
 *
 * At module scope on purpose: the app renders one tab at a time, so the
 * component is unmounted the moment you look at anything else. See
 * src/lib/tabStore.ts for why that mattered.
 *
 * `hidden` rides along with the rest. Hiding a row is a decision about the
 * list, and losing it on the way to another tab and back made the button
 * pointless.
 */
interface CalendarData {
  events: CalendarEvent[];
  /** Which watchlist row each event came from — recolour and remove need it. */
  ids: Record<string, string>;
  hidden: Set<string>;
  info: Record<string, CollectionInfo>;
  openSeaSlug?: string;
}

const store = createTabStore<CalendarData>(
  { events: [], ids: {}, hidden: new Set(), info: {} },
  {
    describeError: (m) =>
      /404/.test(m) ? "This server is too old for the calendar — update it first." : m,
  },
);

/**
 * The other view of this list has written to it — drop what is held.
 *
 * A store with a fetcher reads again at once, so a colour picked in one tab is
 * the colour in the other before you get there. One belonging to a tab nobody
 * has opened yet simply counts as stale.
 */
onWatchlistChanged((source) => {
  if (source === store) return;
  store.invalidate();
  void store.run();
});

export default function CalendarTab() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const held = useSyncExternalStore(store.subscribe, store.getState);
  const { events, ids, hidden, info, openSeaSlug } = held.data;
  const { error, busy } = held;
  const [view, setView] = useState<View>(() =>
    typeof window !== "undefined" && window.innerWidth < 900 ? "list" : "week",
  );
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [showEnded, setShowEnded] = useState(false);
  /** Handles and floors, the same lookup the scanner uses. */
  /** Watchlist id per event id, so a row can be recoloured or struck off. */
  const [selected, setSelected] = useState<string | null>(null);
  const [weekFrom, setWeekFrom] = useState(() => Math.floor(Date.now() / 1000));
  const [adding, setAdding] = useState(false);

  const tz = useMemo(tzChip, []);

  /**
   * One read: the watchlist, then the public stage of everything on it.
   *
   * It throws rather than catching — the store turns a throw into the line of
   * red text and keeps the events already on screen, so a refresh that fails
   * costs nothing that was already being read.
   */
  const load = useCallback(async () => {
    {
      save();
      const watch = (await call("/api/upcoming")) as Record<string, unknown>;
      const list = (watch.upcoming as UpcomingMint[]) ?? [];
      seedWatched(list);
      store.set({ openSeaSlug: watch.openSeaSlug as string | undefined });

      const manual: CalendarEvent[] = list.map((m) => ({
        id: "",
        source: "manual",
        name: m.name,
        contract: m.contract,
        startsAt: m.at ?? 0,
        supply: m.supply,
        color: m.color,
        note: m.note,
        twitter: m.twitter ? m.twitter.replace(/^https?:\/\/(www\.)?x\.com\//i, "") : null,
      }));

      // Only the watched contracts, and only the public stage: one multicall
      // instead of the three-day log read this tab used to start on mount.
      const contracts = list
        .map((m) => m.contract)
        .filter((c): c is string => Boolean(c))
        .slice(0, 120);
      let scanner: CalendarEvent[] = [];
      if (contracts.length > 0) {
        const r = (await call(`/api/drops?contracts=${contracts.join(",")}`)) as Record<string, unknown>;
        scanner = ((r.drops as ScannedDrop[]) ?? [])
          // A watched address with no stage configured comes back as all
          // zeroes. Merging that would paint an unannounced drop as a free
          // mint starting in 1970, so it waits until the chain says otherwise.
          .filter((d) => d.startTime > 0)
          .map((d) => ({
            id: "",
            source: "scanner",
            name: d.name ?? `${d.contract.slice(0, 10)}…`,
            contract: d.contract,
            startsAt: d.startTime,
            endsAt: d.endTime || undefined,
            priceWei: d.priceWei,
            supply: d.maxSupply,
            minted: d.minted,
            perWallet: d.maxPerWallet,
          }));
      }

      const t = Math.floor(Date.now() / 1000);
      // The previous merge is the baseline that keeps event ids stable, and
      // the store is where it lives now.
      const merged = mergeCalendar(manual, scanner, tz.offsetMin, t, store.getState().data.events);
      // Which watchlist row each event came from — recolour and remove both
      // need the id, and the merge does not carry it.
      const byKey: Record<string, string> = {};
      for (const e of merged) {
        // A contract is the real identity. Falling back to the name for an
        // event that has one could bind the row to a different drop that
        // happens to share it — half the collections here are called "Genesis".
        const hit = e.contract
          ? list.find((m) => m.contract?.toLowerCase() === e.contract!.toLowerCase())
          : list.find(
              (m) => !m.contract && m.name.trim().toLowerCase() === e.name.trim().toLowerCase(),
            );
        if (hit) byKey[e.id] = hit.id;
      }
      store.set({ events: merged, ids: byKey });
      setNow(t);
    }
  }, [call, save, tz.offsetMin]);

  // The store keeps the fetcher, so the URL and the token have to be pushed
  // down whenever they change.
  useEffect(() => {
    store.setFetcher(base && token ? load : null);
  }, [load, base, token]);

  /**
   * Opening the tab draws what is already held and reads again only if it has
   * gone stale, underneath the rows rather than instead of them.
   */
  useEffect(() => {
    if (base && token && store.isStale()) void store.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One interval for every countdown on the page, not one per row.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(
    () =>
      events
        .filter((e) => !hidden.has(e.id))
        .filter((e) => showEnded || statusOf(e, now) !== "ended"),
    [events, hidden, showEnded, now],
  );

  /** Handles for the rows on screen — the followers filter needs them. */
  useEffect(() => {
    const wanted = visible
      .map((e) => e.contract)
      .filter((c): c is string => Boolean(c) && !(c!.toLowerCase() in info))
      .slice(0, 40);
    if (!base || !token || wanted.length === 0) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = (await call(`/api/collection-info?contracts=${wanted.join(",")}`)) as unknown as {
          known?: Record<string, CollectionInfo>;
        };
        if (alive && r.known) store.set({ info: { ...store.getState().data.info, ...r.known } });
      } catch {
        // An older server has no such route; the column simply stays unknown.
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [visible, info, base, token, call]);

  const groups = useMemo(() => groupByDay(visible, now, tz.offsetMin), [visible, now, tz.offsetMin]);
  const days = useMemo(() => weekDays(weekFrom, tz.offsetMin), [weekFrom, tz.offsetMin]);
  const chosen = useMemo(() => visible.find((e) => e.id === selected), [visible, selected]);

  const counts = useMemo(() => {
    const of = (s: EventStatus) => visible.filter((e) => statusOf(e, now) === s).length;
    return { live: of("live"), soon: of("soon"), total: visible.length };
  }, [visible, now]);

  /** Out of sight, still on the watchlist. Lives in this browser only. */
  function hide(id: string) {
    store.set({ hidden: new Set([...hidden, id]) });
    setSelected(null);
  }

  /**
   * Paint a row, on the server, so the choice follows you to the phone.
   *
   * The event moves colour immediately and the request follows: waiting for a
   * round trip to see a swatch change would make the picker feel broken. A
   * failed write shows up on the next load, when the row goes back.
   */
  async function recolor(eventId: string, color: Pickable) {
    const listId = ids[eventId];
    if (!listId) return;
    store.set({
      events: store
        .getState()
        .data.events.map((e) =>
          e.id === eventId ? { ...e, color: color === "auto" ? undefined : color } : e,
        ),
    });
    try {
      await call(`/api/upcoming?id=${encodeURIComponent(listId)}`, {
        method: "PATCH",
        body: JSON.stringify({ color }),
      });
      notifyWatchlistChanged(store);
    } catch (e) {
      store.setError(e instanceof Error ? e.message : String(e));
      void store.run();
    }
  }

  /**
   * Write the note, the same way a colour is written.
   *
   * Shown at once and sent after, for the same reason: a round trip before
   * the words appear reads as a box that ate them.
   */
  async function annotate(eventId: string, note: string) {
    const listId = ids[eventId];
    if (!listId) return;
    store.set({
      events: store
        .getState()
        .data.events.map((e) => (e.id === eventId ? { ...e, note: note || undefined } : e)),
    });
    try {
      await call(`/api/upcoming?id=${encodeURIComponent(listId)}`, {
        method: "PATCH",
        body: JSON.stringify({ note }),
      });
      notifyWatchlistChanged(store);
    } catch (e) {
      store.setError(e instanceof Error ? e.message : String(e));
      void store.run();
    }
  }

  /** Off the watchlist entirely — this is the one action that loses data. */
  async function forget(eventId: string) {
    const listId = ids[eventId];
    if (!listId) return;
    const e = events.find((x) => x.id === eventId);
    if (!window.confirm(`Remove ${e?.name ?? "this drop"} from the watchlist? It disappears from Telegram too.`)) {
      return;
    }
    try {
      await call(`/api/upcoming?id=${encodeURIComponent(listId)}`, { method: "DELETE" });
      notifyWatchlistChanged(store);
      setSelected(null);
      // Struck off here as well as on the server. A refresh already in flight
      // was started before the delete and would put the row back, and waiting
      // for a round trip to watch a row you just removed disappear reads as a
      // button that did nothing.
      store.set({ events: store.getState().data.events.filter((x) => x.id !== eventId) });
      await store.run();
    } catch (err) {
      store.setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>Calendar — what you are watching</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Only what is on your watchlist, so nothing here is noise. The chain
          fills in price, supply and the real start for anything with a
          contract; what you typed wins where the two disagree. Free mints and
          paid ones are told apart by colour, and you can override that per row.
          Discovery lives in the scanner.
        </p>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 2, minWidth: 200 }}>
            <label>server URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-tunnel.trycloudflare.com"
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label>token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="SNIPE_TOKEN"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="scan-bar">
          <span className="bar-label">VIEW</span>
          <div className="chip-group">
            <button
              className={view === "week" ? "secondary active-chip" : "secondary"}
              onClick={() => setView("week")}
            >
              week
            </button>
            <button
              className={view === "list" ? "secondary active-chip" : "secondary"}
              onClick={() => setView("list")}
            >
              list
            </button>
            <button
              className="secondary"
              disabled={busy || !base || !token}
              onClick={() => void store.run()}
            >
              {busy ? <span className="spin">READING</span> : "refresh"}
            </button>
          </div>
          <div className="chip-group">
            <button
              className={adding ? "secondary active-chip" : "secondary"}
              onClick={() => setAdding(!adding)}
              title="Put something on the calendar by hand"
            >
              + add
            </button>
            <button
              className={showEnded ? "secondary active-chip" : "secondary"}
              onClick={() => setShowEnded(!showEnded)}
            >
              show ended
            </button>
            {hidden.size > 0 ? (
              <button className="secondary" onClick={() => store.set({ hidden: new Set() })}>
                unhide {hidden.size}
              </button>
            ) : null}
          </div>
          <div className="bar-tail">
            <span className="pill">{tz.label}</span>
            <span className="pill ok">
              {counts.total} ahead
              {counts.live ? ` · ${counts.live} live` : ""}
            </span>
          </div>
        </div>

        {adding ? (
          <AddEvent
            busy={busy}
            onAdd={async (draft) => {
              await call("/api/upcoming", { method: "POST", body: JSON.stringify(draft) });
              notifyWatchlistChanged();
              setAdding(false);
              await store.run();
            }}
          />
        ) : null}

        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />

        {view === "week" && visible.length > 0 ? (
          <>
            <div className="scan-bar" style={{ marginBottom: 0 }}>
              <div className="chip-group">
                <button className="secondary" onClick={() => setWeekFrom(weekFrom - 7 * 86_400)}>
                  ← prev
                </button>
                <button className="secondary" onClick={() => setWeekFrom(Math.floor(Date.now() / 1000))}>
                  this week
                </button>
                <button className="secondary" onClick={() => setWeekFrom(weekFrom + 7 * 86_400)}>
                  next →
                </button>
              </div>
            </div>
            <WeekGrid
              days={days}
              events={visible}
              now={now}
              tzOffsetMin={tz.offsetMin}
              onPick={setSelected}
            />
          </>
        ) : null}

        {view === "list" && groups.length > 0 ? (
          <div className="cal-list">
            {groups.map((g) => (
              <section key={g.day}>
                <h3 className="cal-day">
                  {g.label}
                  <span className="dim"> · {g.events.length}</span>
                </h3>
                {g.events.map((e) => {
                  const st = statusOf(e, now);
                  return (
                    <div
                      key={e.id}
                      className={`cal-row ${colorClass(e)}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(e.id)}
                      onKeyDown={(k) => {
                        if (k.key === "Enter" || k.key === " ") setSelected(e.id);
                      }}
                    >
                      <span className={`cal-when ${STATUS_CLASS[st]}`}>
                        {st === "live" ? (
                          <>
                            <span className="tick" /> LIVE NOW
                          </>
                        ) : st === "undated" ? (
                          "no date"
                        ) : st === "ended" ? (
                          "ended"
                        ) : (
                          `in ${countdown(e.startsAt - now)}`
                        )}
                      </span>
                      <span className="cal-name">
                        {e.name}
                        {e.rescheduledAt && now - e.rescheduledAt < 86_400 ? (
                          <span className="pill-resched">RESCHEDULED</span>
                        ) : null}
                        {e.source === "manual" ? <span className="pill-src">MANUAL</span> : null}
                        {e.source === "both" ? <span className="pill-src ok">ON-CHAIN</span> : null}
                      </span>
                      <span className="cal-time dim">{e.startsAt ? timeOf(e.startsAt) : "—"}</span>
                      <span className="cal-price">
                        {e.priceWei === undefined ? (
                          <span className="dim">?</span>
                        ) : BigInt(e.priceWei) === 0n ? (
                          <span className="ok">FREE</span>
                        ) : (
                          formatEther(BigInt(e.priceWei))
                        )}
                      </span>
                      <span className="cal-supply dim">
                        {e.supply === undefined ? "—" : e.supply.toLocaleString("en-US")}
                      </span>
                      <span className="cal-tw dim">
                        {e.twitter ? `@${e.twitter}` : "—"}
                      </span>
                      <span className="cal-act" onClick={(ev) => ev.stopPropagation()}>
                        <ColorPicker
                          value={(e.color as Pickable | undefined) ?? "auto"}
                          onPick={(c) => void recolor(e.id, c)}
                        />
                      </span>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        ) : null}

        {visible.length === 0 && !busy ? (
          <div className="empty-state">
            {events.length > 0 ? (
              <>
                EVERYTHING HERE HAS ENDED —{" "}
                <span className="es-action">TURN ON &quot;SHOW ENDED&quot;</span>
              </>
            ) : (
              <>
                WATCHLIST IS EMPTY —{" "}
                <span className="es-action">ADD ONE ABOVE, OR WATCH A DROP FROM THE SCANNER</span>
              </>
            )}
          </div>
        ) : null}

        <p className="dim hint" style={{ marginBottom: 0 }}>
          Your watchlist, with the public stage read straight off the chain for
          anything that has a contract. Times are yours ({tz.label}); a drop at
          23:30 UTC lands on the day it happens where you are, not where the
          server is.
        </p>
      </div>

      {chosen ? (
        <EventDrawer
          event={chosen}
          now={now}
          openSeaSlug={openSeaSlug}
          onClose={() => setSelected(null)}
          onHide={() => hide(chosen.id)}
          onRecolor={(c) => void recolor(chosen.id, c)}
          onNote={ids[chosen.id] ? (n) => annotate(chosen.id, n) : undefined}
          onForget={ids[chosen.id] ? () => void forget(chosen.id) : undefined}
        />
      ) : null}
    </div>
  );
}

/**
 * Seven columns, midnight at the top, a line across the current time.
 *
 * Overlaps sit side by side rather than on top of each other: two drops at the
 * same minute is the normal case on a busy day, and one hiding the other is
 * the one thing a calendar must not do.
 */
/**
 * Six colours and "auto".
 *
 * Deliberately a fixed palette rather than a colour input: the value is shared
 * through the watchlist and rendered as a class, so it has to survive a theme
 * change and must never be arbitrary text. Six is enough to group a week and
 * few enough to tell apart at a glance.
 */
/**
 * Put something on the calendar by hand.
 *
 * The same three fields the Telegram bot asks for, because they go to the same
 * place: a drop is worth watching once you know what it is called, where to
 * find it, and roughly when. A contract is optional — half of what belongs on
 * this calendar is a Twitter account and a date, and the contract fills itself
 * in when the chain finally has one.
 */
function AddEvent({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (draft: { name: string; twitter: string; contract?: string; when?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [where, setWhere] = useState("");
  const [when, setWhen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isContract = /^0x[0-9a-fA-F]{40}$/.test(where.trim());

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("give it a name");
      return;
    }
    setSaving(true);
    try {
      await onAdd({
        name: name.trim(),
        twitter: isContract ? "" : where.trim(),
        contract: isContract ? where.trim() : undefined,
        when: when.trim() || undefined,
      });
      setName("");
      setWhere("");
      setWhen("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="add-event">
      <div className="filter-grid">
        <div className="field">
          <label>name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pipe Dogs" />
        </div>
        <div className="field">
          <label>contract or twitter</label>
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            placeholder="0x… or @handle"
          />
        </div>
        <div className="field">
          <label>when</label>
          <input
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            placeholder="1.9 18:00, tomorrow, or blank"
          />
        </div>
      </div>
      <div className="row" style={{ gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button className="primary" disabled={busy || saving} onClick={() => void submit()}>
          {saving ? "ADDING…" : "ADD TO THE CALENDAR"}
        </button>
        <span className="dim hint" style={{ margin: 0 }}>
          {isContract
            ? "A contract — price, supply and the real start will be read off the chain."
            : "No contract yet? A handle and a date are enough; the rest fills itself in later."}
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function WeekGrid({
  days,
  events,
  now,
  tzOffsetMin,
  onPick,
}: {
  days: number[];
  events: readonly CalendarEvent[];
  now: number;
  tzOffsetMin: number;
  onPick: (id: string) => void;
}) {
  const today = localMidnight(now, tzOffsetMin);
  return (
    <div className="week-grid">
      <div className="week-axis">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} style={{ top: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, "0")}
          </span>
        ))}
      </div>
      {days.map((day) => {
        const inDay = events.filter((e) => e.startsAt && localMidnight(e.startsAt, tzOffsetMin) === day);
        return (
          <div key={day} className={`week-col${day === today ? " is-today" : ""}`}>
            <div className="week-head">
              {new Date(day * 1000).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
              })}
              {inDay.length ? <span className="dim"> · {inDay.length}</span> : null}
            </div>
            <div className="week-body">
              {day === today ? (
                <div className="week-now" style={{ top: `${dayFraction(now, day) * 100}%` }} />
              ) : null}
              {layoutDay(inDay).map(({ event: e, lane, lanes }) => {
                const st = statusOf(e, now);
                return (
                  <button
                    key={e.id}
                    className={`week-ev ${STATUS_CLASS[st]} ${colorClass(e)}`}
                    style={{
                      top: `${dayFraction(e.startsAt, day) * 100}%`,
                      left: `${(lane / lanes) * 100}%`,
                      width: `${100 / lanes}%`,
                    }}
                    onClick={() => onPick(e.id)}
                    title={`${e.name} · ${timeOf(e.startsAt)}`}
                  >
                    <span className="we-time">{timeOf(e.startsAt)}</span>
                    <span className="we-name">{e.name}</span>
                    {e.priceWei !== undefined && BigInt(e.priceWei) === 0n ? (
                      <span className="we-free">FREE</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Everything known about one event, and the things worth doing about it. */
function EventDrawer({
  event: e,
  now,
  openSeaSlug,
  onClose,
  onHide,
  onRecolor,
  onNote,
  onForget,
}: {
  event: CalendarEvent;
  now: number;
  openSeaSlug?: string;
  onClose: () => void;
  onHide: () => void;
  onRecolor: (c: Pickable) => void;
  /** Absent for a row the watchlist does not own — nowhere to store a note. */
  onNote?: (note: string) => Promise<void>;
  /** Absent for a row the watchlist does not own — nothing to strike off. */
  onForget?: () => void;
}) {
  const st = statusOf(e, now);
  // Local to the drawer, so reopening a different event starts unpressed.
  const [sent, setSent] = useState(false);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <h3>{e.name}</h3>
            <span className={`pill ${st === "live" ? "ok" : st === "soon" ? "warn" : ""}`}>
              {st === "live" ? "LIVE NOW" : st === "undated" ? "NOT DATED" : st.toUpperCase()}
            </span>{" "}
            <span className="pill-src">
              {e.source === "manual" ? "MANUAL" : e.source === "both" ? "ON-CHAIN" : "SCANNER"}
            </span>
          </div>
          <button className="secondary link-btn" onClick={onClose}>
            close
          </button>
        </div>

        <dl className="kv">
          <dt>starts</dt>
          <dd>
            {e.startsAt ? (
              <>
                {new Date(e.startsAt * 1000).toLocaleString()}
                <span className="dim">
                  {" "}
                  · {st === "live" || st === "ended" ? "" : `in ${countdown(e.startsAt - now)}`}
                </span>
              </>
            ) : (
              <span className="dim">nobody has said</span>
            )}
          </dd>
          {e.endsAt ? (
            <>
              <dt>ends</dt>
              <dd>{new Date(e.endsAt * 1000).toLocaleString()}</dd>
            </>
          ) : null}
          <dt>price</dt>
          <dd>
            {e.priceWei === undefined ? (
              <span className="dim">not read</span>
            ) : BigInt(e.priceWei) === 0n ? (
              <span className="ok">free</span>
            ) : (
              formatEther(BigInt(e.priceWei))
            )}
          </dd>
          <dt>supply</dt>
          <dd>
            {e.supply === undefined ? (
              <span className="dim">not read</span>
            ) : (
              <>
                {e.supply.toLocaleString("en-US")}
                {e.minted !== undefined ? (
                  <span className="dim"> · {e.minted.toLocaleString("en-US")} minted</span>
                ) : null}
              </>
            )}
          </dd>
          {e.perWallet ? (
            <>
              <dt>per wallet</dt>
              <dd>{e.perWallet}</dd>
            </>
          ) : null}
          {e.contract ? (
            <>
              <dt>contract</dt>
              <dd>
                <Addr value={e.contract} head={12} />
              </dd>
            </>
          ) : null}
          {e.twitter ? (
            <>
              <dt>twitter</dt>
              <dd>
                <a href={twitterUrl(e.twitter)} target="_blank" rel="noreferrer">
                  @{e.twitter}
                </a>
              </dd>
            </>
          ) : null}
        </dl>

        <div className="drawer-actions">
          {e.contract ? (
            <>
              <button
                className={sent ? "secondary active-chip" : "primary"}
                title="Send it to the Snipe tab. This drawer stays where it is."
                onClick={() => {
                  setPendingTarget(e.contract!);
                  setSent(true);
                }}
              >
                {sent ? "SENT TO SNIPE ✓" : "SEND TO SNIPE"}
              </button>
              <a
                className="secondary btn-like"
                href={openSeaCollectionUrlBySlug(openSeaSlug, e.contract)}
                target="_blank"
                rel="noreferrer"
              >
                OPEN ON OPENSEA →
              </a>
            </>
          ) : (
            <p className="dim" style={{ margin: 0 }}>
              No contract yet — nothing to aim at until the drop is configured
              on-chain. It will fill itself in when the scanner finds it.
            </p>
          )}
          <div className="drawer-colour">
            <span className="bar-label">COLOUR</span>
            <ColorPicker value={(e.color as Pickable | undefined) ?? "auto"} onPick={onRecolor} />
            <span className="dim hint" style={{ margin: 0 }}>
              auto tells free mints from paid ones
            </span>
          </div>
          {onNote ? (
            <div className="drawer-note">
              <span className="bar-label">NOTE</span>
              <NoteBox value={e.note} onSave={onNote} />
            </div>
          ) : null}
          <button className="secondary" onClick={onHide} title="Just this browser. Nothing is deleted.">
            HIDE FROM THE CALENDAR
          </button>
          {onForget ? (
            <button className="secondary danger-btn" onClick={onForget}>
              REMOVE FROM THE WATCHLIST
            </button>
          ) : null}
        </div>
      </aside>
    </>
  );
}
