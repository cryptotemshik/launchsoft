/**
 * What is minting right now.
 *
 * The scanner answers "what opens when" — a schedule. This answers the
 * question that comes after it: of everything currently open, where is the
 * money actually going. SeaDrop announces every mint, so one log query covers
 * the whole chain, and the rows here are that hour of mints grouped by
 * collection and ranked.
 *
 * Ranked by trend rather than by raw rate, because raw rate is the number a
 * wash mint is best at producing. The rate is discounted by how much of it
 * comes from distinct wallets and decays as a collection goes quiet, so a
 * drop taking two hundred mints a minute from a hundred wallets outranks one
 * taking the same from four.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import type { MintPulse } from "../lib/mintPulse";
import { reuseBand, type IndexedCollection } from "../lib/creatorIndex";
import { twitterUrl, type CollectionInfo } from "../lib/collectionInfo";
import { compactCount } from "../lib/twitterStats";
import RelatedPopover, { ReuseBadge, anchorFrom, useRelated } from "./RelatedPopover";
import { openSeaCollectionUrlBySlug } from "../chains";
import { setPendingTarget } from "../lib/snipeTarget";
import { sndFeedTick } from "../lib/sound";
import Addr from "./Addr";
import StaleServer from "./StaleServer";

interface LiveRow {
  contract: `0x${string}`;
  name?: string;
  maxSupply?: number;
  minted?: number;
  owner?: string;
  pulse: MintPulse;
}

interface LiveView {
  rows: LiveRow[];
  hours: number;
  now: number;
  chain: string;
  openSeaSlug?: string;
  cachedAt?: number;
  related?: { owners?: Record<string, IndexedCollection[]>; twitters?: Record<string, IndexedCollection[]> };
}

const INTERVALS = [
  { secs: 0, label: "off" },
  { secs: 15, label: "15s" },
  { secs: 30, label: "30s" },
  { secs: 60, label: "1m" },
] as const;

type SortKey = "trend" | "rate" | "unique" | "minted" | "left";

/** A rate a person reads at a glance: 0.4/min is not "0". */
function fmtRate(perMin: number): string {
  if (perMin <= 0) return "quiet";
  if (perMin < 1) return `${perMin.toFixed(1)}/m`;
  if (perMin < 1000) return `${Math.round(perMin)}/m`;
  return `${(perMin / 1000).toFixed(1)}k/m`;
}

/** OpenSea shows a wallet's collections on its profile page. */
function openSeaProfile(address: string): string {
  return `https://opensea.io/${address}`;
}

function ago(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.round(secs))}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/**
 * The hour's minting as thirty bars.
 *
 * Scaled to the row's own busiest bucket rather than to the whole table: the
 * question a sparkline answers is "is this accelerating or over", and against
 * a global maximum every row but the loudest is a flat line.
 */
function Spark({ spark }: { spark: readonly number[] }) {
  const max = Math.max(1, ...spark);
  return (
    <span className="spark" aria-hidden>
      {spark.map((v, i) => (
        <span key={i} className="spark-bar" style={{ height: `${Math.max(v > 0 ? 12 : 2, (v / max) * 100)}%` }} />
      ))}
    </span>
  );
}

