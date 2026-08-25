import { useCallback, useEffect, useRef, useState } from "react";
import { formatCountdown, unixToLocalAndUtc } from "../lib/convert";

/**
 * Control panel for a snipe runner living next to the sequencer.
 *
 * What this is NOT: a path for the transaction. Queueing a drop only tells the
 * server what to do; the server arms it ahead of the stage and fires on its own
 * clock, so a run queued here is exactly as fast as one typed over SSH — and
 * the browser can be closed the moment a job is queued.
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
  tokenIds?: string[];
}

interface Job {
  id: string;
  label: string;
  status: "queued" | "armed" | "done" | "error" | "aborted";
  addedAt: number;
  startTime?: number;
  collection: string;
  stage: string;
  quantity: number;
  dryRun: boolean;
  logs?: string[];
  plan?: RunPlan;
  outcomes?: Outcome[];
  error?: string;
}

interface StatusView {
  running: boolean;
  activeJobId: string | null;
  armLeadMs: number;
  jobs: Job[];
}

const URL_KEY = "launchpad.runner.url";
const TOKEN_KEY = "launchpad.runner.token";

const STATUS_CLASS: Record<Job["status"], string> = {
  queued: "dim",
  armed: "warn",
  done: "ok",
  error: "error",
  aborted: "dim",
};

export interface RemoteRunnerProps {
  /** Collection currently loaded in the tab, if any. */
  collection?: `0x${string}`;
  /** Its name, for a readable queue label. */
  collectionName?: string;
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
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const base = url.trim().replace(/\/+$/, "");

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

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

  // Poll faster while something is armed so the log tail stays live.
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

  async function enqueue(dryRun: boolean) {
    if (!props.collection) {
      setError("Read a collection above first — the queue takes the one loaded here.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call("/api/queue", {
        method: "POST",
        body: JSON.stringify({
          label: props.collectionName || props.collection.slice(0, 10),
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

  async function remove(id: string) {
    setBusy(true);
    try {
      await call(`/api/queue?id=${encodeURIComponent(id)}`, { method: "DELETE" });
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

  const jobs = status?.jobs ?? [];
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "armed");

  return (
    <div className="panel">
      <h2>Remote runner (VPS) — queue</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Queue drops hours in advance on a server sitting next to the chain&apos;s
        sequencer. Each job is armed ahead of its stage (nonces read, transactions
        pre-signed, connections warmed) and fires on the server&apos;s own clock —
        so this is exactly as fast as starting it over SSH, and you can close the
        browser once a job is queued. Private keys stay on the server; this panel
        only ever sees addresses.
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
        {connected ? (
          <span className="pill ok">
            ● connected{pending.length ? ` · ${pending.length} pending` : ""}
          </span>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}

      {connected ? (
        <>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            <button className="secondary" disabled={busy} onClick={() => void enqueue(true)}>
              + queue as DRY RUN
            </button>
            <button className="primary" disabled={busy} onClick={() => void enqueue(false)}>
              + QUEUE THIS DROP
            </button>
            {status?.running ? (
              <button className="danger" disabled={busy} onClick={() => void abort()}>
                abort running job
              </button>
            ) : null}
          </div>
          {!props.collection ? (
            <p className="hint dim" style={{ marginBottom: 0 }}>
              Read a collection above — the queue takes the one loaded here, plus
              the stage, quantity, gas and RPC settings on this page. Load the
              next collection and queue it too; repeat for as many as you like.
            </p>
          ) : (
            <p className="hint dim" style={{ marginBottom: 0 }}>
              Queues <b>{props.collectionName || props.collection}</b> ·{" "}
              {props.stage} · {props.quantity}/wallet. Jobs run one at a time, in
              stage order — the server arms each one{" "}
              {status ? Math.round(status.armLeadMs / 1000) : 120}s before it opens.
            </p>
          )}

          {jobs.length === 0 ? (
            <p className="dim" style={{ marginTop: 14, marginBottom: 0 }}>
              Queue is empty.
            </p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="projects">
                <thead>
                  <tr>
                    <th>drop</th>
                    <th>stage</th>
                    <th>opens</th>
                    <th>status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const opensIn = j.startTime ? j.startTime - now : null;
                    const minted =
                      j.outcomes?.filter((o) => o.status === "mined").reduce((n, o) => n + (o.tokenIds?.length ?? 0), 0) ??
                      0;
                    return (
                      <tr
                        key={j.id}
                        className="project-row"
                        onClick={() => setOpenJob(openJob === j.id ? null : j.id)}
                      >
                        <td>
                          {j.label}
                          {j.dryRun ? <span className="dim"> (dry)</span> : null}
                        </td>
                        <td className="dim">
                          {j.stage} ×{j.quantity}
                        </td>
                        <td className="dim">
                          {j.startTime
                            ? opensIn && opensIn > 0
                              ? `in ${formatCountdown(opensIn)}`
                              : unixToLocalAndUtc(j.startTime).local
                            : "—"}
                        </td>
                        <td>
                          <span className={STATUS_CLASS[j.status]}>{j.status}</span>
                          {j.status === "done" && minted > 0 ? (
                            <span className="ok"> · {minted} NFT</span>
                          ) : null}
                        </td>
                        <td>
                          {j.status === "queued" ? (
                            <button
                              className="secondary"
                              style={{ padding: "2px 10px", fontSize: 11 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void remove(j.id);
                              }}
                            >
                              remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {openJob ? <JobDetail job={jobs.find((j) => j.id === openJob)} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** Expanded view for one queued/finished job: outcomes, then the log tail. */
function JobDetail({ job }: { job?: Job }) {
  if (!job) return null;
  return (
    <div style={{ marginTop: 14 }}>
      {job.error ? <p className="error">{job.error}</p> : null}
      {job.plan ? (
        <dl className="kv">
          <dt>collection</dt>
          <dd>
            {job.plan.name} — {job.plan.totalSupply}/{job.plan.maxSupply}
          </dd>
          <dt>endpoints</dt>
          <dd>{job.plan.endpoints.join(", ")}</dd>
          <dt>wallets</dt>
          <dd>
            {job.plan.wallets.map((w) => (
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

      {job.outcomes && job.outcomes.length > 0 ? (
        <dl className="kv">
          <dt>result</dt>
          <dd>
            {job.outcomes.map((o) => (
              <div key={o.address + (o.txHash ?? "")}>
                <span className={o.status === "mined" ? "ok" : o.status === "skipped" ? "dim" : "error"}>
                  {o.status}
                </span>{" "}
                {o.address.slice(0, 10)}…{o.address.slice(-4)}
                {o.tokenIds && o.tokenIds.length > 0 ? (
                  <span className="dim"> — #{o.tokenIds.join(", #")}</span>
                ) : null}
                {o.detail ? <span className="dim"> — {o.detail}</span> : null}
              </div>
            ))}
          </dd>
        </dl>
      ) : null}

      {job.logs && job.logs.length > 0 ? (
        <pre className="runner-log">{job.logs.slice(-14).join("\n")}</pre>
      ) : null}
    </div>
  );
}
