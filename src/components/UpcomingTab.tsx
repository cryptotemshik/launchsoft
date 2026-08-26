/**
 * Drops that haven't happened yet.
 *
 * These are entered through the Telegram bot rather than here, and on purpose:
 * they get spotted on a phone, scrolling Twitter, hours before there is an
 * OpenSea page or a contract to paste anywhere. `/add` in the bot takes the
 * four things worth knowing; this is the window onto what has been collected.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { sortByDate, twitterHandle, type UpcomingMint } from "../lib/upcoming";
import StaleServer from "./StaleServer";

type SortKey = "date" | "name" | "supply";

/** How far off it is, in the words a person would use. */
function until(at: number, now: number): { label: string; tone: string } {
  const secs = at - now;
  if (secs < -3600) return { label: "past", tone: "faint" };
  if (secs < 0) return { label: "now", tone: "live" };
  const mins = Math.round(secs / 60);
  if (mins < 60) return { label: `in ${mins} min`, tone: "soon" };
  const hours = Math.round(secs / 3600);
  if (hours < 48) return { label: `in ${hours} h`, tone: "soon" };
  return { label: `in ${Math.round(secs / 86_400)} days`, tone: "" };
}

function whenLabel(m: UpcomingMint): string {
  if (m.at === undefined) return "not announced";
  const d = new Date(m.at * 1000);
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (m.dayOnly) return day;
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

export default function UpcomingTab() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [list, setList] = useState<UpcomingMint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<SortKey>("date");
  const [desc, setDesc] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      save();
      const r = (await call("/api/upcoming")) as unknown as { upcoming?: UpcomingMint[] };
      setList(Array.isArray(r.upcoming) ? r.upcoming : []);
      setNow(Math.floor(Date.now() / 1000));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /404/.test(msg)
          ? "This server is too old to keep upcoming mints — update it from the Snipe tab."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }, [call, save]);

  useEffect(() => {
    if (base && token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The countdown column would otherwise go stale while the tab sits open.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  async function remove(m: UpcomingMint) {
    if (!confirm(`Remove ${m.name} from the list?`)) return;
    setBusy(true);
    try {
      const r = (await call(`/api/upcoming?id=${encodeURIComponent(m.id)}`, {
        method: "DELETE",
      })) as unknown as { upcoming?: UpcomingMint[] };
      if (Array.isArray(r.upcoming)) setList(r.upcoming);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const all = list ?? [];
    if (sort === "date") return sortByDate(all, desc);
    const dir = desc ? -1 : 1;
    return [...all].sort((a, b) =>
      sort === "name"
        ? dir * a.name.localeCompare(b.name)
        : dir * ((a.supply ?? -1) - (b.supply ?? -1)),
    );
  }, [list, sort, desc]);

  const dated = (list ?? []).filter((m) => m.at !== undefined && m.at > now).length;
  const undated = (list ?? []).filter((m) => m.at === undefined).length;

  function header(key: SortKey, label: string, className = "") {
    return (
      <th
        className={`sortable ${className}`.trim()}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            // Dates read best soonest-first; everything else biggest-first.
            setDesc(key !== "date");
          }
        }}
      >
        {label}
        {sort === key ? (desc ? " ▼" : " ▲") : ""}
      </th>
    );
  }

  return (
    <div>
      <div className="panel">
        <h2>Upcoming mints</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Drops that have a Twitter account and nothing else yet — no OpenSea
          page, no contract, nothing to paste into the Snipe tab. You add them
          from the phone through the Telegram bot; this is the list they land in.
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
        <div
          style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}
        >
          <button
            className="secondary"
            onClick={() => void load()}
            disabled={busy || !base || !token}
          >
            {busy ? <span className="spin">BUSY</span> : list ? "refresh" : "load"}
          </button>
          {list ? (
            <span className="pill ok">
              {dated} scheduled
              {undated ? ` · ${undated} undated` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />

        {list && list.length > 0 ? (
          <div className="table-wrap">
            <table className="ledger-table collapsible">
              <thead>
                <tr>
                  {header("name", "collection")}
                  <th>twitter</th>
                  {header("supply", "supply", "num")}
                  {header("date", "expected")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const near = m.at !== undefined ? until(m.at, now) : null;
                  return (
                    <tr key={m.id} className="project-row">
                      <td data-label="collection">
                        <span className="cell-name">{m.name}</span>
                      </td>
                      <td data-label="twitter">
                        <a href={m.twitter} target="_blank" rel="noreferrer">
                          {twitterHandle(m.twitter)}
                        </a>
                      </td>
                      <td className="num" data-label="supply">
                        {m.supply ? m.supply.toLocaleString("en-US") : <span className="dim">?</span>}
                      </td>
                      <td data-label="expected">
                        {m.at === undefined ? (
                          <span className="pill-tba">TBA</span>
                        ) : (
                          <>
                            <span className="cell-name">{whenLabel(m)}</span>
                            <span className={`cell-sub ${near?.tone === "soon" ? "warn" : "dim"}`}>
                              {near?.label}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="num">
                        <button
                          className="secondary"
                          style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
                          disabled={busy}
                          onClick={() => void remove(m)}
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {list && list.length === 0 ? (
          <div className="empty-state">
            NO UPCOMING MINTS — <span className="es-action">SEND /ADD TO THE TELEGRAM BOT</span>
          </div>
        ) : null}

        <p className="dim hint" style={{ marginBottom: 0 }}>
          <b>In the bot:</b> <code>/add</code> walks through name → Twitter →
          supply → date, where the date can be <code>1.9</code>,{" "}
          <code>01.09.2026</code>, <code>1.9 18:00</code>, or a button for
          &ldquo;not announced&rdquo;. <code>/list</code> shows everything with a
          remove button beside each one.
        </p>
      </div>
    </div>
  );
}
