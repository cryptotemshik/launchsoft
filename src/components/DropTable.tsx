/**
 * The drop table, wherever it is shown.
 *
 * The scanner and the watchlist look at the same thing — a collection's public
 * stage, what it costs, who is behind it and what the market has made of it —
 * so they are the same table rather than two that drift. The only difference
 * is what sits in the last column, which is a slot the caller fills.
 *
 * "Public stage" is load-bearing. Everything here comes from SeaDrop's public
 * drop, never an allow-list phase: they live behind a different path on the
 * same contract, so the wrong one is unreachable rather than merely
 * unselected.
 */
import { Fragment, useState, type ReactNode } from "react";
import { formatEther } from "viem";
import { classify, isSoldOut, type DropState, type ScannedDrop } from "../lib/dropScan";
import { twitterUrl, type CollectionInfo } from "../lib/collectionInfo";
import { accountAge, compactCount } from "../lib/twitterStats";
import { riskBand, type LarpReport } from "../lib/larp";
import { cumulativeFromSpark, type MintPulse } from "../lib/mintPulse";
import { reuseBand, type IndexedCollection } from "../lib/creatorIndex";
import { openSeaCollectionUrlBySlug } from "../chains";
import RelatedPopover, { ReuseBadge, anchorFrom, useRelated } from "./RelatedPopover";
import Addr from "./Addr";

export type SortKey =
  | "start"
  | "name"
  | "price"
  | "supply"
  | "wallet"
  | "twitter"
  | "floor"
  | "mints"
  | "risk";

/** A placeholder address is not something to link to or copy. */
export function isReal(contract: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(contract) && !/^0x0+$/.test(contract);
}

const STATE_CLASS: Record<DropState, string> = {
  live: "ok",
  soon: "warn",
  upcoming: "dim",
  pending: "dim",
  ended: "dim",
};

