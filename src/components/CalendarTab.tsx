/**
 * What is coming, on a calendar.
 *
 * Everything here already existed somewhere: the scanner knows about stages
 * configured on-chain, the watchlist knows about what a person typed in, and
 * neither knew about the other. This is the two of them on one timeline, so a
 * drop entered from a phone three days ago and the same drop found on-chain
 * this morning are one row rather than two.
 *
 * No third store. The merge happens in the browser from the two endpoints that
 * already exist, which is the only reason this is one file and not a schema
 * migration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import {
  applyCalendarFilter,
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
import { classify, type ScannedDrop } from "../lib/dropScan";
import type { CollectionInfo } from "../lib/collectionInfo";
import WatchButton from "./WatchButton";
import { twitterUrl } from "../lib/collectionInfo";
import type { UpcomingMint } from "../lib/upcoming";
import { openSeaCollectionUrlBySlug } from "../chains";
import { setPendingTarget } from "../lib/snipeTarget";
import Addr from "./Addr";
import StaleServer from "./StaleServer";

type View = "list" | "week";

/** How far ahead to look. A week of chain is the scanner's widest window. */
const SCAN_HOURS = 168;

const STATUS_CLASS: Record<EventStatus, string> = {
  live: "ok",
  soon: "warn",
  upcoming: "",
  undated: "dim",
  ended: "dim",
};

/** A price box that stays empty rather than filtering on a typo. */
function safeEther(text: string): bigint | undefined {
  try {
    return parseEther(text as `${number}`);
  } catch {
    return undefined;
  }
}

