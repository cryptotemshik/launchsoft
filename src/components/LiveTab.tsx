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
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import RunnerConnect from "./RunnerConnect";
import { useRunnerApi } from "../lib/runnerClient";
import { createTabStore } from "../lib/tabStore";
import { useCustomRpcs } from "../lib/customRpc";
import type { MintPulse } from "../lib/mintPulse";
import { reuseBand, type IndexedCollection } from "../lib/creatorIndex";
import { twitterUrl, type CollectionInfo } from "../lib/collectionInfo";
import { compactCount } from "../lib/twitterStats";
import RelatedPopover, { ReuseBadge, anchorFrom, useRelated } from "./RelatedPopover";
import { openSeaCollectionUrlBySlug } from "../chains";
import SnipeButton from "./SnipeButton";
import { sndFeedTick } from "../lib/sound";
import Addr from "./Addr";
import StaleServer from "./StaleServer";
import WatchButton from "./WatchButton";

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
  /** The window this answer covers, in minutes. */
  minutes: number;
  now: number;
  chain: string;
  openSeaSlug?: string;
  cachedAt?: number;
  /** Why the read failed, when it did. Absent on a healthy hour. */
  error?: string | null;
  readRpc?: string;
  publicRpc?: boolean;
  related?: { owners?: Record<string, IndexedCollection[]>; twitters?: Record<string, IndexedCollection[]> };
}

const INTERVALS = [
  { secs: 0, label: "off" },
  { secs: 15, label: "15s" },
  { secs: 30, label: "30s" },
  { secs: 60, label: "1m" },
] as const;

/**
 * How much history a row is judged on.
 *
 * Five minutes answers "what is happening right now"; a day answers "what
 * happened today", and a collection that took ten thousand mints this morning
 * looks quiet in the first and enormous in the second. Both are true, which is
 * why it is a choice rather than a constant.
 */
const WINDOWS = [
  { minutes: 5, label: "5m" },
  { minutes: 15, label: "15m" },
  { minutes: 60, label: "1h" },
  { minutes: 240, label: "4h" },
  { minutes: 1440, label: "24h" },
] as const;

function windowLabel(minutes: number | undefined): string {
  return WINDOWS.find((w) => w.minutes === minutes)?.label ?? `${minutes ?? "?"}m`;
}

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

/**
 * The feed, kept where leaving the tab cannot throw it away.
 *
 * At module scope on purpose. This tab suffered the worse half of the problem:
 * its refresh interval lived in the component, so "every 30s" meant "every 30s
 * while you watch it" — the one setting whose entire purpose is to keep
 * working when you are not. The loop is the store's now. See src/lib/tabStore.
 */
interface LiveData {
  view: LiveView | null;
  /** The window the held feed was read for. */
  minutes: number;
  /** Contracts the previous read held, so an arrival can be told from the rest. */
  seen: Set<string> | null;
  justIn: Set<string>;
  info: Record<string, CollectionInfo>;
  twitterRelated: Record<string, IndexedCollection[]>;
}

const DEFAULT_EVERY = 30;

const store = createTabStore<LiveData>(
  { view: null, minutes: 15, seen: null, justIn: new Set(), info: {}, twitterRelated: {} },
  {
    describeError: (m) =>
      /404/.test(m) ? "This server is too old for the live feed — update it from the Snipe tab." : m,
  },
);
/** The refresh loop is started once, by whichever visit comes first. */
let loopStarted = false;

