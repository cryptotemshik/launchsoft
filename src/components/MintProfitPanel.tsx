/**
 * What the sniper's mints cost and what they have made.
 *
 * Distinct from the profit the rest of the dashboard shows, which is about
 * collections you launched. This is the other side: drops you minted from,
 * where the cost is gas and mint price across a hundred wallets and the
 * revenue is whatever those tokens have sold for since.
 *
 * The server sends every spend and every receipt with the time it happened, so
 * the window, the sort and the profit line are all cut from the same data
 * without asking the chain again. No marketplace API is involved, so there is
 * nothing to key and nothing to break when one changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { formatEthShort } from "../lib/profit";
import StaleServer from "./StaleServer";
import Addr from "./Addr";
import { openSeaCollectionUrlBySlug } from "../chains";
import { cardFileName, drawShareCard } from "../lib/shareCard";
import CopyButton from "./CopyButton";

interface CollectionProfit {
  collection: string;
  collectionName?: string;
  cost?: { gasWei: string; priceWei: string; tokens: number; wallets: number };
  sales?: { wallet: string; tokenId: string; blockNumber: string; txHash: string; proceedsWei: string }[];
  soldTokens?: number;
  revenueWei?: string;
  netWei?: string;
  heldTokens?: number;
  unpricedSales?: number;
  runs?: number;
  lastAt?: number;
  error?: string;
}

/** One spend or one receipt, as the server timestamps it. */
interface ProfitEvent {
  collection: string;
  kind: "mint" | "sale";
  /** Unix seconds, from the block it happened in. */
  at: number;
  block: string;
  /** Signed wei — negative for a mint, positive for a sale. */
  wei: string;
  tokens: number;
  wallet: string;
  txHash: string;
  tokenId?: string;
  priced?: boolean;
}

interface ProfitView {
  /** True while the server is still reading; the rest may be missing. */
  building?: boolean;
  /** Set when what came back is the previous report, not a new one. */
  stale?: boolean;
  /** When the report was built, if it came from the server's cache. */
  cachedAt?: number;
  chain: string;
  explorerUrl: string;
  openSeaSlug?: string;
  wallets: number;
  collections: CollectionProfit[];
  events?: ProfitEvent[];
  now?: number;
  tookMs: number;
}

const wei = (s: string | undefined) => (s ? BigInt(s) : 0n);

const RANGES = [
  { key: "1h", label: "1h", secs: 3600 },
  { key: "6h", label: "6h", secs: 6 * 3600 },
  { key: "24h", label: "24h", secs: 24 * 3600 },
  { key: "7d", label: "7d", secs: 7 * 86400 },
  { key: "30d", label: "30d", secs: 30 * 86400 },
  { key: "all", label: "all time", secs: null },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];
type SortKey = "collection" | "minted" | "spent" | "sold" | "earned" | "net";

interface Row {
  collection: string;
  name?: string;
  minted: number;
  wallets: number;
  spent: bigint;
  sold: number;
  earned: bigint;
  net: bigint;
  held: number;
  unpriced: number;
  runs: number;
  sales: ProfitEvent[];
  /** The mint transactions themselves, for the other half of the breakdown. */
  mints: ProfitEvent[];
}

