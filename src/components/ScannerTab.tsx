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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import { useCustomRpcs } from "../lib/customRpc";
import {
  applyFilter,
  classify,
  isSoldOut,
  sortForScan,
  type DropState,
  type ScannedDrop,
} from "../lib/dropScan";
import { twitterUrl, type CollectionInfo } from "../lib/collectionInfo";
import { accountAge, compactCount } from "../lib/twitterStats";
import { larpReport, riskBand, type LarpReport } from "../lib/larp";
import { cumulativeFromSpark, type MintPulse } from "../lib/mintPulse";
import { reuseBand, type IndexedCollection } from "../lib/creatorIndex";
import RelatedPopover, { ReuseBadge, anchorFrom, useRelated } from "./RelatedPopover";
import { openSeaCollectionUrlBySlug } from "../chains";
import { setPendingTarget } from "../lib/snipeTarget";
import { isSharedView } from "../lib/shareLink";
import { sndFeedTick } from "../lib/sound";
import Addr from "./Addr";
import StaleServer from "./StaleServer";

interface ScanView {
  drops: ScannedDrop[];
  /** True when the server topped the last scan up instead of re-reading it. */
  incremental?: boolean;
  newDrops?: number;
  hours: number;
  events: number;
  collections: number;
  enriched: number;
  fromBlock: number;
  toBlock: number;
  blocksPerHour: number;
  /** Host of the endpoint the server actually read through. */
  readRpc?: string;
  /** True when that was the chain's public RPC, with nothing better set. */
  publicRpc?: boolean;
  /** Minting over the last hour, keyed by lower-case contract. */
  pulse?: Record<string, MintPulse>;
  pulseHours?: number;
  nativeSymbol?: string;
  nativeUsd?: number | null;
  /** Owner and handle groupings, accumulated by the server across scans. */
  related?: { owners?: Record<string, IndexedCollection[]>; twitters?: Record<string, IndexedCollection[]> };
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

/**
 * Auto-refresh intervals.
 *
 * A refresh reads only the blocks since the last one: one small log query,
 * about 85 Alchemy compute units. Ten seconds of that is ~22M units a month —
 * a rounding error against any paid plan — which is why the fastest option can
 * be this fast without a warning attached to it.
 */
const INTERVALS = [
  { secs: 0, label: "off" },
  { secs: 10, label: "10s" },
  { secs: 30, label: "30s" },
  { secs: 60, label: "1m" },
  { secs: 300, label: "5m" },
] as const;

const STATES: { key: DropState | "all"; label: string }[] = [
  { key: "live", label: "live" },
  { key: "soon", label: "next 24h" },
  { key: "upcoming", label: "later" },
  { key: "all", label: "everything" },
];

type SortKey =
  | "start"
  | "name"
  | "price"
  | "supply"
  | "wallet"
  | "twitter"
  | "floor"
  | "mints"
  | "risk";

/**
 * How often the table is allowed to reorder itself.
 *
 * The countdowns tick every second, but re-sorting on every tick made rows
 * jump under the cursor and the column widths breathe with them. Ordering is a
 * property of the minute, not of the second, so it moves on its own slower
 * clock while the numbers stay live.
 */
const REORDER_MS = 20_000;

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

/**
 * A number from the server, or a dash.
 *
 * Everything in the footer line comes straight off the response, and a server
 * one version behind — or any response that isn't the shape expected — used to
 * take the whole tab down with "cannot read properties of undefined". A
 * missing figure should cost that figure, not the page.
 */
function num(v: number | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—";
}

/** A typed number box that stays empty rather than falling back to zero. */
function numberOrUndefined(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A mint rate a person reads at a glance: 0.4/min is not "0". */
function fmtRate(perMin: number): string {
  if (perMin <= 0) return "quiet";
  if (perMin < 1) return `${perMin.toFixed(1)}/m`;
  if (perMin < 1000) return `${Math.round(perMin)}/m`;
  return `${(perMin / 1000).toFixed(1)}k/m`;
}

/**
 * The shape of the last hour's minting.
 *
 * Drawn from the buckets the server already sends, so it costs nothing extra.
 * The shape is the point: a wall in one bucket and a flat line after it is a
 * different drop from a steady climb, even when both end at the same supply.
 */
function MintCurve({ spark }: { spark: readonly number[] }) {
  const cum = cumulativeFromSpark(spark);
  const total = cum[cum.length - 1] ?? 0;
  if (total <= 0) return null;
  const W = 240;
  const H = 54;
  const step = cum.length > 1 ? W / (cum.length - 1) : W;
  const pts = cum.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / total) * H).toFixed(1)}`);
  return (
    <svg className="mint-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label={`${total} minted over the last hour`}>
      <polyline points={`0,${H} ${pts.join(" ")} ${W},${H}`} className="mc-fill" />
      <polyline points={pts.join(" ")} className="mc-line" />
    </svg>
  );
}

/** OpenSea shows a wallet's collections on its profile page. */
function openSeaProfile(address: string): string {
  return `https://opensea.io/${address}`;
}

