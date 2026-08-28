/**
 * ARBITRAGE — what the spread was, measured rather than assumed.
 *
 * This is the shadow phase. The engine behind it executes nothing and holds no
 * keys: it reads completed Seaport fills, pairs a listing bought in ETH with
 * the best collection offer accepted shortly after, and records what the
 * difference was. That answers the only question worth building an executor
 * for — whether the money is there, and which collections it is in.
 *
 * Every number here is therefore an *upper bound* on what could have been
 * taken, not a claim about what would have been won. The header says so, and
 * nothing on this page is worded as though a trade happened.
 */
import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import { openSeaCollectionUrlBySlug } from "../chains";
import Addr from "./Addr";
import StaleServer from "./StaleServer";

interface Totals {
  trades: number;
  profitEth: number;
}
interface CollectionRow {
  collection: string;
  trades: number;
  profitEth: number;
  lastAt: number;
}
interface LogRow {
  at: number;
  collection: string;
  token_id: string;
  paid_wei: string;
  offer_wei: string;
  gas_wei: string;
  profit_wei: string;
  buy_block: number;
  sell_block: number;
}
interface ArbView {
  enabled: boolean;
  why?: string;
  apiVersion?: number;
  mode?: string;
  settings?: {
    minProfitEth: string;
    maxPaidEth: string;
    windowMinutes: number;
    pollMs: number;
    backfillHours?: number;
  };
  lastPass?: { at: number; note: string } | null;
  lastBlock?: number;
  today?: Totals;
  week?: Totals;
  all?: Totals;
  daily?: { day: string; trades: number; profitEth: number }[];
  hourly?: { hour: string; trades: number; profitEth: number }[];
  collections?: CollectionRow[];
  recent?: LogRow[];
  openSeaSlug?: string;
  now?: number;
}

/** ETH to five places, the way every other number in this app is shown. */
const eth = (wei: string | number) => {
  const n = typeof wei === "number" ? wei : Number(formatEther(BigInt(wei)));
  return n.toFixed(5);
};

const ago = (seconds: number) => {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
};

