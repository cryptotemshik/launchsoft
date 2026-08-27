/**
 * Drops that haven't happened yet.
 *
 * They get spotted on a phone, scrolling Twitter, hours before there is an
 * OpenSea page or a contract to paste anywhere — which is why the bot exists
 * and why `/add` there takes the four things worth knowing.
 *
 * The same four can be typed here, because the phone is not always where you
 * are. Both routes end in the same `buildUpcoming`, so a name the bot accepts
 * cannot be one this form rejects.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { sortByDate, twitterHandle, type UpcomingMint } from "../lib/upcoming";
import { setPendingTarget } from "../lib/snipeTarget";
import Addr from "./Addr";
import CopyButton from "./CopyButton";
import { openSeaCollectionUrlBySlug } from "../chains";
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

/** A start time in the format the date parser reads back. */
function whenInput(at: number): string {
  const d = new Date(at * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function whenLabel(m: UpcomingMint): string {
  if (m.at === undefined) return "not announced";
  const d = new Date(m.at * 1000);
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (m.dayOnly) return day;
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

export default function UpcomingTab({ onSnipe }: { onSnipe?: (contract: string) => void }) {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [list, setList] = useState<UpcomingMint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<SortKey>("date");
  const [desc, setDesc] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", twitter: "", contract: "", supply: "", when: "" });
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [slug, setSlug] = useState<string | undefined>();
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      save();
      const r = (await call("/api/upcoming")) as unknown as {
        upcoming?: UpcomingMint[];
        openSeaSlug?: string;
      };
      setList(Array.isArray(r.upcoming) ? r.upcoming : []);
      setSlug(r.openSeaSlug);
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

  /**
   * Fill the form in from the chain once a contract is typed.
   *
   * Everything else on the form is readable from the address — the name and
   * supply from the contract, the start from its public stage, the handle from
   * the marketplace — so asking for them again is asking someone to copy what
   * the machine could fetch. Only blank fields are filled: what you have
   * already typed is what you meant, and an autofill that overwrites it is
   * worse than none.
   */
  useEffect(() => {
    const c = draft.contract.trim();
    if (!adding || !base || !token || !/^0x[0-9a-fA-F]{40}$/.test(c)) {
      setFound(null);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      setLooking(true);
      try {
        const r = (await call(`/api/collection-preview?contract=${c}`)) as unknown as {
          name?: string;
          maxSupply?: string;
          startTime?: number;
          twitter?: string | null;
          onChain?: boolean;
        };
        if (!alive) return;
        setDraft((d) => ({
          ...d,
          name: d.name.trim() || r.name || d.name,
          twitter: d.twitter.trim() || r.twitter || d.twitter,
          supply: d.supply.trim() || (r.maxSupply && r.maxSupply !== "0" ? r.maxSupply : d.supply),
          when: d.when.trim() || (r.startTime ? whenInput(r.startTime) : d.when),
        }));
        setFound(
          r.onChain
            ? `read ${r.name ?? "the collection"}${r.twitter ? ` · @${r.twitter}` : " · no account connected"}`
            : "nothing configured on-chain for that address yet — fill the rest in by hand",
        );
      } catch {
        if (alive) setFound(null);
      } finally {
        if (alive) setLooking(false);
      }
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Only the address drives this: re-running it as the other fields are
    // typed would fight whoever is typing them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.contract, adding, base, token, call]);

  const add = useCallback(async () => {
    setAddBusy(true);
    setAddError(null);
    try {
      const r = (await call("/api/upcoming", {
        method: "POST",
        body: JSON.stringify(draft),
      })) as unknown as { upcoming?: UpcomingMint[] };
      setList(Array.isArray(r.upcoming) ? r.upcoming : []);
      setDraft({ name: "", twitter: "", contract: "", supply: "", when: "" });
      setAdding(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAddError(
        /404/.test(msg) ? "This server is too old to add from here — update it first." : msg,
      );
    } finally {
      setAddBusy(false);
    }
  }, [call, draft]);

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
        <h2>Watchlist — drops to come back to</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Drops worth coming back to. Some are only an account and a rumour,
          with no contract to paste anywhere yet; others came from the scanner
          or the feed and already have one, and those carry a <b>snipe</b>
          button straight through. Add them from the phone through the Telegram
          bot, from the rows in Scanner and Live, or by hand here.
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
        {adding ? (
          <form
            className="add-upcoming"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="filter-grid">
              <div className="field" style={{ gridColumn: "span 2" }}>
                <label>name</label>
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Pipe Dogs"
                />
              </div>
              <div className="field" style={{ gridColumn: "span 2" }}>
                <label>twitter</label>
                <input
                  value={draft.twitter}
                  onChange={(e) => setDraft({ ...draft, twitter: e.target.value })}
                  placeholder="@pipedogsnft or a link"
                />
              </div>
              <div className="field" style={{ gridColumn: "span 2" }}>
                <label>contract</label>
                <input
                  value={draft.contract}
                  onChange={(e) => setDraft({ ...draft, contract: e.target.value })}
                  placeholder="0x… — the rest fills itself in"
                />
              </div>
              <div className="field">
                <label>supply</label>
                <input
                  inputMode="numeric"
                  value={draft.supply}
                  onChange={(e) => setDraft({ ...draft, supply: e.target.value })}
                  placeholder="not announced"
                />
              </div>
              <div className="field">
                <label>when</label>
                <input
                  value={draft.when}
                  onChange={(e) => setDraft({ ...draft, when: e.target.value })}
                  placeholder="01.09 18:00, or blank"
                />
              </div>
            </div>
            {looking ? (
              <p className="dim" style={{ margin: "6px 0 0" }}>
                <span className="spin">reading the contract</span>
              </p>
            ) : found ? (
              <p className="ok" style={{ margin: "6px 0 0", fontSize: 12 }}>
                {found}
              </p>
            ) : null}
            {addError ? <p className="error">{addError}</p> : null}
            <p className="dim hint" style={{ margin: "6px 0 0" }}>
              The name, plus a Twitter or a contract — either is enough to find
              it again, and typing a contract fills the rest in from the chain.
              A blank date means
              &ldquo;not announced&rdquo; — the same as answering TBA in the bot
              — and dates are read the way you would type them: <code>1.9</code>,{" "}
              <code>01.09.2026</code>, either with <code>18:00</code> after it.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button type="submit" disabled={addBusy || !base || !token}>
                {addBusy ? <span className="spin">ADDING</span> : "add to watchlist"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAdding(false);
                  setAddError(null);
                }}
              >
                cancel
              </button>
            </div>
          </form>
        ) : null}

        <div
          style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}
        >
          {!adding ? (
            <button
              className="secondary"
              onClick={() => setAdding(true)}
              disabled={!base || !token}
            >
              + add a drop
            </button>
          ) : null}
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
                      <td data-label="collection" className="cell-clip">
                        {/* The same shape as every other table here: a name
                            that opens the collection, an address you can take
                            with you. A drop with no contract yet has nowhere
                            to go, so its name is text rather than a dead
                            link. */}
                        {m.contract ? (
                          <span className="name-with-copy">
                            <a
                              className="cell-name"
                              href={openSeaCollectionUrlBySlug(slug, m.contract)}
                              target="_blank"
                              rel="noreferrer"
                              title="Open this collection on OpenSea"
                            >
                              {m.name}
                            </a>
                            <CopyButton value={m.contract} />
                          </span>
                        ) : (
                          <span className="cell-name">{m.name}</span>
                        )}
                        <span className="cell-sub dim">
                          {m.contract ? (
                            <Addr value={m.contract} head={8} />
                          ) : (
                            "no contract yet"
                          )}
                        </span>
                      </td>
                      <td data-label="twitter">
                        {m.twitter ? (
                          <a href={m.twitter} target="_blank" rel="noreferrer">
                            {twitterHandle(m.twitter)}
                          </a>
                        ) : (
                          <span className="faint">—</span>
                        )}
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
                        <div className="row-actions">
                          {/* Only once there is something to aim at. A drop
                              that is still just an account has nothing the
                              Snipe tab could read. */}
                          {m.contract ? (
                            <button
                              className="secondary"
                              style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
                              title="Load this collection in the Snipe tab"
                              onClick={() => {
                                setPendingTarget(m.contract!);
                                onSnipe?.(m.contract!);
                              }}
                            >
                              snipe
                            </button>
                          ) : null}
                          <button
                            className="secondary"
                            style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
                            disabled={busy}
                            onClick={() => void remove(m)}
                          >
                            remove
                          </button>
                        </div>
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
            NOTHING ON THE WATCHLIST — <span className="es-action">ADD ONE ABOVE, OR /ADD IN THE BOT</span>
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
