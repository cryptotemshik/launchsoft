/**
 * What the sniper's mints cost and what they have made.
 *
 * Distinct from the profit the rest of the dashboard shows, which is about
 * collections you launched. This is the other side: drops you minted from,
 * where the cost is gas and mint price across a hundred wallets and the
 * revenue is whatever those tokens have sold for since.
 *
 * Everything comes from the server, which works it out from the chain — the
 * ledger it wrote while minting, plus each token's departure priced by the
 * seller's balance rise in that block. No marketplace API is involved, so
 * there is nothing to key and nothing to break when one changes.
 */
import { useCallback, useEffect, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { formatEthShort } from "../lib/profit";
import StaleServer from "./StaleServer";

interface Sale {
  wallet: string;
  tokenId: string;
  blockNumber: string;
  txHash: string;
  proceedsWei: string;
}

interface CollectionProfit {
  collection: string;
  collectionName?: string;
  cost?: { gasWei: string; priceWei: string; tokens: number; wallets: number };
  sales?: Sale[];
  soldTokens?: number;
  revenueWei?: string;
  netWei?: string;
  heldTokens?: number;
  unpricedSales?: number;
  runs?: number;
  lastAt?: number;
  error?: string;
}

interface ProfitView {
  chain: string;
  explorerUrl: string;
  openSeaSlug?: string;
  wallets: number;
  collections: CollectionProfit[];
  tookMs: number;
}

const wei = (s: string | undefined) => (s ? BigInt(s) : 0n);

export default function MintProfitPanel() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const [view, setView] = useState<ProfitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      save();
      setView((await call("/api/profit")) as unknown as ProfitView);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /404/.test(msg)
          ? "This server is too old to report profit — update it from the Snipe tab."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }, [call, save]);

  // Load once if the connection is already set up from another tab.
  useEffect(() => {
    if (base && token) void load();
    // Deliberately only on mount: refreshing is a button, not a poll, because
    // each run reads logs for every collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withCost = (view?.collections ?? []).filter((c) => !c.error);
  const totals = withCost.reduce(
    (acc, c) => ({
      spent: acc.spent + wei(c.cost?.gasWei) + wei(c.cost?.priceWei),
      revenue: acc.revenue + wei(c.revenueWei),
      net: acc.net + wei(c.netWei),
      minted: acc.minted + (c.cost?.tokens ?? 0),
      sold: acc.sold + (c.soldTokens ?? 0),
      unpriced: acc.unpriced + (c.unpricedSales ?? 0),
      held: acc.held + (c.heldTokens ?? 0),
    }),
    { spent: 0n, revenue: 0n, net: 0n, minted: 0, sold: 0, held: 0, unpriced: 0 },
  );

  return (
    <div className="panel">
      <h2>Sniped mints — cost &amp; profit</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Read from your server: what each drop cost in gas and mint price, and
        what its tokens have sold for since. A sale is a token leaving one of
        your wallets while that wallet&apos;s balance rises in the same block —
        no OpenSea account or API key involved.
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
          {busy ? "reading the chain…" : view ? "refresh" : "load"}
        </button>
        {view ? (
          <span className="pill ok">
            ● {view.wallets} wallets · {view.collections.length} collection
            {view.collections.length === 1 ? "" : "s"} · {(view.tookMs / 1000).toFixed(1)}s
          </span>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      <StaleServer version={serverVersion} />

      {view && withCost.length > 0 ? (
        <>
          <div className={`profit-big ${totals.net >= 0n ? "profit-pos" : "profit-neg"}`}>
            {totals.net >= 0n ? "▲ +" : "▼ "}
            {formatEthShort(totals.net)} ETH
          </div>
          <p className="dim hint">
            spent {formatEthShort(totals.spent)} ETH · earned{" "}
            {formatEthShort(totals.revenue)} ETH · {totals.minted} minted,{" "}
            {totals.sold} sold, {totals.held} still held
          </p>
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
            <table>
              <thead>
                <tr>
                  <th>collection</th>
                  <th>minted</th>
                  <th>spent</th>
                  <th>sold</th>
                  <th>earned</th>
                  <th>net</th>
                </tr>
              </thead>
              <tbody>
                {withCost.map((c) => {
                  const net = wei(c.netWei);
                  const spent = wei(c.cost?.gasWei) + wei(c.cost?.priceWei);
                  const isOpen = open === c.collection;
                  return (
                    <>
                      <tr
                        key={c.collection}
                        className="project-row"
                        onClick={() => setOpen(isOpen ? null : c.collection)}
                      >
                        <td>
                          {c.collectionName ?? `${c.collection.slice(0, 10)}…`}
                          {c.runs ? <span className="dim"> · {c.runs} run{c.runs === 1 ? "" : "s"}</span> : null}
                        </td>
                        <td className="dim">
                          {c.cost?.tokens ?? 0}
                          {c.cost?.wallets ? ` / ${c.cost.wallets}w` : ""}
                        </td>
                        <td className="dim">{formatEthShort(spent)}</td>
                        <td className="dim">{c.soldTokens ?? 0}</td>
                        <td className="dim">{formatEthShort(wei(c.revenueWei))}</td>
                        <td className={net >= 0n ? "ok" : "error"}>
                          {net >= 0n ? "+" : ""}
                          {formatEthShort(net)}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr key={`${c.collection}-detail`}>
                          <td colSpan={6}>
                            <SaleList
                              sales={c.sales ?? []}
                              explorerUrl={view.explorerUrl}
                              held={c.heldTokens ?? 0}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {view && withCost.length === 0 ? (
        <p className="dim hint">
          Nothing minted through this server yet. Queue a drop in the Snipe tab
          and its cost is recorded as it runs.
        </p>
      ) : null}

      {view?.collections.some((c) => c.error) ? (
        <p className="warn">
          Couldn&apos;t read:{" "}
          {view.collections
            .filter((c) => c.error)
            .map((c) => `${c.collection.slice(0, 10)}… (${c.error})`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function SaleList({
  sales,
  explorerUrl,
  held,
}: {
  sales: Sale[];
  explorerUrl: string;
  held: number;
}) {
  if (sales.length === 0) {
    return (
      <p className="dim hint" style={{ margin: 0 }}>
        Nothing sold yet — {held} token{held === 1 ? "" : "s"} still held.
      </p>
    );
  }
  return (
    <div>
      <p className="dim hint" style={{ marginTop: 0 }}>
        {sales.length} sale{sales.length === 1 ? "" : "s"} · {held} still held. A
        sale priced at 0 was a transfer with no payment in ETH — a gift, or paid
        in something else.
      </p>
      <ul className="feed" style={{ maxHeight: 260, overflowY: "auto" }}>
        {sales.map((s) => (
          <li key={`${s.txHash}-${s.tokenId}`} className="feed-row">
            <span className="feed-main">
              #{s.tokenId} from {s.wallet.slice(0, 8)}…{s.wallet.slice(-4)}
            </span>
            <span className="feed-meta dim">
              {formatEthShort(BigInt(s.proceedsWei))} ETH ·{" "}
              <a href={`${explorerUrl}/tx/${s.txHash}`} target="_blank" rel="noreferrer">
                tx
              </a>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
