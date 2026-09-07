import { useMemo } from "react";
import { formatUsdApprox } from "../lib/profit";
import { shortAddress } from "./ConnectBar";

/**
 * The owner's at-a-glance dashboard: money, growth, activity and subscriptions,
 * built from the roll-up the admin endpoint already computes. Everything here is
 * read-only — the levers live in the accounts table below it.
 *
 * The charts are hand-drawn inline SVG rather than a library: two small daily
 * bar series and a free/Pro donut are all this needs, and a chart that inherits
 * the app's own tokens sits better in the terminal than a bundled one would.
 */
export interface DashSummary {
  accounts: number;
  pro: number;
  free?: number;
  totalBalanceWei: string;
  totalBalanceEth: string;
  totalSnipes: number;
  treasury: string | null;
  sweeping: boolean;
  ethUsd?: number | null;
  proPriceCents?: number;
  snipePriceCents?: number;
  mrrCents?: number;
  revenue?: {
    subscriptionWei: string;
    snipeFeeWei: string;
    totalWei: string;
    subscriptionCents: number;
    snipeFeeCents: number;
    totalCents: number;
  };
  seriesDays?: number;
  accountsBeforeWindow?: number;
  series?: { day: string; signups: number; revenueWei: string; revenueCents: number; snipes: number }[];
}
export interface DashAccount {
  address: string;
  tier: "free" | "pro";
  proUntil: number | null;
  nickname: string | null;
}

const DAY = 86_400_000;

function usd(cents: number | undefined): string {
  if (typeof cents !== "number") return "—";
  const d = cents / 100;
  return `$${d.toLocaleString("en-US", { maximumFractionDigits: d >= 100 ? 0 : 2 })}`;
}

