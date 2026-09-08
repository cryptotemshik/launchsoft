import { useCallback, useEffect, useState } from "react";
import { useRunnerApi, useMe } from "../lib/runnerClient";
import { goTab } from "../lib/nav";
import { shortAddress } from "./ConnectBar";

/**
 * The referral programme, from the referrer's side: your link, your tier, what
 * you've earned, and who you've brought. Earnings are credited straight to your
 * balance — the withdraw button lives on the Funding tab, so this only links
 * across to it rather than duplicating a money-moving control.
 */
interface RefTier {
  tier: number;
  minPaying: number;
  pct: number;
}
interface Referral {
  address: string;
  joinedAt: number;
  paying: boolean;
}
interface RefData {
  code: string;
  tier: number;
  pct: number;
  next: RefTier | null;
  tiers: RefTier[];
  refereeDiscountPct: number;
  total: number;
  paying: number;
  earnedWei: string;
  earnedEth: string;
  referrals: Referral[];
}

export default function ReferralsTab() {
  const { base, token, call } = useRunnerApi();
  const { me } = useMe();
  const [data, setData] = useState<RefData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [codeMsg, setCodeMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!base || !token) return;
    try {
      setData((await call("/api/referrals")) as unknown as RefData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base, token, call]);

  useEffect(() => {
    void load();
  }, [load]);

  const link = data ? `${window.location.origin}/?ref=${data.code}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }

  async function saveCode() {
    const code = newCode.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (code.length < 3) {
      setCodeMsg("at least 3 characters (a–z, 0–9)");
      return;
    }
    setSaving(true);
    setCodeMsg(null);
    try {
      await call("/api/referrals/code", { method: "POST", body: JSON.stringify({ code }) });
      setNewCode("");
      setCodeMsg("saved ✓");
      await load();
      setTimeout(() => setCodeMsg(null), 1500);
    } catch (e) {
      setCodeMsg(e instanceof Error ? e.message : "couldn't set that code");
    } finally {
      setSaving(false);
    }
  }

  if (!base) {
    return (
      <div className="panel">
        <h2>Referrals</h2>
        <p className="dim">The service address isn&apos;t configured.</p>
      </div>
    );
  }
  if (!me?.address) {
    return (
      <div className="panel">
        <h2>Referrals</h2>
        <p className="dim">Connect your wallet and sign in to get your referral link.</p>
        <button className="primary" onClick={() => goTab("snipe")}>Connect wallet</button>
      </div>
    );
  }

  return (
    <div>
      <div className="panel">
        <h2>Referrals</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Share your link. When someone signs up through it and goes Pro, you
          earn a cut of everything they spend — Pro and snipe fees — forever.
          Bring more paying referrals to climb the tiers and earn a higher
          percentage. They get <b>{data?.refereeDiscountPct ?? 20}% off</b> their
          first month, so the link is worth using.
        </p>

        {error ? <p className="error">{error}</p> : null}
        {!data ? <p className="dim">Loading…</p> : null}

        {data ? (
          <>
            {/* Your link */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0 4px" }}>
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                style={{ flex: 1, minWidth: 240, fontFamily: "var(--mono)", fontSize: 13 }}
              />
              <button className="primary" onClick={() => void copy()} style={{ padding: "6px 16px" }}>
                {copied ? "copied ✓" : "copy link"}
              </button>
            </div>
            <p className="dim" style={{ fontSize: 12, margin: "0 0 6px" }}>
              your code <b className="mono-break">{data.code}</b>
            </p>
            {/* Anyone can claim a custom, memorable code. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="custom code (a–z, 0–9)"
                maxLength={24}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") void saveCode(); }}
                style={{ width: 200, fontFamily: "var(--mono)", fontSize: 13 }}
              />
              <button className="secondary" disabled={saving} onClick={() => void saveCode()} style={{ padding: "6px 14px" }}>
                {saving ? "…" : "set custom code"}
              </button>
              {codeMsg ? (
                <span className={codeMsg === "saved ✓" ? "ok" : "error"} style={{ fontSize: 12 }}>{codeMsg}</span>
              ) : null}
            </div>

            {/* KPI row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
              <Stat label="your tier" value={data.tier > 0 ? `Tier ${data.tier}` : "—"} sub={`${data.pct}% commission`} accent />
              <Stat label="paying referrals" value={String(data.paying)} sub={`${data.total} total`} />
              <Stat label="earned" value={`${data.earnedEth} ETH`} sub="credited to balance" accent />
            </div>

            {/* Tier progress */}
            <div style={{ marginTop: 12 }}>
              {data.next ? (
                <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                  {Math.max(0, data.next.minPaying - data.paying)} more paying referral
                  {data.next.minPaying - data.paying === 1 ? "" : "s"} → <b>Tier {data.next.tier}</b> ({data.next.pct}%)
                </p>
              ) : data.tier > 0 ? (
                <p className="dim" style={{ fontSize: 12, margin: 0 }}>Top tier — {data.pct}% on everything your referrals spend. 🎉</p>
              ) : (
                <p className="dim" style={{ fontSize: 12, margin: 0 }}>Your first paying referral unlocks Tier 1 ({data.tiers[0]?.pct ?? 10}%).</p>
              )}
            </div>

            {/* Tier ladder */}
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="projects">
                <thead>
                  <tr><th>Tier</th><th>Paying referrals</th><th>You earn</th></tr>
                </thead>
                <tbody>
                  {data.tiers.map((t) => (
                    <tr key={t.tier} className={data.tier === t.tier ? "" : undefined}>
                      <td>{data.tier === t.tier ? <b>Tier {t.tier} ←</b> : `Tier ${t.tier}`}</td>
                      <td>{t.minPaying}+</td>
                      <td className="ok">{t.pct}% of Pro + snipe fees</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="dim hint" style={{ marginTop: 10 }}>
              Earnings land on your balance in ETH — withdraw them any time from the{" "}
              <button className="secondary link-btn" onClick={() => goTab("funding")}>Funding tab</button>.
            </p>
          </>
        ) : null}
      </div>

      {data && data.referrals.length > 0 ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Your referrals <span className="dim" style={{ fontSize: 12 }}>({data.total})</span></h3>
          <div className="table-wrap">
            <table className="projects">
              <thead>
                <tr><th>Wallet</th><th>Joined</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.referrals.map((r) => (
                  <tr key={r.address}>
                    <td className="mono-break" title={r.address}>{shortAddress(r.address)}</td>
                    <td>{new Date(r.joinedAt).toLocaleDateString()}</td>
                    <td>{r.paying ? <span className="pill ok">paying</span> : <span className="pill">free</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="panel" style={{ padding: "12px 14px", margin: 0 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ? "var(--green-bright, var(--green))" : "var(--text-bright, var(--text))" }}>{value}</div>
      <div className="dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      {sub ? <div className="dim" style={{ fontSize: 11 }}>{sub}</div> : null}
    </div>
  );
}