function numberOrUndefined(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

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

export default function CalendarTab({
  onSnipe,
}: {
  onSnipe?: (contract: string) => void;
}) {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(() =>
    typeof window !== "undefined" && window.innerWidth < 900 ? "list" : "week",
  );
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [openSeaSlug, setOpenSeaSlug] = useState<string | undefined>();
  const [freeOnly, setFreeOnly] = useState(false);
  const [withTwitter, setWithTwitter] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [watchedOnly, setWatchedOnly] = useState(false);
  const [maxPrice, setMaxPrice] = useState("");
  const [minSupply, setMinSupply] = useState("");
  const [maxSupply, setMaxSupply] = useState("");
  const [minFollowers, setMinFollowers] = useState("");
  /** Handles and floors, the same lookup the scanner uses. */
  const [info, setInfo] = useState<Record<string, CollectionInfo>>({});
  const [watching, setWatching] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [weekFrom, setWeekFrom] = useState(() => Math.floor(Date.now() / 1000));
  const prior = useRef<CalendarEvent[]>([]);

  const tz = useMemo(tzChip, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      save();
      // Both sources at once: neither depends on the other, and this is the
      // difference between one wait and two.
      const [scan, watch] = await Promise.all([
        call(`/api/scan?hours=${SCAN_HOURS}`) as Promise<Record<string, unknown>>,
        call("/api/upcoming") as Promise<Record<string, unknown>>,
      ]);

      const drops = ((scan.drops as ScannedDrop[]) ?? []).filter(
        (d) => classify(d, Math.floor(Date.now() / 1000)) !== "ended",
      );
      const scanner: CalendarEvent[] = drops.map((d) => ({
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

      const manual: CalendarEvent[] = ((watch.upcoming as UpcomingMint[]) ?? []).map((m) => ({
        id: "",
        source: "manual",
        name: m.name,
        contract: m.contract,
        startsAt: m.at ?? 0,
        supply: m.supply,
        twitter: m.twitter ? m.twitter.replace(/^https?:\/\/(www\.)?x\.com\//i, "") : null,
      }));

      const t = Math.floor(Date.now() / 1000);
      const merged = mergeCalendar(manual, scanner, tz.offsetMin, t, prior.current);
      prior.current = merged;
      setEvents(merged);
      // What is already on the watchlist, so a row can say so rather than
      // letting you add it twice.
      setWatching(
        new Set(
          ((watch.upcoming as UpcomingMint[]) ?? [])
            .map((m) => m.contract?.toLowerCase())
            .filter((c): c is string => Boolean(c)),
        ),
      );
      setOpenSeaSlug(scan.openSeaSlug as string | undefined);
      setNow(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /404/.test(msg) ? "This server is too old for the calendar — update it first." : msg,
      );
    } finally {
      setBusy(false);
    }
  }, [call, save, tz.offsetMin]);

  useEffect(() => {
    if (base && token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One interval for every countdown on the page, not one per row.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(() => {
    const price = maxPrice.trim();
    let out = applyCalendarFilter(events, {
      freeOnly,
      withTwitter,
      hidden,
      maxPriceWei: price ? safeEther(price) : undefined,
      minSupply: numberOrUndefined(minSupply),
      maxSupply: numberOrUndefined(maxSupply),
    }).filter((e) => showEnded || statusOf(e, now) !== "ended");

    // Two conditions that depend on what the browser worked out rather than
    // on the event itself, so they cannot live in the pure filter.
    const followers = numberOrUndefined(minFollowers);
    if (followers !== undefined) {
      out = out.filter((e) => (info[e.contract?.toLowerCase() ?? ""]?.followers ?? -1) >= followers);
    }
    if (watchedOnly) out = out.filter((e) => e.contract && watching.has(e.contract.toLowerCase()));
    return out;
  }, [
    events, freeOnly, withTwitter, hidden, showEnded, now,
    maxPrice, minSupply, maxSupply, minFollowers, watchedOnly, info, watching,
  ]);

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
        if (alive && r.known) setInfo((prev) => ({ ...prev, ...r.known }));
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

  const bounded =
    maxPrice.trim() !== "" ||
    minSupply.trim() !== "" ||
    maxSupply.trim() !== "" ||
    minFollowers.trim() !== "" ||
    freeOnly ||
    withTwitter ||
    watchedOnly;

  function clearFilters() {
    setMaxPrice("");
    setMinSupply("");
    setMaxSupply("");
    setMinFollowers("");
    setFreeOnly(false);
    setWithTwitter(false);
    setWatchedOnly(false);
  }

  function hide(id: string) {
    setHidden(new Set([...hidden, id]));
    setSelected(null);
  }

  return (
    <div>
      <div className="panel">
        <h2>Calendar — what is coming</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          The scanner&apos;s on-chain stages and the watchlist&apos;s typed
          entries on one timeline. A drop entered from a phone and the same drop
          found on-chain later are one row, not two — what you typed wins where
          the two disagree, and the chain fills in the rest.
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
            <button className="secondary" disabled={busy || !base || !token} onClick={() => void load()}>
              {busy ? <span className="spin">READING</span> : "refresh"}
            </button>
          </div>
          <div className="bar-tail">
            <span className="pill">{tz.label}</span>
            <span className="pill ok">
              {counts.total} ahead
              {counts.live ? ` · ${counts.live} live` : ""}
            </span>
          </div>
        </div>

        {/* The same shape the scanner's filters have: chips for the yes/no
            ones, boxes for the numbers, and everything stacks. */}
        <div className="scan-filters">
          <div className="scan-bar">
            <span className="bar-label">SHOW</span>
            <div className="chip-group">
              <button
                className={freeOnly ? "secondary active-chip" : "secondary"}
                onClick={() => setFreeOnly(!freeOnly)}
              >
                free only
              </button>
              <button
                className={withTwitter ? "secondary active-chip" : "secondary"}
                onClick={() => setWithTwitter(!withTwitter)}
              >
                has twitter
              </button>
              <button
                className={watchedOnly ? "secondary active-chip" : "secondary"}
                onClick={() => setWatchedOnly(!watchedOnly)}
                title="Only what is already on your watchlist"
              >
                watching
              </button>
              <button
                className={showEnded ? "secondary active-chip" : "secondary"}
                onClick={() => setShowEnded(!showEnded)}
              >
                show ended
              </button>
            </div>
            <div className="bar-tail">
              {hidden.size > 0 ? (
                <button className="secondary" onClick={() => setHidden(new Set())}>
                  unhide {hidden.size}
                </button>
              ) : null}
              {bounded ? (
                <button className="secondary link-btn" onClick={clearFilters}>
                  clear filters
                </button>
              ) : null}
            </div>
          </div>
          <div className="filter-grid">
            <div className="field">
              <label>max price</label>
              <input
                inputMode="decimal"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder="any"
              />
            </div>
            <div className="field">
              <label>supply from</label>
              <input
                inputMode="numeric"
                value={minSupply}
                onChange={(e) => setMinSupply(e.target.value)}
                placeholder="any"
              />
            </div>
            <div className="field">
              <label>supply to</label>
              <input
                inputMode="numeric"
                value={maxSupply}
                onChange={(e) => setMaxSupply(e.target.value)}
                placeholder="any"
              />
            </div>
            <div className="field">
              <label>followers ≥</label>
              <input
                inputMode="numeric"
                value={minFollowers}
                onChange={(e) => setMinFollowers(e.target.value)}
                placeholder="any"
              />
            </div>
          </div>
        </div>

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
                      className={`cal-row${
                        e.contract && watching.has(e.contract.toLowerCase()) ? " is-watched" : ""
                      }`}
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
                      <span className="cal-act">
                        {e.contract ? (
                          watching.has(e.contract.toLowerCase()) ? (
                            <span className="pill-watching" title="already on your watchlist">
                              WATCHING
                            </span>
                          ) : (
                            <WatchButton
                              draft={{
                                name: e.name,
                                contract: e.contract,
                                twitter: e.twitter,
                                supply: e.supply,
                                startTime: e.startsAt || undefined,
                              }}
                              onAdded={() =>
                                setWatching(new Set([...watching, e.contract!.toLowerCase()]))
                              }
                            />
                          )
                        ) : null}
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
                NOTHING MATCHES —{" "}
                <span className="es-action">LOOSEN THE FILTERS ABOVE</span>
              </>
            ) : (
              <>
                NOTHING SCHEDULED —{" "}
                <span className="es-action">SCAN FINDS STAGES; THE WATCHLIST HOLDS THE REST</span>
              </>
            )}
          </div>
        ) : null}

        <p className="dim hint" style={{ marginBottom: 0 }}>
          Read {SCAN_HOURS}h of configured stages plus everything on the
          watchlist. Times are yours ({tz.label}); a drop at 23:30 UTC lands on
          the day it happens where you are, not where the server is.
        </p>
      </div>

      {chosen ? (
        <EventDrawer
          event={chosen}
          now={now}
          openSeaSlug={openSeaSlug}
          onClose={() => setSelected(null)}
          onHide={() => hide(chosen.id)}
          onSnipe={onSnipe}
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
                    className={`week-ev ${STATUS_CLASS[st]}`}
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
  onSnipe,
}: {
  event: CalendarEvent;
  now: number;
  openSeaSlug?: string;
  onClose: () => void;
  onHide: () => void;
  onSnipe?: (contract: string) => void;
}) {
  const st = statusOf(e, now);
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
                className="primary"
                onClick={() => {
                  setPendingTarget(e.contract!);
                  onSnipe?.(e.contract!);
                }}
              >
                OPEN IN SNIPE
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
          <button className="secondary" onClick={onHide}>
            HIDE FROM THE CALENDAR
          </button>
        </div>
      </aside>
    </>
  );
}