/** A countdown a person reads at a glance, not a stopwatch. */
export function countdown(secs: number): string {
  const s = Math.max(0, secs);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
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

export interface DropTableProps {
  rows: readonly ScannedDrop[];
  info: Record<string, CollectionInfo>;
  reports: Record<string, LarpReport>;
  pulse?: Record<string, MintPulse>;
  /** How many collections in the window share each owner. */
  ownerCounts: Map<string, number>;
  related?: { owners?: Record<string, IndexedCollection[]> };
  twitterRelated: Record<string, IndexedCollection[]>;
  openSeaSlug?: string;
  now: number;
  /** Rows that arrived in the last refresh, so a new one is visible. */
  justIn?: Set<string>;
  sort: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
  /** The last column. The scanner puts snipe there; the watchlist, remove. */
  actions: (d: ScannedDrop) => ReactNode;
  /**
   * Where the collection name should link, or null for a row with nowhere to
   * go. The watchlist holds drops that are still only an account and a
   * rumour: those get their name as text rather than as a link that 404s.
   */
  linkOf?: (d: ScannedDrop) => string | null;
}

export default function DropTable({
  rows,
  info,
  reports,
  pulse,
  ownerCounts,
  related,
  twitterRelated,
  openSeaSlug,
  now,
  justIn,
  sort,
  desc,
  onSort,
  actions,
  linkOf,
}: DropTableProps) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const relatedPop = useRelated();

  function header(key: SortKey, label: string, className = "") {
    return (
      <th className={`sortable ${className}`.trim()} onClick={() => onSort(key)}>
        {label}
        {sort === key ? (desc ? " ▼" : " ▲") : ""}
      </th>
    );
  }

  return (
    <>
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
              <col style={{ width: 132 }} />
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
                const rowPulse = pulse?.[key];
                const report = reports[key];
                const band = riskBand(report?.score ?? null);
                const open = openRow === key;
                /**
                 * Whether there is a public stage behind this row at all.
                 *
                 * The watchlist holds drops that are still only an account and
                 * a rumour. They belong in the table, but every column that
                 * describes a stage has to read as unknown rather than as
                 * zero — "free" and "∞" are claims, and nobody made them.
                 */
                const staged = isReal(d.contract);
                return (
                  <Fragment key={d.contract}>
                  <tr
                    className={`project-row${justIn?.has(key) ? " feed-row" : ""}${open ? " row-open" : ""}`}
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
                      {(() => {
                        const href = linkOf
                          ? linkOf(d)
                          : openSeaCollectionUrlBySlug(openSeaSlug, d.contract);
                        const label = d.name ?? `${d.contract.slice(0, 10)}…`;
                        return href ? (
                          <a
                            className="cell-name"
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={d.name ?? d.contract}
                          >
                            {label}
                          </a>
                        ) : (
                          <span className="cell-name" title={label}>
                            {label}
                          </span>
                        );
                      })()}
                      <span className="cell-sub dim">
                        {/* A synthetic address stands in for a watchlist entry
                            with no contract yet; showing it would be showing a
                            number nobody can use. */}
                        {isReal(d.contract) ? (
                          <Addr value={d.contract} head={8} />
                        ) : (
                          "no contract yet"
                        )}
                        {sold ? <span className="pill-tba"> SOLD OUT</span> : null}
                      </span>
                    </td>
                    <td data-label="twitter" className="cell-clip">
                      {!staged ? (
                        /* Nothing to look up: the lookup is keyed by contract
                           and this row has none. */
                        <span className="faint">—</span>
                      ) : meta === undefined ? (
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
                                    relatedPop.open(
                                      anchorFrom(e, `@${meta.twitter} has launched`, all),
                                    )
                                  }
                                  onLeave={relatedPop.close}
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
                                related?.owners?.[d.owner!.toLowerCase()] ??
                                [];
                              const count = Math.max(all.length, ownerCounts.get(d.owner!.toLowerCase()) ?? 1);
                              const band = reuseBand(count);
                              if (band === "none") return null;
                              return (
                                <ReuseBadge
                                  count={count}
                                  band={band}
                                  onEnter={(e) =>
                                    relatedPop.open(
                                      anchorFrom(e, "this wallet has launched", all),
                                    )
                                  }
                                  onLeave={relatedPop.close}
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
                      {!staged ? (
                        <span className="faint">—</span>
                      ) : BigInt(d.priceWei) === 0n ? (
                        <span className="ok">free</span>
                      ) : (
                        formatEther(BigInt(d.priceWei))
                      )}
                    </td>
                    <td className="num" data-label="floor">
                      {!staged ? (
                        <span className="faint">—</span>
                      ) : meta === undefined ? (
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
                      {!staged ? (
                        <span className="faint">—</span>
                      ) : (
                        d.maxPerWallet || <span className="dim">∞</span>
                      )}
                    </td>
                    <td className="num" data-label="minting">
                      {rowPulse ? (
                        <>
                          <span className="cell-name">{fmtRate(rowPulse.perMin)}</span>
                          <span className="cell-sub dim">
                            {rowPulse.uniqueness === null ? (
                              `${rowPulse.txs} tx`
                            ) : (
                              <span className={rowPulse.uniqueness < 0.4 ? "warn" : ""}>
                                {Math.round(rowPulse.uniqueness * 100)}% uniq
                              </span>
                            )}
                          </span>
                        </>
                      ) : (
                        <span className="faint" title="no mints in the last hour">
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
                  <div className="row-actions">{actions(d)}</div>
                </td>
                  </tr>
                  {open ? (
                    <tr className="detail-row">
                      <td colSpan={11}>
                        <RiskDetail drop={d} report={report} pulse={rowPulse} meta={info[key]} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      <RelatedPopover
        anchor={relatedPop.anchor}
        onHold={relatedPop.hold}
        onLeave={relatedPop.close}
        href={(c) => openSeaCollectionUrlBySlug(openSeaSlug, c)}
      />
    </>
  );
}