export default function ArbitrageTab() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [view, setView] = useState<ArbView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [only, setOnly] = useState<string | null>(null);
  const [grain, setGrain] = useState<"hour" | "day">("hour");

  const load = useCallback(
    async (collection?: string | null) => {
      setBusy(true);
      setError(null);
      try {
        save();
        const q = collection ? `?collection=${encodeURIComponent(collection)}` : "";
        setView((await call(`/api/arb${q}`)) as unknown as ArbView);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [call, save],
  );

  useEffect(() => {
    if (base && token) void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The watcher advances on its own; the page follows without a button press.
  useEffect(() => {
    if (!base || !token) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(only);
    }, 20_000);
    return () => clearInterval(t);
  }, [base, token, only, load]);

  const s = view?.settings;

  return (
    <div>
      <div className="panel">
        <h2>Arbitrage</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          A listing sold in ETH and a bid standing in WETH are two prices for
          the same thing. This reads every completed Seaport trade on the chain
          and records where the second was higher than the first — but only
          where the bid can be <b>proven</b> to have been standing at the moment
          the listing was bought.
        </p>
        <p className="warn">
          Observation only. Nothing here trades, holds a key, or sends a
          transaction. What is counted is what was <b>available</b> to whoever
          was fastest — an upper bound, not a forecast of what this machine
          would have won.
        </p>
        <p className="dim" style={{ marginBottom: 0 }}>
          The proof matters more than it sounds. The chain shows when a bid was
          consumed, never when it was placed, and a bid that fills more than
          once lives a median of twelve seconds before it is swept. An earlier
          version paired each purchase with any bid accepted within the next
          fifteen minutes, which quietly assumes bids persist backwards in
          time; over 5.6 hours that reported 253 chances worth 4.50 ETH where
          only 7 worth 0.026 ETH could be shown to have existed. A row appears
          here only when the same bid order filled both before and after the
          purchase — so it demonstrably straddled that moment.
        </p>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>server url</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
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
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="secondary" disabled={busy || !base || !token} onClick={() => void load(only)}>
            {busy ? <span className="spin">READING</span> : "refresh"}
          </button>
          {view?.enabled ? (
            <>
              <span className="pill warn">{view.mode ?? "SHADOW"}</span>
              <span className="pill">
                block {(view.lastBlock ?? 0).toLocaleString("en-US")}
              </span>
              {view.lastPass ? (
                <span className="pill dim">
                  last pass {ago((Date.now() - view.lastPass.at) / 1000)} ago · {view.lastPass.note}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />
      </div>

      {view && !view.enabled ? (
        <div className="panel">
          <h2>Not watching</h2>
          <p className="dim" style={{ marginBottom: 0 }}>
            {view.why ?? "The server is not observing arbitrage."} It is off by
            default because it is a second reader on the chain, and a box that
            only snipes should not pay for it.
          </p>
        </div>
      ) : null}

      {view?.enabled ? (
        <>
          <div className="panel">
            <h2>Spread observed</h2>
            <div className="stat-row">
              {([
                ["24 HOURS", view.today],
                ["7 DAYS", view.week],
                ["ALL TIME", view.all],
              ] as const).map(([label, t]) => (
                <div className="stat-tile" key={label}>
                  <div className="stat-label">{label}</div>
                  <div className={`stat-value ${(t?.profitEth ?? 0) > 0 ? "ok" : "dim"}`}>
                    {(t?.profitEth ?? 0).toFixed(4)}
                  </div>
                  <div className="stat-sub dim">ETH · {t?.trades ?? 0} chances</div>
                </div>
              ))}
              <div className="stat-tile">
                <div className="stat-label">SETTINGS</div>
                <div className="stat-value dim" style={{ fontSize: 15 }}>
                  ≥ {s?.minProfitEth} ETH
                </div>
                <div className="stat-sub dim">
                  buy ≤ {s?.maxPaidEth} · {s?.windowMinutes}m window
                </div>
              </div>
            </div>

            {/* Hours by default: a session someone watches for an afternoon is
                one row by day, which cannot show whether the spread is steady
                or came from a single minute. */}
            <div style={{ display: "flex", gap: 6, marginTop: 14, marginBottom: 8 }}>
              {(["hour", "day"] as const).map((g) => (
                <button
                  key={g}
                  className={grain === g ? "secondary active-chip" : "secondary"}
                  style={{ padding: "3px 12px", fontSize: 11 }}
                  onClick={() => setGrain(g)}
                >
                  by {g}
                </button>
              ))}
            </div>
            {(() => {
              const rows =
                grain === "hour"
                  ? (view.hourly ?? []).map((h) => ({ key: h.hour, ...h }))
                  : (view.daily ?? []).map((d) => ({ key: d.day, ...d }));
              if (rows.length === 0) return null;
              const peak = Math.max(...rows.map((r) => r.profitEth), 0) || 1;
              return (
                <div className="table-wrap">
                  <table className="ledger-table">
                    <thead>
                      <tr>
                        <th>{grain}</th>
                        <th className="num">chances</th>
                        <th className="num">spread (ETH)</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key}>
                          <td className="mono-break">{r.key}</td>
                          <td className="num">{r.trades}</td>
                          <td className="num ok">{r.profitEth.toFixed(5)}</td>
                          <td style={{ width: "40%" }}>
                            {/* A bar rather than a number alone: the shape of
                                six hours is the thing being looked for. */}
                            <div
                              style={{
                                height: 8,
                                width: `${Math.max(2, (r.profitEth / peak) * 100)}%`,
                                background: "var(--green)",
                                opacity: 0.55,
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>

          <div className="panel">
            <h2>Where it is — last 7 days</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              Where the provable spread is concentrated. An earlier reading here
              claimed four collections carried 96% of it; that number came from
              the pairing rule since found to be wrong and should be ignored
              until this table has a day of its own data.
            </p>
            {(view.collections ?? []).length === 0 ? (
              <div className="empty-state">
                NOTHING YET — <span className="es-action">THE WATCHER NEEDS A FEW MINUTES</span>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>collection</th>
                      <th className="num">chances</th>
                      <th className="num">spread (ETH)</th>
                      <th className="num">share</th>
                      <th className="num">last</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const rows = view.collections ?? [];
                      const total = rows.reduce((n, r) => n + r.profitEth, 0) || 1;
                      return rows.map((c) => (
                        <tr key={c.collection}>
                          <td className="mono-break">
                            <a
                              href={openSeaCollectionUrlBySlug(view.openSeaSlug, c.collection)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Addr value={c.collection} head={10} />
                            </a>
                          </td>
                          <td className="num">{c.trades}</td>
                          <td className="num ok">{c.profitEth.toFixed(5)}</td>
                          <td className="num dim">
                            {Math.round((c.profitEth / total) * 100)}%
                          </td>
                          <td className="num dim">
                            {view.now ? `${ago(view.now - c.lastAt)} ago` : "—"}
                          </td>
                          <td className="num">
                            <button
                              className={only === c.collection ? "secondary active-chip" : "secondary"}
                              style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                              onClick={() => {
                                const next = only === c.collection ? null : c.collection;
                                setOnly(next);
                                void load(next);
                              }}
                            >
                              {only === c.collection ? "showing" : "filter log"}
                            </button>
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>
              Log{only ? " — one collection" : ""}{" "}
              {only ? (
                <button
                  className="secondary"
                  style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                  onClick={() => {
                    setOnly(null);
                    void load(null);
                  }}
                >
                  clear
                </button>
              ) : null}
            </h2>
            {(view.recent ?? []).length === 0 ? (
              <div className="empty-state">
                NOTHING LOGGED YET —{" "}
                <span className="es-action">A CHANCE NEEDS A BUY AND A BID CLOSE TOGETHER</span>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>when</th>
                      <th>collection</th>
                      <th className="num">token</th>
                      <th className="num">listing cost</th>
                      <th className="num">offer net</th>
                      <th className="num">gas</th>
                      <th className="num">spread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(view.recent ?? []).map((r) => (
                      <tr key={`${r.buy_block}-${r.collection}-${r.token_id}`}>
                        <td className="dim">
                          {view.now ? `${ago(view.now - r.at)} ago` : new Date(r.at * 1000).toISOString()}
                        </td>
                        <td className="mono-break">
                          <Addr value={r.collection} head={8} />
                        </td>
                        <td className="num dim">#{r.token_id}</td>
                        <td className="num">{eth(r.paid_wei)}</td>
                        <td className="num">{eth(r.offer_wei)}</td>
                        <td className="num dim">{eth(r.gas_wei)}</td>
                        <td className="num ok">+{eth(r.profit_wei)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="dim hint" style={{ marginBottom: 0 }}>
              A row means a listing was bought for the first figure while a bid
              order that filled both before and after stood at the second — so
              the difference was really there. It still does not mean this
              machine would have got the listing. One caveat remains that the
              chain cannot settle: a <b>trait</b> offer fills identically to a
              collection offer here, so an unusually rich bid may only have been
              payable for a token carrying that trait, not for the cheap one
              paired against it. Separating those needs the OpenSea order.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
