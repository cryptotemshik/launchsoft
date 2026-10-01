/**
 * Where the team dashboard starts counting profit.
 *
 * "Start from now" draws a line: mints, their gas and their sales before it
 * drop out of the dashboard, which then shows profit from zero. "Count
 * everything" removes the line. The operator's own profit panel is not
 * affected — this only changes what the dashboard key is shown.
 */
import { useEffect, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";

export default function DashboardSettings() {
  const { base, token, call } = useRunnerApi();
  const [since, setSince] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!base || !token) return;
    call("/api/admin/dashboard-settings")
      .then((r) => setSince(typeof r.profitSince === "number" ? r.profitSince : null))
      .catch((e) => setError(/404/.test(String(e)) ? "update the server (git pull, restart) to use this" : String(e)));
  }, [base, token, call]);

  async function set(value: "now" | null) {
    if (value === "now" && !window.confirm("Start the team dashboard's profit from zero, right now?")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call("/api/admin/dashboard-settings", {
        method: "POST",
        body: JSON.stringify({ profitSince: value }),
      });
      setSince(typeof r.profitSince === "number" ? r.profitSince : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Team dashboard</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Profit on the dashboard counts{" "}
        {since === undefined ? (
          "…"
        ) : since ? (
          <b>from {new Date(since * 1000).toLocaleString()}</b>
        ) : (
          <b>everything ever minted</b>
        )}
        . Starting from now hides earlier mints, their gas and their sales there,
        so it shows a clean slate. This panel&apos;s own numbers are not changed.
        The funding wallet&apos;s balance is never shown on the dashboard.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="primary" disabled={busy || since === undefined} onClick={() => void set("now")}>
          START PROFIT FROM NOW
        </button>
        <button className="secondary" disabled={busy || !since} onClick={() => void set(null)}>
          COUNT EVERYTHING AGAIN
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
