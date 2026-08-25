import { useCallback, useEffect, useRef, useState } from "react";
import { formatCountdown, unixToLocalAndUtc } from "../lib/convert";
import { useRunnerApi } from "../lib/runnerClient";
import StaleServer from "./StaleServer";

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
  quantity: number | "max";
  dryRun: boolean;
  /** Present when the job is pinned to a subset of the server's wallets. */
  wallets?: string[];
  logs?: string[];
  plan?: RunPlan;
  outcomes?: Outcome[];
  error?: string;
}

interface ServerWallet {
  address: string;
  label?: string;
  balance: string | null;
}

interface StatusView {
  /** Absent on servers older than the version handshake. */
  apiVersion?: number;
  running: boolean;
  activeJobId: string | null;
  armLeadMs: number;
  /** Hosts of the endpoints stored on the server (never the keyed URLs). */
  rpcHosts?: string[];
  /** Host the server reads balances and nonces through. */
  readRpc?: string | null;
  jobs: Job[];
}

/** Hosts only, so a comparison never involves a provider API key. */
function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

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
  quantity: number | "max";
  gas: { maxFeeGwei: string; tipGwei: string; limit: number };
  extraRpcs: string[];
  timing: "now" | "wait";
}

export default function RemoteRunner(props: RemoteRunnerProps) {
  const api = useRunnerApi();
  const {
    url,
    setUrl,
    token,
    setToken,
    remember: rememberToken,
    setRemember: setRememberToken,
    base,
    call,
    save,
    serverVersion,
  } = api;
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  // The server's own wallets, so a job can be aimed at a subset of them.
  const [wallets, setWallets] = useState<ServerWallet[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = (await call("/api/status")) as unknown as StatusView;
      setStatus(s);
      setConnected(true);
      setError(null);
      // Wallet list drives the picker below; a failure here must not break
      // the queue view, which is the important half.
      try {
        const w = (await call("/api/wallets")) as unknown as { wallets: ServerWallet[] };
        const list = w.wallets ?? [];
        setWallets(list);
        // Drop anything that has since been deleted on the server, otherwise a
        // ghost address keeps the selection looking partial forever.
        setChosen((prev) => {
          if (prev.size === 0) return prev;
          const live = new Set(list.map((x) => x.address));
          const next = new Set([...prev].filter((a) => live.has(a)));
          return next.size === prev.size ? prev : next;
        });
      } catch {
        setWallets([]);
      }
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
      save();
      await refresh();
      await pushRpcs();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hand the server the endpoints typed into this page. Without it the box
   * reads a hundred balances through the public RPC and gets rate-limited,
   * while the paid endpoint the user pasted sits unused on the browser side.
   */
  const pushRpcs = useCallback(async () => {
    if (props.extraRpcs.length === 0) return;
    try {
      await call("/api/rpcs", {
        method: "POST",
        body: JSON.stringify({ extraRpcs: props.extraRpcs }),
      });
      await refresh();
      setRpcError(null);
    } catch (e) {
      // An older server has no such route at all — the stale-server notice
      // covers that. A rejection with a message means the endpoint itself was
      // refused, and the user needs to see why.
      const msg = e instanceof Error ? e.message : String(e);
      setRpcError(/HTTP 404/.test(msg) ? null : msg);
    }
  }, [call, props.extraRpcs, refresh]);

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
          // Empty selection means "every wallet", which is the sane default.
          ...(chosen.size > 0 && chosen.size < wallets.length ? { wallets: [...chosen] } : {}),
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
  // Compared by host: the stored URLs are never sent back with their keys.
  const rpcsDiffer =
    props.extraRpcs.length > 0 &&
    JSON.stringify(props.extraRpcs.map(hostOf)) !== JSON.stringify(status?.rpcHosts ?? []);

  return (
    <div className="panel">
      <h2>Remote runner (VPS) — queue</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Queue drops hours in advance on a server sitting next to the chain&apos;s
        sequencer. Each job is armed ahead of its stage (nonces read, transactions
        pre-signed, connections warmed) and fires on the server&apos;s own clock —
        so this is exactly as fast as starting it over SSH.
      </p>
      <p className="dim">
        <b>Wallets come from the server</b>, from its <code>snipe.keys</code> file —
        not from the Wallets box above, which the server never sees. They live
        there permanently, so once a drop is queued you can close this page (or
        turn the phone off) and it will still fire and report to Telegram. Keys
        never travel to this panel; it only ever receives addresses and balances.
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

      <StaleServer version={serverVersion} />

      {rpcError ? (
        <p className="warn" style={{ marginBottom: 0 }}>
          The server would not take an endpoint from this page: {rpcError}. It
          keeps reading through the one it already had — fix the URL above and
          press refresh.
        </p>
      ) : null}

      {connected && status?.readRpc ? (
        <p className="hint dim" style={{ marginBottom: 0 }}>
          The server reads balances and nonces through <b>{status.readRpc}</b>.
          {rpcsDiffer ? (
            <>
              {" "}
              The endpoints on this page differ from the ones stored there.{" "}
              <button
                className="secondary"
                style={{ padding: "2px 10px", fontSize: 11 }}
                disabled={busy}
                onClick={() => void pushRpcs()}
              >
                send these to the server
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {connected ? (
        <>
          <WalletPicker
            wallets={wallets}
            chosen={chosen}
            setChosen={setChosen}
          />

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
                          {j.wallets?.length ? ` · ${j.wallets.length}w` : ""}
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

/**
 * Which of the server's wallets this job fires from. Nothing ticked means all
 * of them, which is both the default and what most drops want; ticking a
 * label's chip is the quick way to aim one drop at a batch.
 */
function WalletPicker({
  wallets,
  chosen,
  setChosen,
}: {
  wallets: ServerWallet[];
  chosen: Set<string>;
  setChosen: (s: Set<string>) => void;
}) {
  if (wallets.length === 0) {
    return (
      <p className="warn" style={{ marginTop: 14, marginBottom: 0 }}>
        No wallets on the server yet — add them in the <b>WALLETS</b> tab, or a
        queued job will have nothing to mint with.
      </p>
    );
  }

  const labels = [...new Set(wallets.map((w) => w.label).filter((l): l is string => Boolean(l)))];
  const all = chosen.size === 0 || chosen.size === wallets.length;
  const funded = wallets.filter((w) => Number(w.balance ?? 0) > 0).length;

  const pick = (addresses: string[]) => setChosen(new Set(addresses));

  return (
    <div style={{ marginTop: 16 }}>
      <div className="field" style={{ marginBottom: 8 }}>
        <label>
          wallets for this job — {all ? `all ${wallets.length}` : `${chosen.size} of ${wallets.length}`}
          {funded < wallets.length ? ` · ${wallets.length - funded} with no balance` : ""}
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <button
          className={all ? "secondary active-chip" : "secondary"}
          style={{ padding: "3px 12px", fontSize: 11 }}
          onClick={() => setChosen(new Set())}
        >
          all ({wallets.length})
        </button>
        <button
          className="secondary"
          style={{ padding: "3px 12px", fontSize: 11 }}
          onClick={() => pick(wallets.filter((w) => Number(w.balance ?? 0) > 0).map((w) => w.address))}
        >
          funded only ({funded})
        </button>
        {labels.map((l) => (
          <button
            key={l}
            className="secondary"
            style={{ padding: "3px 12px", fontSize: 11 }}
            onClick={() => pick(wallets.filter((w) => w.label === l).map((w) => w.address))}
          >
            {l} ({wallets.filter((w) => w.label === l).length})
          </button>
        ))}
      </div>
      <div className="wallet-picker">
        {wallets.map((w) => {
          const on = all || chosen.has(w.address);
          return (
            <label key={w.address} className={`wallet-pick ${on ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => {
                  // First tick off an "all" selection materialises the full set,
                  // so unticking one leaves the rest selected.
                  const base = chosen.size === 0 ? new Set(wallets.map((x) => x.address)) : new Set(chosen);
                  if (base.has(w.address)) base.delete(w.address);
                  else base.add(w.address);
                  setChosen(base);
                }}
              />
              <span className="mono-break">
                {w.address.slice(0, 8)}…{w.address.slice(-4)}
              </span>
              <span className={Number(w.balance ?? 0) > 0 ? "dim" : "warn"}>
                {w.balance === null ? "—" : `${Number(w.balance).toFixed(4)}`}
              </span>
              {w.label ? <span className="dim">{w.label}</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}