export default function LiveTab() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const { urls: customRpcs } = useCustomRpcs();
  const held = useSyncExternalStore(store.subscribe, store.getState);
  const { view, minutes, justIn, info, twitterRelated } = held.data;
  const { error, busy, every, nextIn } = held;
  const [sort, setSort] = useState<SortKey>("trend");
  const [hideWash, setHideWash] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const related = useRelated();

  /**
   * Read the feed for the window the store is holding.
   *
   * Throws rather than catching: the store turns that into the line of red
   * text and keeps the rows already on screen.
   */
  const load = useCallback(async () => {
    save();
    const mins = store.getState().data.minutes;
    const r = (await call(`/api/live?minutes=${mins}`)) as unknown as LiveView;
    const rows = r.rows ?? [];
    const ids = new Set(rows.map((x) => x.contract.toLowerCase()));
    // On the first read everything is new, which is not news.
    const prior = store.getState().data.seen;
    const arrived = prior ? [...ids].filter((c) => !prior.has(c)) : [];
    store.set({
      view: { ...r, rows },
      seen: ids,
      ...(arrived.length > 0 ? { justIn: new Set(arrived) } : {}),
    });
    if (arrived.length > 0) sndFeedTick();
    setNow(Math.floor(Date.now() / 1000));
  }, [call, save]);

  /**
   * A failed read is not a quiet chain, and the server says which — inside an
   * otherwise successful response.
   *
   * Derived from the response rather than pushed into the store's error. It
   * cannot be pushed: `run()` clears the error when the fetcher returns, and a
   * write from inside the fetcher is queued ahead of that clear, so it would
   * be wiped every time. Deriving it also means it goes away by itself the
   * moment a read succeeds.
   */
  const feedError = view?.error ? `could not read the mint feed: ${view.error}` : null;

  useEffect(() => {
    store.setFetcher(base && token ? load : null);
  }, [load, base, token]);

  /**
   * Install this browser's endpoint before the first read.
   *
   * An hour of mints is four and a half thousand events in one log query —
   * comfortably the heaviest thing this tab asks for — and the chain's public
   * RPC answers it with a rate limit. The endpoint is one shared setting, so
   * every page that leans on it installs it rather than assuming another tab
   * already did.
   */
  const pushRpcs = useCallback(async () => {
    if (customRpcs.length === 0) return;
    try {
      await call("/api/rpcs", { method: "POST", body: JSON.stringify({ extraRpcs: customRpcs }) });
    } catch {
      // An older server has no such route; the stale-server notice covers it.
    }
  }, [call, customRpcs]);

  /**
   * Opening the tab draws the feed already held and reads again only if it has
   * aged. The endpoint goes down either way — it is one small POST, and it is
   * how a changed RPC reaches the server at all.
   */
  useEffect(() => {
    if (!base || !token) return;
    if (!loopStarted) {
      loopStarted = true;
      store.setEvery(DEFAULT_EVERY);
    }
    void pushRpcs().then(() => {
      if (store.isStale()) void store.run();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

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
          store.set({ info: { ...store.getState().data.info, ...r.known } });
        }
        if (r.twitters) {
          store.set({ twitterRelated: { ...store.getState().data.twitterRelated, ...r.twitters } });
        }
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
          One log query covers every mint on the chain, so this is the window
          you pick, grouped by collection. Ranked by rate discounted for how much of
          it comes from distinct wallets and for how long the drop has been
          quiet — raw speed is the number a wash mint is best at producing, and
          ranking on it alone would put the fakes on top.
        </p>

        <RunnerConnect url={url} setUrl={setUrl} token={token} setToken={setToken} />

        <div className="scan-bar">
          <span className="bar-label">WINDOW</span>
          <div className="chip-group">
            {WINDOWS.map((w) => (
              <button
                key={w.minutes}
                className={minutes === w.minutes ? "secondary active-chip" : "secondary"}
                disabled={busy || !base || !token}
                onClick={() => {
                  store.set({ minutes: w.minutes });
                  void store.run();
                }}
              >
                {w.label}
              </button>
            ))}
          </div>

          <span className="bar-label bar-gap">AUTO</span>
          <div className="chip-group">
            {INTERVALS.map((i) => (
              <button
                key={i.secs}
                className={every === i.secs ? "secondary active-chip" : "secondary"}
                disabled={!base || !token}
                onClick={() => store.setEvery(i.secs)}
              >
                {i.label}
              </button>
            ))}
            <button className="secondary" disabled={busy || !base || !token} onClick={() => void store.run()}>
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
                {totals.collections} minting · {totals.quantity.toLocaleString("en-US")} in{" "}
                {windowLabel(view.minutes)}
              </span>
            ) : null}
            {view?.readRpc ? (
              <span className={view.publicRpc ? "pill warn" : "pill"}>
                via <b>{view.readRpc}</b>
                {view.publicRpc ? " · public" : ""}
              </span>
            ) : null}
          </div>
        </div>

        {error ?? feedError ? <p className="error">{error ?? feedError}</p> : null}
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
                <col style={{ width: 132 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>collection</th>
                  <th>twitter</th>
                  <th>creator</th>
                  <th>{windowLabel(view.minutes)}</th>
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
                      className={`project-row${justIn.has(r.contract.toLowerCase()) ? " row-just-in" : ""}`}
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
                      <td data-label="window">
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
                        <div className="row-actions">
                          <SnipeButton contract={r.contract} />
                          <WatchButton
                            draft={{
                              name: r.name ?? r.contract,
                              contract: r.contract,
                              twitter: info[r.contract.toLowerCase()]?.twitter,
                              supply: r.maxSupply,
                            }}
                          />
                        </div>
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
            {view.error ? (
              <>
                COULD NOT READ THE FEED —{" "}
                <span className="es-action">
                  {customRpcs.length === 0
                    ? "THE PUBLIC RPC METERS A QUERY THIS SIZE — PASTE YOUR ENDPOINT ON THE SNIPE TAB"
                    : "TRY AGAIN"}
                </span>
              </>
            ) : (
              <>
                NOTHING MINTING —{" "}
                <span className="es-action">
                  {hideWash ? "OR EVERYTHING LEFT IS WASH — CLEAR THE FILTER" : "THE CHAIN IS QUIET"}
                </span>
              </>
            )}
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
            {windowLabel(view.minutes)}. The wallets column is distinct minters over mint transactions — a dash
            means too few mints to judge from, which is not the same as a clean one. Sold-out rows
            stay: what a drop did is worth seeing after it is over.
          </p>
        ) : null}
      </div>
    </div>
  );
}