export default function MintProfitPanel() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [view, setView] = useState<ProfitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("24h");
  const [sort, setSort] = useState<SortKey>("net");
  const [desc, setDesc] = useState(true);
  const [widened, setWidened] = useState(false);
  const [waiting, setWaiting] = useState(false);

  /**
   * Ask for the report, and keep asking while the server builds it.
   *
   * Reading a hundred wallets' whole history takes longer than the tunnel
   * allows a single request to live, so the server does it in the background
   * and answers "building" until it is done. Waiting quietly through that is
   * the difference between a panel that looks broken and one that is working.
   */
  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    setError(null);
    try {
      save();
      let next = (await call(
        `/api/profit${fresh ? "?fresh=1" : ""}`,
      )) as unknown as ProfitView;
      // Up to five minutes: a first read of a long history is genuinely slow,
      // and giving up early would throw away work that is nearly done.
      for (let i = 0; next.building && i < 60; i++) {
        setWaiting(true);
        await new Promise((r) => setTimeout(r, 5_000));
        next = (await call("/api/profit")) as unknown as ProfitView;
      }
      setWaiting(false);
      if (next.building) {
        setError("The server is still reading the chain — press refresh in a minute.");
        return;
      }
      setView(next);
      // A day is the useful default, but a day that happens to be quiet would
      // show an empty panel and read as broken. So when the default window is
      // empty and something did happen earlier, open it out and say so.
      const now = next.now ?? Math.floor(Date.now() / 1000);
      const events = Array.isArray(next.events) ? next.events : [];
      const recent = events.some((e) => e.at >= now - 24 * 3600);
      setWidened(!recent && events.length > 0);
      setRange(!recent && events.length > 0 ? "all" : "24h");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /404/.test(msg)
          ? "This server is too old to report profit — update it from the Snipe tab."
          : msg,
      );
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  }, [call, save]);

  // Load once if the connection is already set up from another tab.
  useEffect(() => {
    if (base && token) void load();
    // Deliberately only on mount: refreshing is a button, not a poll, because
    // each run reads logs for every collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A server too old to send events still has its totals — show those. */
  const legacy = view != null && !Array.isArray(view.events);

  const since = useMemo(() => {
    const secs = RANGES.find((r) => r.key === range)?.secs ?? null;
    if (secs === null) return 0;
    return (view?.now ?? Math.floor(Date.now() / 1000)) - secs;
  }, [range, view]);

  const events = useMemo(
    () => (Array.isArray(view?.events) ? view.events : []).filter((e) => e.at >= since),
    [view, since],
  );

  const rows = useMemo<Row[]>(() => {
    // A response missing the fields we expect must not take the dashboard down
    // with it — an old or half-broken server is a reason to show less, not a
    // white screen.
    const all = view?.collections ?? [];
    if (!view) return [];
    const meta = new Map(all.map((c) => [c.collection.toLowerCase(), c]));

    if (legacy) {
      return all
        .filter((c) => !c.error)
        .map((c) => ({
          collection: c.collection,
          name: c.collectionName,
          minted: c.cost?.tokens ?? 0,
          wallets: c.cost?.wallets ?? 0,
          spent: wei(c.cost?.gasWei) + wei(c.cost?.priceWei),
          sold: c.soldTokens ?? 0,
          earned: wei(c.revenueWei),
          net: wei(c.netWei),
          held: c.heldTokens ?? 0,
          unpriced: c.unpricedSales ?? 0,
          runs: c.runs ?? 0,
          // An older server reports totals without the events behind them, so
          // the breakdown is empty rather than wrong.
          sales: [],
          mints: [],
        }));
    }

    const by = new Map<string, Row>();
    for (const e of events) {
      const c = meta.get(e.collection);
      const row =
        by.get(e.collection) ??
        ({
          collection: c?.collection ?? e.collection,
          name: c?.collectionName,
          minted: 0,
          wallets: 0,
          spent: 0n,
          sold: 0,
          earned: 0n,
          net: 0n,
          // Holdings are a fact about now, not about the window.
          held: c?.heldTokens ?? 0,
          unpriced: 0,
          runs: c?.runs ?? 0,
          sales: [],
          mints: [],
        } satisfies Row);
      if (e.kind === "mint") {
        row.minted += e.tokens;
        row.spent += -BigInt(e.wei);
        row.mints.push(e);
      } else {
        row.sold += 1;
        if (e.priced === false) row.unpriced += 1;
        else row.earned += BigInt(e.wei);
        row.sales.push(e);
      }
      by.set(e.collection, row);
    }
    const walletsPer = new Map<string, Set<string>>();
    for (const e of events) {
      if (e.kind !== "mint") continue;
      const seen = walletsPer.get(e.collection) ?? new Set<string>();
      seen.add(e.wallet.toLowerCase());
      walletsPer.set(e.collection, seen);
    }
    for (const [key, row] of by) {
      row.wallets = walletsPer.get(key)?.size ?? 0;
      row.net = row.earned - row.spent;
    }
    return [...by.values()];
  }, [view, events, legacy]);

  const sorted = useMemo(() => {
    const dir = desc ? -1 : 1;
    const cmp = (a: Row, b: Row): number => {
      switch (sort) {
        case "collection":
          return (a.name ?? a.collection).localeCompare(b.name ?? b.collection);
        case "minted":
          return a.minted - b.minted;
        case "sold":
          return a.sold - b.sold;
        case "spent":
          return a.spent < b.spent ? -1 : a.spent > b.spent ? 1 : 0;
        case "earned":
          return a.earned < b.earned ? -1 : a.earned > b.earned ? 1 : 0;
        default:
          return a.net < b.net ? -1 : a.net > b.net ? 1 : 0;
      }
    };
    return [...rows].sort((a, b) => dir * cmp(a, b));
  }, [rows, sort, desc]);

  const cardRef = useRef<HTMLCanvasElement | null>(null);
  const [card, setCard] = useState<string | null>(null);

  /**
   * Draw the window as something postable.
   *
   * The palette comes off the live stylesheet rather than being repeated in
   * the drawing code, so the image cannot drift from the app it claims to be
   * a picture of.
   */
  const makeCard = useCallback(() => {
    const canvas = cardRef.current;
    if (!canvas) return;
    const styles = getComputedStyle(document.documentElement);
    drawShareCard(
      canvas,
      {
        netWei: totals.net,
        spentWei: totals.spent,
        earnedWei: totals.earned,
        minted: totals.minted,
        sold: totals.sold,
        collections: rows.length,
        rangeLabel: RANGES.find((r) => r.key === range)?.label ?? "window",
        top: [...rows]
          .sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))
          .slice(0, 3)
          .map((r) => ({ name: r.name ?? r.collection.slice(0, 10), netWei: r.net })),
        symbol: "ETH",
      },
      (name, fallback) => styles.getPropertyValue(name).trim() || fallback,
    );
    setCard(canvas.toDataURL("image/png"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, range]);

  const totals = rows.reduce(
    (acc, r) => ({
      spent: acc.spent + r.spent,
      earned: acc.earned + r.earned,
      net: acc.net + r.net,
      minted: acc.minted + r.minted,
      sold: acc.sold + r.sold,
      held: acc.held + r.held,
      unpriced: acc.unpriced + r.unpriced,
    }),
    { spent: 0n, earned: 0n, net: 0n, minted: 0, sold: 0, held: 0, unpriced: 0 },
  );

  function header(key: SortKey, label: string, className = "") {
    return (
      <th
        className={`sortable ${className}`.trim()}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            setDesc(true);
          }
        }}
      >
        {label}
        {sort === key ? (desc ? " ▼" : " ▲") : ""}
      </th>
    );
  }

  return (
    <div className="panel">
      <h2>Sniped mints — cost &amp; profit</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Read from your server: what each drop cost in gas and mint price, and
        what its tokens have sold for since — both taken from the chain itself,
        so a drop counts whether or not it was minted through this server. A
        sale is a token leaving one of your wallets while that wallet&apos;s
        balance rises in the same block; no OpenSea account or API key involved.
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
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button className="secondary" onClick={() => void load()} disabled={busy || !base || !token}>
          {waiting ? <span className="spin">READING CHAIN</span> : busy ? <span className="spin">BUSY</span> : view ? "refresh" : "load"}
        </button>
        {view && !busy ? (
          <button
            className="secondary"
            style={{ padding: "3px 12px", fontSize: 11, width: "auto" }}
            onClick={() => void load(true)}
            title="Ignore everything cached and read the chain again"
          >
            re-read
          </button>
        ) : null}
        {view ? (
          <span className="pill ok">
            {view.wallets ?? 0} wallets · {(view.collections ?? []).length} collection
            {(view.collections ?? []).length === 1 ? "" : "s"} ·{" "}
            {((view.tookMs ?? 0) / 1000).toFixed(1)}s
            {view.cachedAt ? ` · read ${Math.max(0, Math.round((Date.now() - view.cachedAt) / 1000))}s ago` : ""}
          </span>
        ) : null}
      </div>
      {waiting ? (
        <>
          <p className="dim hint">
            Reading every wallet&apos;s history — the first run after a restart
            takes a minute or two. It is fast after that, and the page can be
            left alone until it lands.
          </p>
          {!view ? (
            // The shape of the answer, dimmed and breathing, instead of a
            // spinner over nothing.
            <div className="skeleton-rows" aria-hidden>
              <div className="skeleton" style={{ height: 64, width: "40%" }} />
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <StaleServer version={serverVersion} />

      {view && !legacy ? (
        <div className="range-picker">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={range === r.key ? "secondary active-chip" : "secondary"}
              onClick={() => {
                setRange(r.key);
                setWidened(false);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      ) : null}
      {widened ? (
        <p className="dim hint" style={{ marginTop: 6 }}>
          Nothing happened in the last 24 hours, so this is all time.
        </p>
      ) : null}

      <canvas ref={cardRef} style={{ display: "none" }} />
      {view && rows.length > 0 ? (
        <>
          <div className="profit-summary">
            <div className={`profit-headline ${totals.net >= 0n ? "profit-pos" : "profit-neg"}`}>
              <span className="profit-label">net</span>
              <span className="profit-big">
                {totals.net >= 0n ? "▲ +" : "▼ "}
                {formatEthShort(totals.net)} <small>ETH</small>
              </span>
            </div>
            <div className="profit-facts">
              <Fact label="spent" value={`${formatEthShort(totals.spent)} ETH`} tone="neg" />
              <Fact label="earned" value={`${formatEthShort(totals.earned)} ETH`} tone="pos" />
              <Fact label="minted" value={String(totals.minted)} />
              <Fact label="sold" value={String(totals.sold)} />
              <Fact label="still held" value={String(totals.held)} />
            </div>
            <button className="secondary card-btn" onClick={makeCard}>
              card ↗
            </button>
          </div>

          {card ? (
            <div className="card-preview">
              <img src={card} alt="Shareable summary of this window" />
              <div className="card-actions">
                <a
                  className="secondary btn-like"
                  href={card}
                  download={cardFileName(
                    RANGES.find((r) => r.key === range)?.label ?? "window",
                  )}
                >
                  SAVE PNG
                </a>
                <button className="secondary link-btn" onClick={() => setCard(null)}>
                  dismiss
                </button>
              </div>
              <p className="dim hint" style={{ marginBottom: 0 }}>
                Right-click or long-press to copy it straight into a post. The
                figures are the ones above — nothing is rounded up for effect.
              </p>
            </div>
          ) : null}

          {totals.unpriced > 0 ? (
            <p className="warn" style={{ marginTop: 0 }}>
              {totals.unpriced} sale{totals.unpriced === 1 ? "" : "s"} could not be
              priced, so earnings above are a <b>floor, not a total</b>. Pricing a
              sale needs the wallet&apos;s balance at that old block, which only an
              archive node keeps — the public RPC does not. Point the server at
              Alchemy in the Snipe tab and reload.
            </p>
          ) : null}

          <div className="table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  {header("collection", "collection")}
                  {header("minted", "minted", "num")}
                  {header("spent", "spent", "num")}
                  {header("sold", "sold", "num")}
                  {header("earned", "earned", "num")}
                  {header("net", "net", "num")}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const isOpen = open === r.collection;
                  return [
                    <tr
                      key={r.collection}
                      className={`project-row${isOpen ? " row-open" : ""}`}
                      onClick={() => setOpen(isOpen ? null : r.collection)}
                    >
                      <td>
                        <span className="name-with-copy">
                          <a
                            className="cell-name"
                            href={openSeaCollectionUrlBySlug(view.openSeaSlug, r.collection)}
                            target="_blank"
                            rel="noreferrer"
                            title="Open this collection on OpenSea"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.name ?? `${r.collection.slice(0, 10)}…`}
                          </a>
                          <CopyButton value={r.collection} />
                        </span>
                        <span className="cell-sub dim">
                          {r.held} held
                          {r.wallets ? ` · ${r.wallets} wallet${r.wallets === 1 ? "" : "s"}` : ""}
                          {r.runs ? ` · ${r.runs} run${r.runs === 1 ? "" : "s"}` : ""}
                        </span>
                      </td>
                      <td className="num">{r.minted}</td>
                      <td className="num neg">{r.spent > 0n ? `−${formatEthShort(r.spent)}` : "0"}</td>
                      <td className="num">{r.sold}</td>
                      <td className="num pos">{r.earned > 0n ? `+${formatEthShort(r.earned)}` : "0"}</td>
                      <td className={`num strong ${r.net >= 0n ? "pos" : "neg"}`}>
                        {r.net >= 0n ? "+" : "−"}
                        {formatEthShort(r.net < 0n ? -r.net : r.net)}
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${r.collection}-detail`} className="detail-row">
                        <td colSpan={6}>
                          <Ledger row={r} explorerUrl={view.explorerUrl} />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>total</td>
                  <td className="num">{totals.minted}</td>
                  <td className="num neg">−{formatEthShort(totals.spent)}</td>
                  <td className="num">{totals.sold}</td>
                  <td className="num pos">+{formatEthShort(totals.earned)}</td>
                  <td className={`num strong ${totals.net >= 0n ? "pos" : "neg"}`}>
                    {totals.net >= 0n ? "+" : "−"}
                    {formatEthShort(totals.net < 0n ? -totals.net : totals.net)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {!legacy ? <PnlChart events={events} /> : null}
        </>
      ) : null}

      {view && rows.length === 0 ? (
        <p className="dim hint">
          {(view.events?.length ?? 0) > 0
            ? "Nothing minted or sold in this window — try a longer one."
            : "Nothing minted through these wallets yet. Queue a drop in the Snipe tab and its cost shows up here."}
        </p>
      ) : null}

      {(view?.collections ?? []).some((c) => c.error) ? (
        <p className="warn">
          Couldn&apos;t read:{" "}
          {(view?.collections ?? [])
            .filter((c) => c.error)
            .map((c) => `${c.collection.slice(0, 10)}… (${c.error})`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className={`fact-value ${tone ?? ""}`.trim()}>{value}</span>
    </div>
  );
}

/**
 * Running profit across the window.
 *
 * Drawn from the same events the table counts, so the line and the numbers can
 * never disagree. Each mint steps it down by what it cost, each sale steps it
 * up by what it made; where it ends is the net above.
 */
function PnlChart({ events }: { events: ProfitEvent[] }) {
  const points = useMemo(() => {
    let cum = 0n;
    return events
      .filter((e) => e.at > 0)
      .map((e) => {
        cum += BigInt(e.wei);
        return { t: e.at, v: Number(cum) / 1e18 };
      });
  }, [events]);

  if (points.length < 2) {
    return (
      <p className="dim hint">
        A profit line needs at least two events in the window — pick a longer one.
      </p>
    );
  }

  const W = 720;
  const H = 190;
  const PAD = { l: 8, r: 8, t: 14, b: 20 };
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const lo = Math.min(0, ...points.map((p) => p.v));
  const hi = Math.max(0, ...points.map((p) => p.v));
  const range = hi - lo || 1;

  const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / range) * (H - PAD.t - PAD.b);

  // A step line, because profit changes at an event and holds until the next —
  // sloping between them would draw money arriving that had not arrived.
  const d: string[] = [`M ${x(points[0].t).toFixed(1)} ${y(points[0].v).toFixed(1)}`];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    d.push(`L ${x(p.t).toFixed(1)} ${y(points[i - 1].v).toFixed(1)}`);
    d.push(`L ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`);
  }
  const line = d.join(" ");
  const last = points[points.length - 1].v;
  const zero = y(0);
  const area = `${line} L ${x(t1).toFixed(1)} ${zero.toFixed(1)} L ${x(t0).toFixed(1)} ${zero.toFixed(1)} Z`;
  const when = (t: number) =>
    new Date(t * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="pnl-chart">
      <div className="pnl-head">
        <span className="dim">running profit</span>
        <span className={last >= 0 ? "ok" : "error"}>
          {last >= 0 ? "+" : ""}
          {last.toFixed(4)} ETH
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="profit over time">
        <defs>
          {/* Anchored on the zero line rather than the top of the box: a
              gradient that starts at the frame paints a solid slab whenever
              the line sits below zero. */}
          <linearGradient
            id="pnl-fill"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={last >= 0 ? PAD.t : zero}
            x2="0"
            y2={last >= 0 ? zero : H - PAD.b}
          >
            <stop offset="0%" stopColor={last >= 0 ? "#00c805" : "#ff5c57"} stopOpacity="0.3" />
            <stop offset="100%" stopColor={last >= 0 ? "#00c805" : "#ff5c57"} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} className="pnl-zero" />
        <path d={area} fill="url(#pnl-fill)" />
        <path d={line} fill="none" className={last >= 0 ? "pnl-line pos" : "pnl-line neg"} />
      </svg>
      <div className="pnl-axis dim">
        <span>{when(t0)}</span>
        <span>{when(t1)}</span>
      </div>
    </div>
  );
}

function whenOf(at: number): string {
  return new Date(at * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What actually happened, in two columns.
 *
 * The money went out one way and came back another, and a single mixed list
 * made that hard to read: what you minted is a decision you made, what sold is
 * something the market did. Side by side they answer "did this work" at a
 * glance, and every line links to the transaction so the answer is checkable.
 */
function Ledger({ row, explorerUrl }: { row: Row; explorerUrl: string }) {
  const tx = (hash: string) => `${explorerUrl}/tx/${hash}`;
  return (
    <div className="ledger-split">
      <section>
        <h4 className="ls-head">
          MINTED <span className="dim">· {row.minted} tokens</span>
          <span className="ls-total neg">−{formatEthShort(row.spent)}</span>
        </h4>
        {row.mints.length === 0 ? (
          <p className="dim" style={{ margin: 0, fontSize: 12 }}>
            nothing minted in this window.
          </p>
        ) : (
          <ul className="ls-list">
            {row.mints.map((m) => (
              <li key={`${m.txHash}-${m.wallet}`}>
                <span className="ls-when dim">{whenOf(m.at)}</span>
                <span className="ls-what">
                  {m.tokens}× from <Addr value={m.wallet} head={6} />
                </span>
                <span className="ls-amt neg">−{formatEthShort(-BigInt(m.wei))}</span>
                <a href={tx(m.txHash)} target="_blank" rel="noreferrer" className="ls-tx">
                  tx
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="ls-head">
          SOLD <span className="dim">· {row.sold} tokens</span>
          <span className="ls-total pos">+{formatEthShort(row.earned)}</span>
        </h4>
        {row.sales.length === 0 ? (
          <p className="dim" style={{ margin: 0, fontSize: 12 }}>
            nothing sold — {row.held} token{row.held === 1 ? "" : "s"} still held.
          </p>
        ) : (
          <ul className="ls-list">
            {row.sales.map((sale) => (
              <li key={`${sale.txHash}-${sale.tokenId}`}>
                <span className="ls-when dim">{whenOf(sale.at)}</span>
                <span className="ls-what">
                  #{sale.tokenId} from <Addr value={sale.wallet} head={6} />
                </span>
                <span className={sale.priced === false ? "ls-amt dim" : "ls-amt pos"}>
                  {sale.priced === false ? "unpriced" : `+${formatEthShort(BigInt(sale.wei))}`}
                </span>
                <a href={tx(sale.txHash)} target="_blank" rel="noreferrer" className="ls-tx">
                  tx
                </a>
              </li>
            ))}
          </ul>
        )}
        {row.unpriced > 0 ? (
          <p className="dim hint" style={{ marginBottom: 0 }}>
            {row.unpriced} sale{row.unpriced === 1 ? "" : "s"} the node would not
            price — a transfer with no payment in ETH, or a block whose balance
            history this node no longer keeps. Revenue excludes them.
          </p>
        ) : null}
      </section>
    </div>
  );
}