export default function LiveTab({ onSnipe }: { onSnipe?: (contract: string) => void }) {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [view, setView] = useState<LiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [every, setEvery] = useState(30);
  const [nextIn, setNextIn] = useState(0);
  const [sort, setSort] = useState<SortKey>("trend");
  const [hideWash, setHideWash] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [justIn, setJustIn] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<Record<string, CollectionInfo>>({});
  const [twitterRelated, setTwitterRelated] = useState<Record<string, IndexedCollection[]>>({});
  const seen = useRef<Set<string> | null>(null);
  const related = useRelated();

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      save();
      const r = (await call("/api/live")) as unknown as LiveView;
      const rows = r.rows ?? [];
      const ids = new Set(rows.map((x) => x.contract.toLowerCase()));
      if (seen.current) {
        const arrived = [...ids].filter((c) => !seen.current!.has(c));
        if (arrived.length > 0) {
          setJustIn(new Set(arrived));
          sndFeedTick();
        }
      }
      seen.current = ids;
      setView({ ...r, rows });
      setNow(Math.floor(Date.now() / 1000));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /404/.test(msg) ? "This server is too old for the live feed — update it from the Snipe tab." : msg,
      );
    } finally {
      setBusy(false);
    }
  }, [call, save]);

  useEffect(() => {
    if (base && token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Paused while the tab is hidden: a feed left open in a background tab
  // spends its budget on rows nobody is looking at.
  useEffect(() => {
    if (!every || !base || !token) {
      setNextIn(0);
      return;
    }
    setNextIn(every);
    const t = setInterval(() => {
      setNextIn((n) => {
        if (n > 1) return n - 1;
        if (document.visibilityState === "visible") void load();
        return every;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [every, base, token, load]);

  /**
   * The marketplace side of these rows.
   *
   * The same lookup the scanner uses, asked about the collections on screen.
   * It is what makes the handle column — and the count of other drops behind
   * that handle — answerable here at all; the chain knows neither.
   */
  const wanted = useMemo(
    () =>
      (view?.rows ?? [])
        .slice(0, 40)
        .map((r) => r.contract)
        .filter((c) => {
          const have = info[c.toLowerCase()];
          return !have || (have.twitter !== null && have.followers === undefined);
        }),
    [view, info],
  );

  useEffect(() => {
    if (!base || !token || wanted.length === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async (round: number) => {
      try {
        const r = (await call(`/api/collection-info?contracts=${wanted.join(",")}`)) as unknown as {
          known?: Record<string, CollectionInfo>;
          pending?: string[];
          twitters?: Record<string, IndexedCollection[]>;
        };
        if (!alive) return;
        if (r.known && Object.keys(r.known).length > 0) {
          setInfo((prev) => ({ ...prev, ...r.known }));
        }
        if (r.twitters) setTwitterRelated((prev) => ({ ...prev, ...r.twitters }));
        if (r.pending?.length && round < 6) timer = setTimeout(() => void ask(round + 1), 3000);
      } catch {
        // An older server has no such route; the column then says nothing,
        // which is what it should say when nothing is known.
      }
    };
    timer = setTimeout(() => void ask(0), 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wanted, base, token, call]);

  const rows = useMemo(() => {
    const all = view?.rows ?? [];
    // A collection nobody but its own creator is minting. Held behind a chip
    // rather than dropped, because seeing it is sometimes the point.
    const kept = hideWash
      ? all.filter((r) => r.pulse.uniqueness === null || r.pulse.uniqueness >= 0.4)
      : all;
    const left = (r: LiveRow) =>
      r.maxSupply !== undefined && r.minted !== undefined ? r.maxSupply - r.minted : Infinity;
    return [...kept].sort((a, b) => {
      if (sort === "rate") return b.pulse.perMin - a.pulse.perMin;
      if (sort === "unique") return (b.pulse.uniqueness ?? -1) - (a.pulse.uniqueness ?? -1);
      if (sort === "minted") return b.pulse.quantity - a.pulse.quantity;
      if (sort === "left") return left(a) - left(b);
      return b.pulse.trend - a.pulse.trend;
    });
  }, [view, sort, hideWash]);

  const totals = useMemo(() => {
    const all = view?.rows ?? [];
    return {
      collections: all.length,
      quantity: all.reduce((a, r) => a + r.pulse.quantity, 0),
      txs: all.reduce((a, r) => a + r.pulse.txs, 0),
    };
  }, [view]);

  function header(key: SortKey, label: string, className = "") {
    return (
      <th className={`sortable ${className}`.trim()} onClick={() => setSort(key)}>
        {label}
        {sort === key ? " ▼" : ""}
      </th>
    );
  }

  return (
    <div>
      <div className="panel">
        <h2>Live — what is minting right now</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          One log query covers every mint on the chain, so this is the whole
          hour grouped by collection. Ranked by rate discounted for how much of
          it comes from distinct wallets and for how long the drop has been
          quiet — raw speed is the number a wash mint is best at producing, and
          ranking on it alone would put the fakes on top.
        </p>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 2, minWidth: 200 }}>
            <label>server URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label>token</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="SNIPE_TOKEN" autoComplete="off" />
          </div>
        </div>

        <div className="scan-bar">
          <span className="bar-label">AUTO</span>
          <div className="chip-group">
            {INTERVALS.map((i) => (
              <button
                key={i.secs}
                className={every === i.secs ? "secondary active-chip" : "secondary"}
                disabled={!base || !token}
                onClick={() => setEvery(i.secs)}
              >
                {i.label}
              </button>
            ))}
            <button className="secondary" disabled={busy || !base || !token} onClick={() => void load()}>
              {busy ? <span className="spin">READING</span> : "refresh"}
            </button>
          </div>
          <div className="bar-tail">
            <button
              className={hideWash ? "secondary active-chip" : "secondary"}
              onClick={() => setHideWash(!hideWash)}
              title="Hide collections where under 40% of mints came from different wallets"
            >
              hide wash
            </button>
            {every ? (
              <span className="pill">
                next in <b>{nextIn}s</b>
              </span>
            ) : null}
            {view ? (
              <span className="pill ok">
                {totals.collections} minting · {totals.quantity.toLocaleString("en-US")} in {view.hours}h
              </span>
            ) : null}
          </div>
        </div>

        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />

        {view && rows.length > 0 ? (
          <div className="table-wrap">
            <table className="ledger-table collapsible scan-table">
              <colgroup>
                <col />
                <col style={{ width: 132 }} />
                <col style={{ width: 138 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 74 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>collection</th>
                  <th>twitter</th>
                  <th>creator</th>
                  <th>last hour</th>
                  {header("rate", "rate", "num")}
                  {header("unique", "wallets", "num")}
                  {header("minted", "minted", "num")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = r.pulse;
                  const quiet = p.lastT > 0 ? now - p.lastT : null;
                  const soldOut =
                    r.maxSupply !== undefined && r.minted !== undefined && r.minted >= r.maxSupply;
                  return (
                    <tr
                      key={r.contract}
                      className={`project-row${justIn.has(r.contract.toLowerCase()) ? " feed-row" : ""}`}
                    >
                      <td data-label="collection" className="cell-clip">
                        <a
                          className="cell-name"
                          href={openSeaCollectionUrlBySlug(view.openSeaSlug, r.contract)}
                          target="_blank"
                          rel="noreferrer"
                          title={r.name ?? r.contract}
                        >
                          {r.name ?? `${r.contract.slice(0, 10)}…`}
                        </a>
                        <span className="cell-sub dim">
                          <Addr value={r.contract} head={8} />
                          {soldOut ? <span className="pill-tba"> SOLD OUT</span> : null}
                        </span>
                      </td>
                      <td data-label="twitter" className="cell-clip">
                        {(() => {
                          const meta = info[r.contract.toLowerCase()];
                          if (meta === undefined) return <span className="faint">···</span>;
                          if (!meta.twitter)
                            return (
                              <span className="faint" title="no account connected on OpenSea">
                                —
                              </span>
                            );
                          const all = twitterRelated[meta.twitter.toLowerCase()] ?? [];
                          const band = reuseBand(all.length);
                          return (
                            <>
                              <span className="cell-name tw-handle">
                                <a href={twitterUrl(meta.twitter)} target="_blank" rel="noreferrer">
                                  @{meta.twitter}
                                </a>
                                {band === "none" ? null : (
                                  <ReuseBadge
                                    count={all.length}
                                    band={band}
                                    onEnter={(e) =>
                                      related.open(anchorFrom(e, `@${meta.twitter} has launched`, all))
                                    }
                                    onLeave={related.close}
                                  />
                                )}
                              </span>
                              <span className="cell-sub dim">
                                {meta.followers === undefined
                                  ? ""
                                  : `${compactCount(meta.followers)} followers`}
                              </span>
                            </>
                          );
                        })()}
                      </td>
                      <td data-label="creator" className="cell-clip">
                        {r.owner ? (
                          <span className="cell-name">
                            <a
                              href={openSeaProfile(r.owner)}
                              target="_blank"
                              rel="noreferrer"
                              title="Open this wallet's OpenSea profile"
                            >
                              {r.owner.slice(0, 6)}…{r.owner.slice(-4)}
                            </a>
                            {(() => {
                              const all = view.related?.owners?.[r.owner!.toLowerCase()] ?? [];
                              const band = reuseBand(all.length);
                              if (band === "none") return null;
                              return (
                                <ReuseBadge
                                  count={all.length}
                                  band={band}
                                  onEnter={(e) =>
                                    related.open(
                                      anchorFrom(e, "this wallet has launched", all),
                                    )
                                  }
                                  onLeave={related.close}
                                />
                              );
                            })()}
                          </span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td data-label="last hour">
                        <Spark spark={p.spark ?? []} />
                      </td>
                      <td className="num" data-label="rate">
                        <span className="cell-name">{fmtRate(p.perMin)}</span>
                        <span className="cell-sub dim">{quiet === null ? "" : ago(quiet)}</span>
                      </td>
                      <td className="num" data-label="wallets">
                        {p.uniqueness === null ? (
                          <>
                            <span className="cell-name faint">—</span>
                            <span className="cell-sub dim">{p.wallets} seen</span>
                          </>
                        ) : (
                          <>
                            <span className={`cell-name ${p.uniqueness < 0.4 ? "risk-bad" : p.uniqueness < 0.7 ? "risk-warn" : "risk-ok"}`}>
                              {Math.round(p.uniqueness * 100)}%
                            </span>
                            <span className="cell-sub dim">
                              {p.wallets.toLocaleString("en-US")} of {p.txs.toLocaleString("en-US")}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="num" data-label="minted">
                        <span className="cell-name">{p.quantity.toLocaleString("en-US")}</span>
                        <span className="cell-sub dim">
                          {r.maxSupply === undefined || r.minted === undefined
                            ? "supply unknown"
                            : `${(r.maxSupply - r.minted).toLocaleString("en-US")} left`}
                        </span>
                      </td>
                      <td className="num" data-label="">
                        <button
                          className="secondary"
                          style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                          title="Load this collection in the Snipe tab"
                          onClick={() => {
                            setPendingTarget(r.contract);
                            onSnipe?.(r.contract);
                          }}
                        >
                          snipe
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <RelatedPopover
          anchor={related.anchor}
          onHold={related.hold}
          onLeave={related.close}
          href={(c) => openSeaCollectionUrlBySlug(view?.openSeaSlug, c)}
        />

        {view && rows.length === 0 ? (
          <div className="empty-state">
            NOTHING MINTING —{" "}
            <span className="es-action">
              {hideWash ? "OR EVERYTHING LEFT IS WASH — CLEAR THE FILTER" : "THE CHAIN IS QUIET"}
            </span>
          </div>
        ) : null}

        {!view && !busy ? (
          <div className="empty-state">
            NOT READ YET — <span className="es-action">PRESS REFRESH</span>
          </div>
        ) : null}

        {view ? (
          <p className="dim hint" style={{ marginBottom: 0 }}>
            {totals.txs.toLocaleString("en-US")} mint transactions on {view.chain} in the last{" "}
            {view.hours}h. The wallets column is distinct minters over mint transactions — a dash
            means too few mints to judge from, which is not the same as a clean one. Sold-out rows
            stay: what a drop did is worth seeing after it is over.
          </p>
        ) : null}
      </div>
    </div>
  );
}
