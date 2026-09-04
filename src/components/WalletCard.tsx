import { useEffect, useState, type ReactNode } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { formatEthShort } from "../lib/profit";
import { openSeaCollectionUrlBySlug, openSeaProfileUrl } from "../chains";

/**
 * A summary card for any wallet, ours or a stranger's: its ETH balance, what
 * NFTs it holds, and its NFT (OpenSea) PnL — cost to mint vs what it has sold
 * for — all read from the chain. Reusable: the inspector tab renders it full,
 * a hover popover can render it compact.
 */

interface CollectionRow {
  collection: string;
  collectionName?: string;
  cost: { gasWei: string; priceWei: string; tokens: number };
  soldTokens: number;
  revenueWei: string;
  netWei: string;
  heldTokens: number;
  unpricedSales: number;
}

interface WalletReport {
  address: string;
  balanceWei: string;
  heldTokens: number;
  soldTokens: number;
  collectionsHeld: number;
  totals: { spentWei: string; revenueWei: string; netWei: string };
  collections: CollectionRow[];
  openSeaSlug?: string;
  tookMs?: number;
}

const eth = (wei?: string) => formatEthShort(BigInt(wei ?? "0"));

export default function WalletCard({
  address,
  compact = false,
}: {
  address: string;
  compact?: boolean;
}) {
  const { base, token, call } = useRunnerApi();
  const [report, setReport] = useState<WalletReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!base || !token || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    let live = true;
    setBusy(true);
    setError(null);
    setReport(null);
    void call(`/api/wallet-report?address=${address}`)
      .then((r) => live && setReport(r as unknown as WalletReport))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [address, base, token, call]);

  if (!base || !token) {
    return <p className="dim">Sign in with your wallet to inspect addresses.</p>;
  }
  if (busy && !report) {
    return (
      <div className="skeleton-rows" aria-hidden>
        <div className="skeleton" style={{ height: 48, width: "60%" }} />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }
  if (error) return <p className="error">{error}</p>;
  if (!report) return null;

  const net = BigInt(report.totals.netWei);
  const netClass = net > 0n ? "ok" : net < 0n ? "error" : "dim";
  const netSign = net > 0n ? "+" : "";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <a href={openSeaProfileUrl(report.address)} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
          {report.address.slice(0, 6)}…{report.address.slice(-4)}
        </a>
        {report.tookMs ? <span className="dim" style={{ fontSize: 11 }}>· read {(report.tookMs / 1000).toFixed(1)}s</span> : null}
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8 }}>
        <Stat label="balance" value={`${eth(report.balanceWei)} ETH`} />
        <Stat label="NFTs held" value={`${report.heldTokens}`} sub={`${report.collectionsHeld} collection${report.collectionsHeld === 1 ? "" : "s"}`} />
        <Stat label="sold" value={`${report.soldTokens}`} />
        <Stat
          label="NFT PnL"
          value={<span className={netClass}>{netSign}{eth(report.totals.netWei)} ETH</span>}
          sub={`spent ${eth(report.totals.spentWei)} · made ${eth(report.totals.revenueWei)}`}
        />
      </div>

      {!compact && report.collections.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="projects">
            <thead>
              <tr>
                <th>collection</th>
                <th>held</th>
                <th>sold</th>
                <th>spent</th>
                <th>made</th>
                <th>net</th>
              </tr>
            </thead>
            <tbody>
              {report.collections.map((c) => {
                const cnet = BigInt(c.netWei);
                const spent = BigInt(c.cost.gasWei) + BigInt(c.cost.priceWei);
                return (
                  <tr key={c.collection}>
                    <td>
                      <a
                        href={openSeaCollectionUrlBySlug(report.openSeaSlug, c.collection)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {c.collectionName ?? `${c.collection.slice(0, 10)}…`}
                      </a>
                    </td>
                    <td>{c.heldTokens}</td>
                    <td>
                      {c.soldTokens}
                      {c.unpricedSales ? <span className="dim" title="transfers with no clear sale price"> (+{c.unpricedSales}?)</span> : null}
                    </td>
                    <td>{formatEthShort(spent)}</td>
                    <td>{eth(c.revenueWei)}</td>
                    <td className={cnet > 0n ? "ok" : cnet < 0n ? "error" : "dim"}>
                      {cnet > 0n ? "+" : ""}{eth(c.netWei)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {!compact ? (
        <p className="hint dim" style={{ marginTop: 10, marginBottom: 0 }}>
          PnL is realized NFT profit — mint cost (gas + price) against what tokens
          have sold for, read from the chain. Tokens still held aren&apos;t priced
          (this chain has no floor feed), so they count as held, not as profit.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      <div className="dim" style={{ fontSize: 11 }}>
        {label}
        {sub ? <> · {sub}</> : null}
      </div>
    </div>
  );
}
