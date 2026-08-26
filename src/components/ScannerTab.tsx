/**
 * Drops that exist on-chain and nowhere else yet.
 *
 * A creator configures the public stage before announcing it — sometimes days
 * before — and SeaDrop emits that configuration as an event carrying the whole
 * struct. So a single log query names every collection with a price and a start
 * time attached, and this tab is the window onto it: what is live, what opens
 * within the hour, what is scheduled for later in the week.
 *
 * The reading happens on the server, through the same endpoints everything else
 * uses. Nothing here talks to a chain directly.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import {
  applyFilter,
  classify,
  isSoldOut,
  sortForScan,
  type DropState,
  type ScannedDrop,
} from "../lib/dropScan";
import { openSeaCollectionUrlBySlug } from "../chains";
import { setPendingTarget } from "../lib/snipeTarget";
import Addr from "./Addr";
import StaleServer from "./StaleServer";

interface ScanView {
  drops: ScannedDrop[];
  hours: number;
  events: number;
  collections: number;
  enriched: number;
  fromBlock: number;
  toBlock: number;
  blocksPerHour: number;
  chain: string;
  explorerUrl: string;
  openSeaSlug?: string;
  now: number;
  tookMs: number;
  cachedAt?: number;
}

const WINDOWS = [
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 72, label: "3d" },
  { hours: 168, label: "7d" },
] as const;

const STATES: { key: DropState | "all"; label: string }[] = [
  { key: "live", label: "live" },
  { key: "soon", label: "next 24h" },
  { key: "upcoming", label: "later" },
  { key: "all", label: "everything" },
];

type SortKey = "start" | "name" | "price" | "supply";

/** A countdown a person reads at a glance, not a stopwatch. */
function countdown(secs: number): string {
  const s = Math.max(0, secs);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

const STATE_CLASS: Record<DropState, string> = {
  live: "ok",
  soon: "warn",
  upcoming: "dim",
  pending: "dim",
  ended: "dim",
};

export default function ScannerTab({ onSnipe }: { onSnipe?: (contract: string) => void }) {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [view, setView] = useState<ScanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(24);
  const [state, setState] = useState<DropState | "all">("soon");
  const [hideSoldOut, setHideSoldOut] = useState(true);
  const [freeOnly, setFreeOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("start");
  const [desc, setDesc] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(
    async (h: number, fresh = false) => {
      setBusy(true);
      setError(null);
      try {
        save();
        const r = (await call(
          `/api/scan?hours=${h}${fresh ? "&fresh=1" : ""}`,
        )) as unknown as ScanView;
        setView(r);
        setNow(Math.floor(Date.now() / 1000));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(
          /404/.test(msg)
            ? "This server is too old to scan — update it from the Snipe tab."
            : msg,
        );
      } finally {
        setBusy(false);
      }
    },
    [call, save],
  );

  useEffect(() => {
    if (base && token) void load(hours);
    // Only on mount: every other load is a click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdowns would otherwise go stale while the tab sits open.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const all = view?.drops ?? [];
    const filtered = applyFilter(all, { state, hideSoldOut, freeOnly, search }, now);
    if (sort === "start") return desc ? sortForScan(filtered, now).reverse() : sortForScan(filtered, now);
    const dir = desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (sort === "name") return dir * (a.name ?? a.contract).localeCompare(b.name ?? b.contract);
      if (sort === "price") return dir * (Number(a.priceWei) - Number(b.priceWei));
      return dir * ((a.maxSupply ?? 0) - (b.maxSupply ?? 0));
    });
  }, [view, state, hideSoldOut, freeOnly, search, sort, desc, now]);

  const counts = useMemo(() => {
    const all = view?.drops ?? [];
    const of = (s: DropState) => all.filter((d) => classify(d, now) === s).length;
    return { live: of("live"), soon: of("soon"), upcoming: of("upcoming"), all: all.length };
    // `now` moves every second but these only change on a state boundary;
    // recomputing a few hundred classifications a second is cheap enough.
  }, [view, now]);

  function header(key: SortKey, label: string, className = "") {
    return (
      <th
        className={`sortable ${className}`.trim()}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            setDesc(key === "supply" || key === "price");
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
        <h2>Scanner — drops nobody has announced</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          A creator configures the public stage on-chain before telling anyone,
          and the contract announces that configuration in an event carrying the
          whole struct — price, start, end, per-wallet cap. One log query
          therefore finds every drop scheduled in a window, with no
          per-collection lookup needed to decide which are worth reading. Only
          the ones still ahead get their name and supply filled in.
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

        <div className="range-picker">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              className={hours === w.hours ? "secondary active-chip" : "secondary"}
              disabled={busy || !base || !token}
              onClick={() => {
                setHours(w.hours);
                void load(w.hours);
              }}
            >
              {w.label}
            </button>
          ))}
          <button
            className="secondary"
            disabled={busy || !base || !token}
            onClick={() => void load(hours, true)}
            title="Ignore the cached result and read the chain again"
          >
            {busy ? <span className="spin">SCANNING</span> : "re-scan"}
          </button>
          {view ? (
            <span className="pill ok">
              {view.collections} found · {view.enriched} read ·{" "}
              {(view.tookMs / 1000).toFixed(1)}s
              {view.cachedAt
                ? ` · ${Math.max(0, Math.round((Date.now() - view.cachedAt) / 1000))}s ago`
                : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />

        {view ? (
          <>
            <div className="wallet-picker-chips">
              {STATES.map((s) => (
                <button
                  key={s.key}
                  className={state === s.key ? "secondary active-chip" : "secondary"}
                  onClick={() => setState(s.key)}
                >
                  {s.label} ({s.key === "all" ? counts.all : counts[s.key as keyof typeof counts]})
                </button>
              ))}
              <button
                className={hideSoldOut ? "secondary active-chip" : "secondary"}
                onClick={() => setHideSoldOut(!hideSoldOut)}
                title="A drop can sell out through its allow-list while its public start is still ahead"
              >
                hide sold out
              </button>
              <button
                className={freeOnly ? "secondary active-chip" : "secondary"}
                onClick={() => setFreeOnly(!freeOnly)}
              >
                free only
              </button>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <label>search</label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="name or contract address"
              />
            </div>
          </>
        ) : null}

        {view && rows.length > 0 ? (
          <div className="table-wrap">
            <table className="ledger-table collapsible">
              <thead>
                <tr>
                  {header("start", "opens")}
                  {header("name", "collection")}
                  {header("price", "price", "num")}
                  {header("supply", "supply", "num")}
                  <th className="num">per wallet</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const st = classify(d, now);
                  const sold = isSoldOut(d);
                  const away = d.startTime ? d.startTime - now : null;
                  return (
                    <tr key={d.contract} className="project-row">
                      <td data-label="opens">
                        <span className={`cell-name ${STATE_CLASS[st]}`}>
                          {st === "live" ? "LIVE" : st === "ended" ? "ended" : st === "pending" ? "no date" : countdown(away ?? 0)}
                        </span>
                        <span className="cell-sub dim">
                          {d.startTime
                            ? new Date(d.startTime * 1000).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "not scheduled"}
                        </span>
                      </td>
                      <td data-label="collection">
                        <a
                          className="cell-name"
                          href={openSeaCollectionUrlBySlug(view.openSeaSlug, d.contract)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {d.name ?? `${d.contract.slice(0, 10)}…`}
                        </a>
                        <span className="cell-sub dim">
                          <Addr value={d.contract} head={8} />
                          {sold ? <span className="pill-tba"> SOLD OUT</span> : null}
                        </span>
                      </td>
                      <td className="num" data-label="price">
                        {BigInt(d.priceWei) === 0n ? (
                          <span className="ok">free</span>
                        ) : (
                          formatEther(BigInt(d.priceWei))
                        )}
                      </td>
                      <td className="num" data-label="supply">
                        {d.maxSupply === undefined ? (
                          <span className="dim">?</span>
                        ) : (
                          <>
                            <span className="cell-name">{d.maxSupply.toLocaleString("en-US")}</span>
                            <span className="cell-sub dim">
                              {(d.minted ?? 0).toLocaleString("en-US")} minted
                            </span>
                          </>
                        )}
                      </td>
                      <td className="num" data-label="per wallet">
                        {d.maxPerWallet || <span className="dim">∞</span>}
                      </td>
                      <td className="num" data-label="">
                        <button
                          className="secondary"
                          style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                          title="Load this collection in the Snipe tab"
                          onClick={() => {
                            setPendingTarget(d.contract);
                            onSnipe?.(d.contract);
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

        {view && rows.length === 0 ? (
          <div className="empty-state">
            NOTHING MATCHES —{" "}
            <span className="es-action">WIDEN THE WINDOW OR CLEAR THE FILTERS</span>
          </div>
        ) : null}

        {!view && !busy ? (
          <div className="empty-state">
            NOT SCANNED YET — <span className="es-action">PICK A WINDOW ABOVE</span>
          </div>
        ) : null}

        {view ? (
          <p className="dim hint" style={{ marginBottom: 0 }}>
            Read {view.hours}h of {view.chain} — blocks{" "}
            {view.fromBlock.toLocaleString("en-US")}–{view.toBlock.toLocaleString("en-US")} at about{" "}
            {view.blocksPerHour.toLocaleString("en-US")} blocks an hour, {view.events} stage
            configurations across {view.collections} collections. Allow-list stages are never
            reported here: this event describes the public stage alone.
          </p>
        ) : null}
      </div>
    </div>
  );
}
