import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Control panel for a snipe runner living next to the sequencer.
 *
 * What this is NOT: a path for the transaction. Pressing "fire" only *starts*
 * a run on the server; from that moment the server holds and fires on its own
 * clock, so a run started here is exactly as fast as one typed over SSH. The
 * browser can be closed once a run is holding.
 *
 * Keys never come near this component — the server keeps them and reports only
 * addresses and balances.
 */

interface WalletPlan {
  address: string;
  balanceWei: string;
  firing: boolean;
  note?: string;
}

interface RunPlan {
  chain: string;
  name: string;
  totalSupply: string;
  maxSupply: string;
  stage: string;
  priceWei: string;
  perWallet: number;
  quantity: number;
  startTime: number;
  endTime: number;
  endpoints: string[];
  wallets: WalletPlan[];
  baseFeeGwei: string;
}

interface Outcome {
  address: string;
  txHash?: string;
  status: string;
  detail?: string;
}

interface StatusView {
  running: boolean;
  status?: string;
  dryRun?: boolean;
  logs?: string[];
  plan?: RunPlan;
  outcomes?: Outcome[];
  error?: string;
}

const URL_KEY = "launchpad.runner.url";
const TOKEN_KEY = "launchpad.runner.token";

export interface RemoteRunnerProps {
  /** Collection currently loaded in the tab, if any. */
  collection?: `0x${string}`;
  stage: "public" | "allowlist";
  quantity: number;
  gas: { maxFeeGwei: string; tipGwei: string; limit: number };
  extraRpcs: string[];
  timing: "now" | "wait";
}

export default function RemoteRunner(props: RemoteRunnerProps) {
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? "");
  const [token, setToken] = useState(
    () => sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? "",
  );
  const [rememberToken, setRememberToken] = useState(() => localStorage.getItem(TOKEN_KEY) !== null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusView | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const base = url.trim().replace(/\/+$/, "");

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${token.trim()}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [base, token],
  );

  const refresh = useCallback(async () => {
    try {
      const s = (await call("/api/status")) as StatusView;
      setStatus(s);
      setConnected(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call]);

  // Poll while a run is in flight so the log tail stays live.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!connected) return;
    pollRef.current = setInterval(() => void refresh(), status?.running ? 1500 : 6000);
    return () => clearInterval(pollRef.current);
  }, [connected, status?.running, refresh]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(URL_KEY, base);
      if (rememberToken) localStorage.setItem(TOKEN_KEY, token.trim());
      else {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.setItem(TOKEN_KEY, token.trim());
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function fire(dryRun: boolean) {
    if (!props.collection) {
      setError("Read a collection above first — the runner mints the one loaded here.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call("/api/snipe", {
        method: "POST",
        body: JSON.stringify({
          collection: props.collection,
          stage: props.stage,
          quantity: props.quantity,
          gas: props.gas,
          extraRpcs: props.extraRpcs,
          timing: props.timing,
          dryRun,
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function abort() {
    setBusy(true);
    try {
      await call("/api/abort", { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const plan = status?.plan;

  return (
    <div className="panel">
      <h2>Remote runner (VPS)</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Runs the snipe on a server next to the chain&apos;s sequencer instead of
        in this tab. Pressing fire only <b>starts</b> the run — the server then
        holds and fires on its own clock, so this is exactly as fast as starting
        it over SSH, and you can close the browser once it&apos;s holding.
        Private keys stay on the server; this panel only ever sees addresses.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 2, minWidth: 240 }}>
          <label>server URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-tunnel.trycloudflare.com"
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
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
        <button className="secondary" onClick={() => void connect()} disabled={busy || !base || !token}>
          {busy ? "…" : connected ? "refresh" : "connect"}
        </button>
        <label className="dim" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={rememberToken}
            onChange={(e) => setRememberToken(e.target.checked)}
          />
          remember token in this browser
        </label>
        {connected ? <span className="pill ok">● connected</span> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}

      {connected ? (
        <>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            <button className="secondary" disabled={busy || status?.running} onClick={() => void fire(true)}>
              DRY RUN on server
            </button>
            <button className="primary" disabled={busy || status?.running} onClick={() => void fire(false)}>
              ARM &amp; FIRE on server
            </button>
            {status?.running ? (
              <button className="danger" disabled={busy} onClick={() => void abort()}>
                abort
              </button>
            ) : null}
          </div>
          {!props.collection ? (
            <p className="hint dim" style={{ marginBottom: 0 }}>
              Read a collection above — the runner uses the one loaded here, plus
              the stage, quantity, gas and RPC settings on this page.
            </p>
          ) : null}

          {status?.status ? (
            <p
              className={
                status.status === "error"
                  ? "error"
                  : status.running
                    ? "warn"
                    : status.status === "done"
                      ? "ok"
                      : "dim"
              }
              style={{ marginBottom: 4 }}
            >
              run: {status.status}
              {status.dryRun ? " (dry run)" : ""}
              {status.error ? ` — ${status.error}` : ""}
            </p>
          ) : null}

          {plan ? (
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>collection</dt>
              <dd>
                {plan.name} — {plan.totalSupply}/{plan.maxSupply}
              </dd>
              <dt>stage</dt>
              <dd>
                {plan.stage} · {plan.quantity}/wallet · max {plan.perWallet}
              </dd>
              <dt>endpoints</dt>
              <dd>{plan.endpoints.join(", ")}</dd>
              <dt>wallets</dt>
              <dd>
                {plan.wallets.map((w) => (
                  <div key={w.address}>
                    {w.address.slice(0, 10)}…{w.address.slice(-4)}{" "}
                    <span className={w.note ? "warn" : "dim"}>
                      {(Number(w.balanceWei) / 1e18).toFixed(4)} ETH
                      {w.note ? ` — ${w.note}` : ""}
                    </span>
                  </div>
                ))}
              </dd>
            </dl>
          ) : null}

          {status?.outcomes && status.outcomes.length > 0 ? (
            <dl className="kv">
              <dt>result</dt>
              <dd>
                {status.outcomes.map((o) => (
                  <div key={o.address + (o.txHash ?? "")}>
                    <span className={o.status === "mined" ? "ok" : o.status === "skipped" ? "dim" : "error"}>
                      {o.status}
                    </span>{" "}
                    {o.address.slice(0, 10)}…{o.address.slice(-4)}
                    {o.detail ? <span className="dim"> — {o.detail}</span> : null}
                  </div>
                ))}
              </dd>
            </dl>
          ) : null}

          {status?.logs && status.logs.length > 0 ? (
            <pre className="runner-log">{status.logs.slice(-14).join("\n")}</pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
