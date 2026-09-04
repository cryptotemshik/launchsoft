import { useMe } from "../lib/runnerClient";
import { goTab } from "../lib/nav";

/**
 * What you get free, and what Pro adds. Public — a visitor can read it without
 * a wallet. The call to action sends a signed-in user to their Profile, where
 * the working "Get Pro" button charges the balance; a signed-out visitor is
 * told to connect first.
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
  { feature: "Your own PnL", free: "✓", pro: "✓ + history/export (soon)" },
  { feature: "Whale Alerts (3+ whales into one collection)", free: "—", pro: "✓ + whale list" },
  { feature: "Whale Alerts → Telegram", free: "—", pro: "✓" },
  { feature: "Deposit, withdraw, fund, snipe", free: "✓", pro: "✓" },
];

export default function PricingTab() {
  const { me } = useMe();
  const isPro = me?.tier === "pro";

  return (
    <div>
      <div className="panel">
        <h2>Pricing</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Everything shared and read-only is free — even without a wallet. Pro
          unlocks the whale signal, the full scanner window, and higher limits.
        </p>

        <div className="table-wrap">
          <table className="projects">
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
                  <td>{r.feature}</td>
                  <td className={r.free === "—" ? "dim" : ""}>{r.free}</td>
                  <td className="ok">{r.pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="hint dim" style={{ marginTop: 10 }}>
          Per-action, on any plan: a live snipe costs <b>$2</b> (refunded if it
          doesn&apos;t mint). Pro is <b>$29.99/mo</b>, paid from your balance in ETH.
        </p>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          {isPro ? (
            <span className="pill ok">You&apos;re on Pro — thank you.</span>
          ) : (
            <>
              <button className="primary" onClick={() => goTab(me ? "profile" : "snipe")}>
                {me ? "Get Pro — $29.99/mo" : "Connect wallet to get Pro"}
              </button>
              <span className="dim" style={{ fontSize: 12 }}>
                {me ? "Charged from your balance on the Profile tab." : "Sign in first, then subscribe from Profile."}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