export default function AdminDashboard({
  summary,
  accounts,
}: {
  summary: DashSummary;
  accounts: DashAccount[];
}) {
  const ethUsd = summary.ethUsd ?? null;
  const free = summary.free ?? summary.accounts - summary.pro;
  const rev = summary.revenue;

  // Pro subscriptions expiring in the next week — the churn to watch.
  const expiring = useMemo(() => {
    const now = Date.now();
    return accounts
      .filter((a) => a.tier === "pro" && a.proUntil && a.proUntil > now && a.proUntil <= now + 7 * DAY)
      .sort((a, b) => (a.proUntil ?? 0) - (b.proUntil ?? 0));
  }, [accounts]);

  const series = summary.series ?? [];
  const signupsWindow = series.reduce((s, d) => s + d.signups, 0);
  const revenueWindowCents = series.reduce((s, d) => s + d.revenueCents, 0);

  return (
    <div style={{ marginBottom: 20 }}>
      {/* ── KPI cards ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        <Card
          label="accounts"
          value={String(summary.accounts)}
          sub={`${summary.pro} pro · ${free} free`}
        />
        <Card
          label="MRR"
          value={usd(summary.mrrCents)}
          sub={`${summary.pro} × ${usd(summary.proPriceCents)}/mo`}
          accent
        />
        <Card
          label="revenue (all-time)"
          value={usd(rev?.totalCents)}
          sub={
            rev
              ? `${usd(rev.subscriptionCents)} subs · ${usd(rev.snipeFeeCents)} fees`
              : undefined
          }
          accent
        />
        <Card
          label="balances held"
          value={`${summary.totalBalanceEth} ETH`}
          sub={formatUsdApprox(BigInt(summary.totalBalanceWei), ethUsd) ?? undefined}
        />
        <Card
          label="snipes billed"
          value={String(summary.totalSnipes)}
          sub={rev ? `${usd(rev.snipeFeeCents)} in fees` : undefined}
        />
        <Card
          label="treasury"
          value={summary.sweeping ? "auto-sweep" : "manual"}
          sub={summary.treasury ? shortAddress(summary.treasury) : "not set"}
        />
      </div>

      {/* ── charts ────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        <ChartCard
          title="new accounts / day"
          note={`${signupsWindow} in ${summary.seriesDays ?? series.length}d`}
        >
          <Bars data={series.map((d) => ({ label: d.day, value: d.signups }))} />
        </ChartCard>

        <ChartCard title="revenue / day" note={`${usd(revenueWindowCents)} in ${summary.seriesDays ?? series.length}d`}>
          <Bars
            data={series.map((d) => ({ label: d.day, value: d.revenueCents / 100 }))}
            valueFmt={(v) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
            accent
          />
        </ChartCard>

        <ChartCard title="plan split">
          <Donut pro={summary.pro} free={free} />
        </ChartCard>
      </div>

      {/* ── churn watch ───────────────────────────────────────────── */}
      {expiring.length > 0 ? (
        <div className="panel" style={{ marginTop: 12, padding: "10px 14px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <b style={{ fontSize: 13 }}>Pro expiring within 7 days</b>
            <span className="pill warn">{expiring.length}</span>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", fontSize: 12 }}>
            {expiring.slice(0, 8).map((a) => (
              <li key={a.address} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                <span className="mono-break" title={a.address}>
                  {a.nickname ? `${a.nickname} · ` : ""}
                  {shortAddress(a.address)}
                </span>
                <span className="dim">
                  {a.proUntil ? new Date(a.proUntil).toLocaleDateString() : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className="panel"
      style={{ padding: "12px 14px", margin: 0, display: "flex", flexDirection: "column", gap: 2 }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: accent ? "var(--green-bright, var(--green))" : "var(--text-bright, var(--text))",
        }}
      >
        {value}
      </div>
      <div className="dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      {sub ? <div className="dim" style={{ fontSize: 11 }}>{sub}</div> : null}
    </div>
  );
}

function ChartCard({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel" style={{ padding: "12px 14px", margin: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <b style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>{title}</b>
        {note ? <span className="dim" style={{ fontSize: 11 }}>{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A row of daily bars. Pure SVG so it scales to the card and carries a hover
 * title per day; the tallest bar sets the scale, and an all-zero window draws a
 * flat baseline rather than dividing by zero.
 */
function Bars({
  data,
  valueFmt,
  accent,
}: {
  data: { label: string; value: number }[];
  valueFmt?: (v: number) => string;
  accent?: boolean;
}) {
  const H = 96;
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = Math.max(1, data.length);
  const gap = 2;
  const bw = (100 - gap * (n - 1)) / n; // width in % per bar
  const color = accent ? "var(--green, #37d67a)" : "var(--text-dim, #9aa)";
  const fmt = valueFmt ?? ((v: number) => String(v));
  return (
    <div>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
        {data.map((d, i) => {
          const h = (d.value / max) * (H - 4);
          const x = i * (bw + gap);
          return (
            <rect
              key={d.label}
              x={x}
              y={H - Math.max(d.value > 0 ? 1.5 : 0, h)}
              width={bw}
              height={Math.max(d.value > 0 ? 1.5 : 0, h)}
              fill={color}
              opacity={d.value > 0 ? 0.9 : 0.15}
            >
              <title>{`${d.label}: ${fmt(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="dim" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 4 }}>
        <span>{data[0]?.label.slice(5)}</span>
        <span>peak {fmt(max)}</span>
        <span>{data[data.length - 1]?.label.slice(5)}</span>
      </div>
    </div>
  );
}

/** Free-vs-Pro as a donut, with the counts read out beside it. */
function Donut({ pro, free }: { pro: number; free: number }) {
  const total = Math.max(1, pro + free);
  const proFrac = pro / total;
  const R = 34;
  const C = 2 * Math.PI * R;
  const proLen = proFrac * C;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg viewBox="0 0 90 90" style={{ width: 90, height: 90, flex: "0 0 auto" }}>
        <circle cx="45" cy="45" r={R} fill="none" stroke="var(--line, #23242b)" strokeWidth="12" />
        <circle
          cx="45"
          cy="45"
          r={R}
          fill="none"
          stroke="var(--green, #37d67a)"
          strokeWidth="12"
          strokeDasharray={`${proLen} ${C - proLen}`}
          strokeDashoffset={C / 4}
          transform="rotate(-90 45 45)"
          strokeLinecap="butt"
        />
        <text x="45" y="43" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--text-bright, var(--text))">
          {Math.round(proFrac * 100)}%
        </text>
        <text x="45" y="56" textAnchor="middle" fontSize="8" fill="var(--dim, #888)">
          pro
        </text>
      </svg>
      <div style={{ fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green, #37d67a)", display: "inline-block" }} />
          {pro} pro
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--line, #23242b)", display: "inline-block" }} />
          {free} free
        </div>
      </div>
    </div>
  );
}
