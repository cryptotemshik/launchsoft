import { useMe } from "../lib/runnerClient";
import { goTab } from "../lib/nav";

/**
 * What you get free, and what Pro adds. Public — a visitor can read it without
 * a wallet. The price and the buy button lead, up top and large; the table
 * below is the detail. The CTA sends a signed-in user to their Profile (where
 * the working charge lives) and a signed-out visitor to connect first.
 */

interface Row {
  feature: string;
  free: string;
  pro: string;
}

const ROWS: Row[] = [
  { feature: "Scanner — upcoming drops", free: "next 6 hours", pro: "full 14-day window" },
  { feature: "Live mint board", free: "✓", pro: "✓" },
  { feature: "Calendar", free: "✓", pro: "✓" },
  { feature: "Wallet tracker (activity feed)", free: "✓", pro: "✓" },
  { feature: "Tracker → Telegram delivery", free: "up to 3 wallets", pro: "up to 100 wallets" },
  { feature: "Inspect any wallet (balance, NFTs, PnL)", free: "15 lookups/min", pro: "90 lookups/min" },
  { feature: "Your own PnL", free: "totals + table", pro: "+ profit-over-time chart & CSV export" },
  { feature: "Whale Alerts (3+ whales into one collection)", free: "—", pro: "✓ + whale list" },
  { feature: "Whale Alerts → Telegram", free: "—", pro: "✓" },
  { feature: "Deposit, withdraw, fund, snipe", free: "✓", pro: "✓" },
];

export default function PricingTab() {
  const { me } = useMe();
  const isPro = me?.tier === "pro";

  return (
    <div>
      {/* ── Price hero — the price and the buy button, up top and loud ─────── */}
      <div className="panel pro-hero">
        <div className="pro-hero-left">
          <span className="pill ok">PRO</span>
          <div className="pro-price">
            $29.99<span className="pro-per">/mo</span>
          </div>
          <div className="dim" style={{ fontSize: 13 }}>
            billed in ETH from your balance · cancel anytime
          </div>
        </div>
        <div className="pro-hero-right">
          {isPro ? (
            <span className="pill ok" style={{ fontSize: 14, padding: "8px 16px" }}>
              You&apos;re on Pro — thank you 🎉
            </span>
          ) : (
            <button className="primary pro-buy" onClick={() => goTab(me ? "profile" : "snipe")}>
              {me ? "Buy Pro" : "Connect wallet to buy"}
            </button>
          )}
          <div className="dim" style={{ fontSize: 12, textAlign: "center" }}>
            {me
              ? "Charged from your balance on the Profile tab."
              : "$2 per live snipe · refunded if it doesn't mint"}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>What Pro unlocks</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Everything shared and read-only is free — even without a wallet. Pro
          unlocks the whale signal, the full scanner window, and higher limits.
        </p>

        <div className="table-wrap">
          <table className="projects plans-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Free</th>
                <th>
                  Pro
                  {isPro ? <span className="pill ok" style={{ marginLeft: 6 }}>your plan</span> : null}
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.feature}>
                  <td data-label="">{r.feature}</td>
                  <td data-label="Free" className={r.free === "—" ? "dim" : ""}>{r.free}</td>
                  <td data-label="Pro" className="ok">{r.pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="hint dim" style={{ marginTop: 10 }}>
          Per-action, on any plan: a live snipe costs <b>$2</b> (refunded if it
          doesn&apos;t mint). Pro is <b>$29.99/mo</b>, paid from your balance in ETH.
        </p>

        {!isPro ? (
          <button className="primary pro-buy" style={{ marginTop: 4 }} onClick={() => goTab(me ? "profile" : "snipe")}>
            {me ? "Buy Pro — $29.99/mo" : "Connect wallet to buy"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