const STATUS_CLASS: Record<string, string> = {
  ok: "risk-ok",
  warn: "risk-warn",
  bad: "risk-bad",
  info: "faint",
};

/**
 * The reasons behind the score.
 *
 * The number in the column is a summary and summaries are worth exactly as
 * much as the working behind them, so every check shows the fact it was
 * decided from and the reader can disagree with any of them. The mint curve
 * sits alongside because the shape of a mint says something no single check
 * does — a wall at one minute and a flat line after it is a different drop
 * from a steady climb, even when both end at the same supply.
 */
function RiskDetail({
  drop,
  report,
  pulse,
  meta,
}: {
  drop: ScannedDrop;
  report?: LarpReport;
  pulse?: MintPulse;
  meta?: CollectionInfo;
}) {
  if (!report) return <span className="dim">nothing read for this collection yet.</span>;
  return (
    <div className="risk-detail">
      <div className="risk-checks">
        {report.checks.map((c) => (
          <div key={c.id} className="risk-check">
            <span className={`risk-dot ${STATUS_CLASS[c.status]}`}>
              {c.status === "ok" ? "✓" : c.status === "info" ? "?" : c.status === "warn" ? "!" : "✕"}
            </span>
            <span className="risk-label">{c.label}</span>
            <span className="risk-evidence dim">{c.detail}</span>
          </div>
        ))}
        <p className="dim hint" style={{ margin: "8px 0 0" }}>
          Score is the weighted average of what could be decided; a check
          nobody could answer carries no weight, so an unknown never counts as
          a pass — it lowers how much of this was known instead.
        </p>
      </div>

      <div className="risk-side">
        {pulse && pulse.txs > 0 ? (
          <>
            <MintCurve spark={pulse.spark ?? []} />
            <div className="risk-stat">
              <span className="rs-label">minted, last hour</span>
              <span className="rs-value">{pulse.quantity.toLocaleString("en-US")}</span>
            </div>
            <div className="risk-stat">
              <span className="rs-label">wallets</span>
              <span className="rs-value">
                {pulse.wallets.toLocaleString("en-US")}{" "}
                <span className="dim">of {pulse.txs.toLocaleString("en-US")} txs</span>
              </span>
            </div>
            <div className="risk-stat">
              <span className="rs-label">biggest wallet</span>
              <span className={`rs-value ${pulse.top1 > 0.35 ? "risk-bad" : ""}`}>
                {Math.round(pulse.top1 * 100)}%
              </span>
            </div>
            <div className="risk-stat">
              <span className="rs-label">top five</span>
              <span className="rs-value">{Math.round(pulse.top5 * 100)}%</span>
            </div>
            <div className="risk-stat">
              <span className="rs-label">busiest minute</span>
              <span className={`rs-value ${pulse.burst > 0.6 ? "risk-warn" : ""}`}>
                {Math.round(pulse.burst * 100)}% of it
              </span>
            </div>
          </>
        ) : (
          <div className="risk-stat">
            <span className="rs-label">minting</span>
            <span className="rs-value dim">nothing in the last hour</span>
          </div>
        )}
        {meta?.site ? (
          <div className="risk-stat">
            <span className="rs-label">site</span>
            <a className="rs-value" href={meta.site} target="_blank" rel="noreferrer">
              {meta.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            </a>
          </div>
        ) : null}
        {drop.owner ? (
          <div className="risk-stat">
            <span className="rs-label">owner</span>
            <span className="rs-value">
              <Addr value={drop.owner} head={10} />
            </span>
          </div>
        ) : null}
        <div className="risk-stat">
          <span className="rs-label">contract</span>
          <span className="rs-value">
            <Addr value={drop.contract} head={10} />
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ScannerTab({ onSnipe }: { onSnipe?: (contract: string) => void }) {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const { urls: customRpcs } = useCustomRpcs();
  const guest = isSharedView();
  const [rpcNote, setRpcNote] = useState<string | null>(null);
  const [view, setView] = useState<ScanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(24);
  const [state, setState] = useState<DropState | "all">("soon");
  const [hideSoldOut, setHideSoldOut] = useState(true);
  const [freeOnly, setFreeOnly] = useState(false);
  const [withTwitter, setWithTwitter] = useState(false);
  const [maxPrice, setMaxPrice] = useState("");
  const [minSupply, setMinSupply] = useState("");
  const [maxSupply, setMaxSupply] = useState("");
  const [minPerWallet, setMinPerWallet] = useState("");
  const [minRisk, setMinRisk] = useState("");
  const [minFollowers, setMinFollowers] = useState("");
  const [mintingNow, setMintingNow] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("start");
  const [desc, setDesc] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [orderAt, setOrderAt] = useState(() => Math.floor(Date.now() / 1000));
  const [every, setEvery] = useState(0);
  const [nextIn, setNextIn] = useState(0);
  const [info, setInfo] = useState<Record<string, CollectionInfo>>({});
  // Contracts that appeared in the most recent refresh, so a new arrival is
  // visible without hunting for it.
  const [justIn, setJustIn] = useState<Set<string>>(new Set());
  /** The one row whose checks are on screen. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /** Handle groupings arrive with the marketplace lookup, not with the scan. */
  const [twitterRelated, setTwitterRelated] = useState<Record<string, IndexedCollection[]>>({});
  const related = useRelated();
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(
    async (h: number, fresh = false) => {
      setBusy(true);
      setError(null);
      try {
        save();
        const r = (await call(
          `/api/scan?hours=${h}${fresh ? "&fresh=1" : ""}`,
        )) as unknown as ScanView;
        // What is new since the last look. On the first scan everything is
        // new, which is not news — so the baseline is set silently.
        // A response missing its drops is a server that answered something
        // else; showing an empty scan beats throwing a `.map of undefined`.
        const found = r.drops ?? [];
        const ids = new Set(found.map((d) => d.contract.toLowerCase()));
        if (seen.current) {
          const arrived = [...ids].filter((c) => !seen.current!.has(c));
          if (arrived.length > 0) {
            setJustIn(new Set(arrived));
            sndFeedTick();
          }
        }
        seen.current = ids;
        setView({ ...r, drops: found });
        const t = Math.floor(Date.now() / 1000);
        setNow(t);
        setOrderAt(t);
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

  /**
   * Hand the server the endpoint this browser is set up with.
   *
   * A scan is by far the heaviest read the box makes, and until now the only
   * page that pushed the user's endpoint down to it was the Snipe tab — so
   * someone who opened the Scanner first was scanning through the chain's
   * public RPC without being told, and getting rate-limited for it. The
   * endpoint is one shared setting; every page that leans on it should be able
   * to install it.
   */
  const pushRpcs = useCallback(async () => {
    if (customRpcs.length === 0) return;
    try {
      await call("/api/rpcs", {
        method: "POST",
        body: JSON.stringify({ extraRpcs: customRpcs }),
      });
      setRpcNote(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // An older server has no such route; the stale-server notice covers it.
      setRpcNote(/HTTP 404/.test(msg) ? null : msg);
    }
  }, [call, customRpcs]);

  useEffect(() => {
    if (!base || !token) return;
    // Install the endpoint first, so the very first scan already goes through
    // it rather than discovering the public RPC's limit the hard way.
    void pushRpcs().then(() => load(hours));
    // Only on mount: every other load is a click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdowns would otherwise go stale while the tab sits open. The ordering
  // clock runs alongside it, far slower, so the table stops moving underfoot.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const o = setInterval(() => setOrderAt(Math.floor(Date.now() / 1000)), REORDER_MS);
    return () => {
      clearInterval(t);
      clearInterval(o);
    };
  }, []);

  /**
   * The refresh loop.
   *
   * Paused while the tab is hidden: a scanner left open in a background tab
   * for a week would otherwise spend its budget on drops nobody is looking at,
   * and the first refresh on return catches up anyway.
   */
  useEffect(() => {
    if (!every || !base || !token) {
      setNextIn(0);
      return;
    }
    setNextIn(every);
    const t = setInterval(() => {
      setNextIn((n) => {
        if (n > 1) return n - 1;
        if (document.visibilityState === "visible") void load(hours);
        return every;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [every, hours, base, token, load]);

  const filter = useMemo(
    () => ({
      state,
      hideSoldOut,
      freeOnly,
      search,
      maxPriceWei: (() => {
        const t = maxPrice.trim();
        if (!t) return undefined;
        try {
          return parseEther(t as `${number}`);
        } catch {
          return undefined;
        }
      })(),
      minSupply: numberOrUndefined(minSupply),
      maxSupply: numberOrUndefined(maxSupply),
      minPerWallet: numberOrUndefined(minPerWallet),
    }),
    [state, hideSoldOut, freeOnly, search, maxPrice, minSupply, maxSupply, minPerWallet],
  );

  const filtered = useMemo(() => {
    const all = view?.drops ?? [];
    const kept = applyFilter(all, filter, orderAt);
    // Held apart from applyFilter because it is the one condition that depends
    // on something read off-chain, and a row whose lookup has not landed yet
    // must not be claimed to have no account.
    return withTwitter ? kept.filter((d) => info[d.contract.toLowerCase()]?.twitter) : kept;
  }, [view, filter, withTwitter, info, orderAt]);

  /**
   * How many collections in this scan each owner launched.
   *
   * Counted across the whole window rather than the filtered rows: the
   * question is what this address has been doing, and a filter that happens to
   * hide eleven of its twelve drops must not make the twelfth look like a
   * one-off.
   */
  const ownerCounts = useMemo(() => {
    const by = new Map<string, number>();
    // The server's index is the better answer where it has one: it remembers
    // every scan this session, while the loaded window is only ever a slice.
    const indexed = view?.related?.owners ?? {};
    for (const [owner, list] of Object.entries(indexed)) by.set(owner, list.length);
    for (const d of view?.drops ?? []) {
      if (!d.owner) continue;
      const key = d.owner.toLowerCase();
      if (indexed[key]) continue;
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    return by;
  }, [view]);

  /**
   * The risk report for every row that survived the filters.
   *
   * Scored here rather than on the server because every input is already in
   * the browser — the drop from the scan, the account from the lookup, the
   * minting from the pulse — and because a score computed next to the table
   * updates the moment any of the three does, instead of on the next scan.
   * Only the filtered rows are scored: a 7-day window is a couple of thousand
   * collections and almost none of them are on screen.
   */
  const reports = useMemo(() => {
    const out: Record<string, LarpReport> = {};
    if (!view) return out;
    for (const d of filtered) {
      const key = d.contract.toLowerCase();
      const m = info[key];
      const p = view.pulse?.[key];
      out[key] = larpReport({
        priceWei: d.priceWei,
        maxPerWallet: d.maxPerWallet,
        feeBps: d.feeBps,
        maxSupply: d.maxSupply,
        minted: d.minted,
        twitter: m ? m.twitter : undefined,
        followers: m?.followers,
        joinedMs: m?.joinedMs,
        floorUnit: m ? (m.floor?.unit ?? null) : undefined,
        floorSymbol: m?.floor?.symbol ?? null,
        floorUsd: m?.floor?.usd ?? null,
        nativeSymbol: view.nativeSymbol,
        nativeUsd: view.nativeUsd,
        baseURI: d.baseURI,
        provenanceHash: d.provenanceHash,
        perMin: p?.perMin,
        uniqueness: p ? p.uniqueness : undefined,
        mintTxs: p?.txs,
        top1: p?.top1,
        // This collection excluded — the question is who else it came with.
        siblings: d.owner ? Math.max(0, (ownerCounts.get(d.owner.toLowerCase()) ?? 1) - 1) : undefined,
        siblingWindowHours: view.hours,
        now,
      });
    }
    return out;
    // `now` deliberately absent: the account-age check moves by the day, and
    // rebuilding a few hundred reports every second to watch it would be the
    // one thing on this page that is expensive for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, info, view, ownerCounts]);

  /**
   * The filters that run on what the browser worked out rather than on what
   * the chain said. They stack with all the others; they just cannot live in
   * `applyFilter`, which is pure over a scanned drop and knows nothing about
   * follower counts or scores.
   */
  const visible = useMemo(() => {
    const risk = numberOrUndefined(minRisk);
    const followers = numberOrUndefined(minFollowers);
    if (risk === undefined && followers === undefined && !mintingNow) return filtered;
    return filtered.filter((d) => {
      const key = d.contract.toLowerCase();
      // A row whose score could not be worked out is not a row that scored
      // badly, so a minimum excludes it rather than passing it silently.
      if (risk !== undefined && (reports[key]?.score ?? -1) < risk) return false;
      if (followers !== undefined && (info[key]?.followers ?? -1) < followers) return false;
      if (mintingNow && !((view?.pulse?.[key]?.perMin ?? 0) > 0)) return false;
      return true;
    });
  }, [filtered, reports, info, view, minRisk, minFollowers, mintingNow]);

  const rows = useMemo(() => {
    if (sort === "start") {
      const s = sortForScan(visible, orderAt);
      return desc ? s.reverse() : s;
    }
    const dir = desc ? -1 : 1;
    // Rows whose lookup has not landed sort as if they had nothing, so an
    // unfilled column never floats to the top and looks like a result.
    const at = (d: ScannedDrop) => info[d.contract.toLowerCase()];
    const pulseOf = (d: ScannedDrop) => view?.pulse?.[d.contract.toLowerCase()];
    return [...visible].sort((a, b) => {
      if (sort === "name") return dir * (a.name ?? a.contract).localeCompare(b.name ?? b.contract);
      if (sort === "price") return dir * (Number(a.priceWei) - Number(b.priceWei));
      if (sort === "wallet")
        return dir * ((a.maxPerWallet || Infinity) - (b.maxPerWallet || Infinity));
      if (sort === "twitter") return dir * ((at(a)?.followers ?? -1) - (at(b)?.followers ?? -1));
      if (sort === "floor") return dir * ((at(a)?.floor?.unit ?? -1) - (at(b)?.floor?.unit ?? -1));
      if (sort === "mints") return dir * ((pulseOf(a)?.perMin ?? -1) - (pulseOf(b)?.perMin ?? -1));
      if (sort === "risk") {
        return (
          dir *
          ((reports[a.contract.toLowerCase()]?.score ?? -1) -
            (reports[b.contract.toLowerCase()]?.score ?? -1))
        );
      }
      return dir * ((a.maxSupply ?? 0) - (b.maxSupply ?? 0));
    });
  }, [visible, info, view, reports, sort, desc, orderAt]);

  /**
   * Who the collections on screen are, and what their floors are.
   *
   * Each answer is a two-megabyte page fetch on the server, so this asks only
   * about the rows actually being looked at, and only about the ones it has no
   * answer for yet. The server replies immediately with what it has cached and
   * reads the rest in the background, which is what the second ask collects.
   */
  const wanted = useMemo(
    () =>
      rows
        .slice(0, 40)
        .map((d) => d.contract)
        .filter((c) => {
          const have = info[c.toLowerCase()];
          // A handle whose follower count is still being read counts as
          // unanswered, so the second half of the cell arrives too.
          return !have || (have.twitter !== null && have.followers === undefined);
        }),
    [rows, info],
  );

  useEffect(() => {
    if (!base || !token || wanted.length === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async (round: number) => {
      try {
        const r = (await call(
          `/api/collection-info?contracts=${wanted.join(",")}`,
        )) as unknown as {
          known?: Record<string, CollectionInfo>;
          pending?: string[];
          twitters?: Record<string, IndexedCollection[]>;
        };
        if (!alive) return;
        if (r.known && Object.keys(r.known).length > 0) {
          setInfo((prev) => ({ ...prev, ...r.known }));
        }
        if (r.twitters) setTwitterRelated((prev) => ({ ...prev, ...r.twitters }));
        // Background reads finish in a second or two; a handful of rounds is
        // plenty, and stopping is better than asking forever about a page
        // OpenSea will not serve.
        if (r.pending?.length && round < 6) timer = setTimeout(() => void ask(round + 1), 3000);
      } catch {
        // An older server has no such route. The column then says nothing,
        // which is exactly what it should say when nothing is known.
      }
    };
    // Debounced: typing in a filter changes `rows` on every keystroke.
    timer = setTimeout(() => void ask(0), 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wanted, base, token, call]);

  const counts = useMemo(() => {
    const all = view?.drops ?? [];
    const of = (s: DropState) => all.filter((d) => classify(d, orderAt) === s).length;
    return { live: of("live"), soon: of("soon"), upcoming: of("upcoming"), all: all.length };
  }, [view, orderAt]);

  const bounded =
    maxPrice.trim() !== "" ||
    minSupply.trim() !== "" ||
    maxSupply.trim() !== "" ||
    minPerWallet.trim() !== "" ||
    minRisk.trim() !== "" ||
    minFollowers.trim() !== "" ||
    search.trim() !== "" ||
    freeOnly ||
    withTwitter ||
    mintingNow;

  function clearBounds() {
    setMaxPrice("");
    setMinSupply("");
    setMaxSupply("");
    setMinPerWallet("");
    setMinRisk("");
    setMinFollowers("");
    setSearch("");
    setFreeOnly(false);
    setWithTwitter(false);
    setMintingNow(false);
  }

  function header(key: SortKey, label: string, className = "") {
    return (
      <th
        className={`sortable ${className}`.trim()}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            // The interesting end differs per column: the biggest supply and
            // the largest following, but the cheapest floor.
            setDesc(key === "supply" || key === "price" || key === "twitter");
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

        {guest ? null : (
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
        )}

        {/* How much chain to read. Nothing here changes what is shown — only
            what has been fetched — which is why it sits apart from the filters
            below it. */}
        <div className="scan-bar">
          <span className="bar-label">WINDOW</span>
          <div className="chip-group">
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
              title="Ignore the cached result and read the whole window again"
            >
              {busy ? <span className="spin">SCANNING</span> : "re-scan"}
            </button>
          </div>

          <span className="bar-label bar-gap">AUTO</span>
          <div className="chip-group">
            {INTERVALS.map((i) => (
              <button
                key={i.secs}
                className={every === i.secs ? "secondary active-chip" : "secondary"}
                disabled={!base || !token}
                onClick={() => setEvery(i.secs)}
                title={
                  i.secs
                    ? "Reads only the blocks since the last look — one small query"
                    : "No automatic refreshing"
                }
              >
                {i.label}
              </button>
            ))}
          </div>

          <div className="bar-tail">
            {every ? (
              <span className="pill">
                next in <b>{nextIn}s</b>
                {view?.incremental ? " · incremental" : ""}
              </span>
            ) : null}
            {view ? (
              <span className="pill ok">
                {num(view.collections)} found · {num(view.enriched)} read ·{" "}
                {((view.tookMs ?? 0) / 1000).toFixed(1)}s
                {view.cachedAt
                  ? ` · ${Math.max(0, Math.round((Date.now() - view.cachedAt) / 1000))}s ago`
                  : ""}
              </span>
            ) : null}
            {view?.readRpc ? (
              <span
                className={view.publicRpc ? "pill warn" : "pill"}
                title={
                  view.publicRpc
                    ? "The chain's public RPC meters requests and answers a scan with 429. Paste your own endpoint in the Snipe tab and it is used here too."
                    : "The endpoint this server reads through"
                }
              >
                via <b>{view.readRpc}</b>
                {view.publicRpc ? " · public" : ""}
              </span>
            ) : null}
          </div>
        </div>

        {error ? <p className="error">{error}</p> : null}
        {rpcNote ? <p className="error">endpoint refused: {rpcNote}</p> : null}
        {error && /429|rate limit/i.test(error) && customRpcs.length === 0 ? (
          <p className="dim hint">
            That was the chain's public RPC, which meters requests and answers a
            scan of this size with 429. Paste your own endpoint in the RPC box
            on the Snipe tab — it is one shared setting, and the scanner picks
            it up from there.
          </p>
        ) : null}
        {error && /429|rate limit/i.test(error) && customRpcs.length > 0 ? (
          <p className="dim hint">
            <button className="secondary link-btn" onClick={() => void pushRpcs().then(() => load(hours, true))}>
              install {customRpcs.length === 1 ? "your endpoint" : "your endpoints"} and re-scan
            </button>{" "}
            — this browser has one set, but the server was reading through
            something else.
          </p>
        ) : null}
        <StaleServer version={serverVersion} />

        {view ? (
          /* Filters: what of the scan to show. Every one of them stacks with
             every other, so a row survives only by satisfying all of them. */
          <div className="scan-filters">
            <div className="scan-bar">
              <span className="bar-label">SHOW</span>
              <div className="chip-group">
                {STATES.map((s) => (
                  <button
                    key={s.key}
                    className={state === s.key ? "secondary active-chip" : "secondary"}
                    onClick={() => setState(s.key)}
                  >
                    {s.label} (
                    {s.key === "all" ? counts.all : counts[s.key as keyof typeof counts]})
                  </button>
                ))}
              </div>
              <div className="bar-tail">
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
                <button
                  className={withTwitter ? "secondary active-chip" : "secondary"}
                  onClick={() => setWithTwitter(!withTwitter)}
                  title="Only collections with an account connected on OpenSea"
                >
                  has twitter
                </button>
                <button
                  className={mintingNow ? "secondary active-chip" : "secondary"}
                  onClick={() => setMintingNow(!mintingNow)}
                  title="Only collections that took a mint in the last hour"
                >
                  minting now
                </button>
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
                <label>per wallet ≥</label>
                <input
                  inputMode="numeric"
                  value={minPerWallet}
                  onChange={(e) => setMinPerWallet(e.target.value)}
                  placeholder="any"
                />
              </div>
              <div className="field">
                <label>risk ≥</label>
                <input
                  inputMode="numeric"
                  value={minRisk}
                  onChange={(e) => setMinRisk(e.target.value)}
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
              <div className="field filter-search">
                <label>search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="name or contract address"
                />
              </div>
            </div>

            <div className="filter-status">
              <span className="dim">
                {rows.length} of {num(view.collections)} shown
              </span>
              {bounded ? (
                <button className="secondary link-btn" onClick={clearBounds}>
                  clear filters
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {view && rows.length > 0 ? (
          <div className="table-wrap">
            <table className="ledger-table collapsible scan-table">
              {/* Fixed widths, so a long collection name or a countdown ticking
                  from "1h 00m" to "59m 59s" cannot re-measure the whole table
                  under the reader. */}
              <colgroup>
                <col style={{ width: 124 }} />
                <col />
                <col style={{ width: 130 }} />
                <col style={{ width: 138 }} />
                <col style={{ width: 82 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 82 }} />
                <col style={{ width: 74 }} />
              </colgroup>
              <thead>
                <tr>
                  {header("start", "opens")}
                  {header("name", "collection")}
                  {header("twitter", "twitter")}
                  <th>creator</th>
                  {header("price", "price", "num")}
                  {header("floor", "floor", "num")}
                  {header("supply", "supply", "num")}
                  {header("wallet", "per wallet", "num")}
                  {header("mints", "minting", "num")}
                  {header("risk", "risk", "num")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const st = classify(d, now);
                  const sold = isSoldOut(d);
                  const away = d.startTime ? d.startTime - now : null;
                  const meta = info[d.contract.toLowerCase()];
                  const key = d.contract.toLowerCase();
                  const pulse = view.pulse?.[key];
                  const report = reports[key];
                  const band = riskBand(report?.score ?? null);
                  const open = openRow === key;
                  return (
                    <Fragment key={d.contract}>
                    <tr
                      className={`project-row${justIn.has(key) ? " feed-row" : ""}${open ? " row-open" : ""}`}
                      onClick={() => setOpenRow(open ? null : key)}
                      title="Open the risk breakdown"
                    >
                      <td data-label="opens">
                        <span className={`cell-name cd ${STATE_CLASS[st]}`}>
                          {st === "live"
                            ? "LIVE"
                            : st === "ended"
                              ? "ended"
                              : st === "pending"
                                ? "no date"
                                : countdown(away ?? 0)}
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
                      <td data-label="collection" className="cell-clip">
                        <a
                          className="cell-name"
                          href={openSeaCollectionUrlBySlug(view.openSeaSlug, d.contract)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title={d.name ?? d.contract}
                        >
                          {d.name ?? `${d.contract.slice(0, 10)}…`}
                        </a>
                        <span className="cell-sub dim">
                          <Addr value={d.contract} head={8} />
                          {sold ? <span className="pill-tba"> SOLD OUT</span> : null}
                        </span>
                      </td>
                      <td data-label="twitter" className="cell-clip">
                        {meta === undefined ? (
                          /* Not looked up yet — which is not the same claim as
                             "has none", so it does not say so. */
                          <span className="faint" title="looking this one up">
                            ···
                          </span>
                        ) : meta.twitter ? (
                          <>
                            <span className="cell-name tw-handle">
                              <a
                                href={twitterUrl(meta.twitter)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title={`@${meta.twitter}`}
                              >
                                @{meta.twitter}
                              </a>
                              {(() => {
                                // How many collections have launched under this
                                // handle. One is unremarkable; four is the
                                // finding, so nothing is drawn below two.
                                const all = twitterRelated[meta.twitter!.toLowerCase()] ?? [];
                                const band = reuseBand(all.length);
                                if (band === "none") return null;
                                return (
                                  <ReuseBadge
                                    count={all.length}
                                    band={band}
                                    onEnter={(e) =>
                                      related.open(
                                        anchorFrom(e, `@${meta.twitter} has launched`, all),
                                      )
                                    }
                                    onLeave={related.close}
                                  />
                                );
                              })()}
                            </span>
                            <span className="cell-sub dim">
                              {meta.followers === undefined ? (
                                <span className="faint">···</span>
                              ) : (
                                <>
                                  {/* A handle says nothing on its own; these
                                      two numbers are what it is read for. */}
                                  <span className={meta.followers < 100 ? "warn" : ""}>
                                    {compactCount(meta.followers)}
                                  </span>{" "}
                                  followers
                                  {meta.joinedMs
                                    ? ` · ${accountAge(meta.joinedMs, now * 1000)}`
                                    : ""}
                                </>
                              )}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="faint" title="no account connected on OpenSea">
                              —
                            </span>
                            {meta.site ? (
                              <a
                                className="cell-sub dim"
                                href={meta.site}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title={meta.site}
                              >
                                {meta.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                              </a>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td data-label="creator" className="cell-clip">
                        {d.owner ? (
                          <>
                            <span className="cell-name">
                              <a
                                href={openSeaProfile(d.owner)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title="Open this wallet's OpenSea profile"
                              >
                                {d.owner.slice(0, 6)}…{d.owner.slice(-4)}
                              </a>
                              {(() => {
                                const all =
                                  view.related?.owners?.[d.owner!.toLowerCase()] ??
                                  [];
                                const count = Math.max(all.length, ownerCounts.get(d.owner!.toLowerCase()) ?? 1);
                                const band = reuseBand(count);
                                if (band === "none") return null;
                                return (
                                  <ReuseBadge
                                    count={count}
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
                          </>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="num" data-label="price">
                        {BigInt(d.priceWei) === 0n ? (
                          <span className="ok">free</span>
                        ) : (
                          formatEther(BigInt(d.priceWei))
                        )}
                      </td>
                      <td className="num" data-label="floor">
                        {meta === undefined ? (
                          <span className="faint">···</span>
                        ) : meta.floor ? (
                          <>
                            <span className="cell-name">
                              {meta.floor.unit} <span className="dim">{meta.floor.symbol}</span>
                            </span>
                            {meta.floor.usd !== null ? (
                              <span className="cell-sub dim">${meta.floor.usd.toFixed(2)}</span>
                            ) : null}
                          </>
                        ) : (
                          /* No listings yet, which is normal for a drop this
                             early — and very different from a floor of zero. */
                          <span className="faint" title="nothing listed yet">
                            —
                          </span>
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
                      <td className="num" data-label="minting">
                        {pulse ? (
                          <>
                            <span className="cell-name">{fmtRate(pulse.perMin)}</span>
                            <span className="cell-sub dim">
                              {pulse.uniqueness === null ? (
                                `${pulse.txs} tx`
                              ) : (
                                <span className={pulse.uniqueness < 0.4 ? "warn" : ""}>
                                  {Math.round(pulse.uniqueness * 100)}% uniq
                                </span>
                              )}
                            </span>
                          </>
                        ) : (
                          <span className="faint" title={`no mints in the last ${view.pulseHours ?? 1}h`}>
                            —
                          </span>
                        )}
                      </td>
                      <td className="num" data-label="risk">
                        {report?.score === null || report === undefined ? (
                          <span className="faint">—</span>
                        ) : (
                          <>
                            <span className={`cell-name risk-${band}`}>{report.score}</span>
                            <span className="cell-sub dim">
                              {Math.round(report.confidence * 100)}% known
                            </span>
                          </>
                        )}
                      </td>
                      <td className="num" data-label="">
                        <button
                          className="secondary"
                          style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                          title="Load this collection in the Snipe tab"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingTarget(d.contract);
                            onSnipe?.(d.contract);
                          }}
                        >
                          snipe
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="detail-row">
                        <td colSpan={11}>
                          <RiskDetail drop={d} report={report} pulse={pulse} meta={info[key]} />
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
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

        <RelatedPopover
          anchor={related.anchor}
          onHold={related.hold}
          onLeave={related.close}
          href={(c) => openSeaCollectionUrlBySlug(view?.openSeaSlug, c)}
        />

        {view ? (
          <p className="dim hint" style={{ marginBottom: 0 }}>
            Read {view.hours}h of {view.chain ?? "the chain"} — blocks{" "}
            {num(view.fromBlock)}–{num(view.toBlock)} at about{" "}
            {num(view.blocksPerHour)} blocks an hour, {num(view.events)} stage
            configurations across {num(view.collections)} collections. Allow-list stages are never
            reported here: this event describes the public stage alone. Twitter comes from the
            marketplace, not the chain — nothing on-chain carries it — so a dash means no account
            is connected there.
          </p>
        ) : null}
      </div>
    </div>
  );
}
