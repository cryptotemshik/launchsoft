import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, unixToLocalAndUtc } from "../lib/convert";
import {
  CHAINS_BY_ID,
  DEFAULT_CHAIN_ID,
  openSeaCollectionUrl,
  type ChainInfo,
} from "../chains";
import { useAccount, useConnect } from "wagmi";
import { useActiveChain, useSigner } from "../signer";
import { formatEthShort } from "../lib/profit";
import {
  DEFAULT_AFTER,
  DEFAULT_BEFORE,
  DEFAULT_STEP_MS,
  spreadLabel,
  type MintStyle,
} from "../lib/spread";
import { saveRunnerCreds, signInWithWallet, useMe, useRunnerApi } from "../lib/runnerClient";
import StaleServer from "./StaleServer";
import Addr from "./Addr";
import FundJobPanel from "./FundJobPanel";
import WalletPicker from "./WalletPicker";

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

/** What the contract said about the drop when the job was queued. */
interface JobDrop {
  name: string;
  totalSupply: string;
  maxSupply: string;
  priceWei: string;
  startTime: number;
  endTime: number;
  perWallet: number;
  readAt: number;
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
  /** Absent on servers older than the queue-time drop read. */
  drop?: JobDrop;
  /** The gas this job was queued with. Absent on older servers. */
  gas?: { maxFeeGwei: string; tipGwei: string; limit: number };
  /** Transactions per wallet — 1 for a single burst, more for a spread. */
  shots?: number;
  /** A nudge to withdraw after a successful mint. Absent on older servers. */
  reminder?: string;
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
  const signer = useSigner();
  const { me } = useMe();
  const { isConnected: walletConnected } = useAccount();
  const { connect: connectWallet, connectors } = useConnect();
  // The server URL, token and node internals are the operator's: a normal
  // visitor signs in with their wallet and never sees any of it.
  const admin = Boolean(me?.admin);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  // Connect right after a wallet sign-in, once the new token is in state so the
  // request carries it. A one-shot flag the effect below consumes.
  const [connectAfterLogin, setConnectAfterLogin] = useState(false);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * How this job puts its transactions on the clock.
   *
   * Per job rather than a server setting, because the right answer differs per
   * drop: a contested free mint wants the spread, a quiet one does not need
   * the extra transactions.
   */
  const [style, setStyle] = useState<MintStyle>("single");
  const [before, setBefore] = useState(DEFAULT_BEFORE);
  const [after, setAfter] = useState(DEFAULT_AFTER);
  const [stepMs, setStepMs] = useState(DEFAULT_STEP_MS);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  /** Which queued job's funding drawer is open, by id. */
  const [funding, setFunding] = useState<string | null>(null);
  // The server's own wallets, so a job can be aimed at a subset of them.
  const [wallets, setWallets] = useState<ServerWallet[]>([]);
  /**
   * Exactly which wallets fire, always spelled out.
   *
   * An empty set used to mean "all of them", which made "none of them"
   * impossible to express — there was no way to clear the list and tick a few
   * back on. It is literal now: empty means none, and the full set is filled
   * in when the wallets first load.
   */
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
        setWallets((prevList) => {
          // First sight of the wallet set selects all of it, which is what
          // most drops want and what the empty set used to stand in for.
          if (prevList.length === 0 && list.length > 0) {
            setChosen(new Set(list.map((x) => x.address)));
          } else {
            // Drop anything since deleted on the server, otherwise a ghost
            // address keeps the selection looking partial forever.
            setChosen((prev) => {
              const live = new Set(list.map((x) => x.address));
              const next = new Set([...prev].filter((a) => live.has(a)));
              return next.size === prev.size ? prev : next;
            });
          }
          return list;
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
   * Sign in with the connected wallet instead of pasting SNIPE_TOKEN. The
   * server hands back a session token, which becomes the bearer for every
   * later call — same field, same storage, just obtained by a signature the
   * user already holds rather than a secret they had to be given.
   */
  async function signIn() {
    if (!base) {
      setError("the service address isn't configured yet");
      return;
    }
    // One button does both steps: if no wallet is connected to the browser
    // yet, connect it first, then the user presses sign-in once more to sign.
    if (!walletConnected || !signer.address || !signer.walletClient) {
      setError(null);
      setLoginNote("connecting your wallet — approve it, then press sign in again");
      if (connectors[0]) connectWallet({ connector: connectors[0] });
      return;
    }
    const address = signer.address;
    const account = signer.txAccount ?? address;
    setSigningIn(true);
    setError(null);
    setLoginNote(null);
    try {
      const result = await signInWithWallet(base, address, (message) =>
        signer.walletClient!.signMessage({ account, message }),
      );
      setToken(result.token);
      setRememberToken(true);
      saveRunnerCreds(base, result.token, true);
      setLoginNote(
        result.admin
          ? `signed in as ${address.slice(0, 6)}…${address.slice(-4)} (admin)`
          : `signed in as ${address.slice(0, 6)}…${address.slice(-4)} — this account has no access to the shared runner yet`,
      );
      // Only an admin session can drive this server today; connecting a plain
      // session would just 401. Wire the auto-connect for the admin case.
      if (result.admin) setConnectAfterLogin(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }

  // The token state now holds the session; connect with it.
  useEffect(() => {
    if (!connectAfterLogin || !token) return;
    setConnectAfterLogin(false);
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectAfterLogin, token]);

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

  // Updating the server (git pull + restart) lives on the Admin tab now, not
  // here — see AdminTab's "server update" panel.

  async function enqueue(dryRun: boolean) {
    if (!props.collection) {
      setError("Read a collection above first — the queue takes the one loaded here.");
      return;
    }
    if (wallets.length > 0 && chosen.size === 0) {
      setError("No wallets ticked — a job with none would arm nothing and mint nothing.");
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
          // Only pin the job when it is a strict subset; sending the whole
          // list would freeze it against wallets added later.
          ...(chosen.size < wallets.length ? { wallets: [...chosen] } : {}),
          gas: props.gas,
          extraRpcs: props.extraRpcs,
          timing: props.timing,
          style,
          ...(style === "spread" ? { before, after, stepMs } : {}),
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
  const fundingJob = funding ? (jobs.find((j) => j.id === funding) ?? null) : null;
  /**
   * The wallets that job will actually fire from. A job pinned to a subset
   * carries the list; one that is not fires from every wallet the server has,
   * and funding the others would be money sent nowhere useful.
   */
  const fundingWallets = fundingJob
    ? fundingJob.wallets?.length
      ? wallets.filter((w) =>
          fundingJob.wallets!.some((a) => a.toLowerCase() === w.address.toLowerCase()),
        )
      : wallets
    : [];

  const pending = jobs.filter((j) => j.status === "queued" || j.status === "armed");
  const chain = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;

  /**
   * The queue in the order it will actually fire.
   *
   * The server picks the job whose stage opens soonest, so listing them in the
   * order someone happened to add them shows a running order that isn't the
   * running order. Jobs with no known stage time go last among the waiting —
   * they arm as soon as they are due, but there is no time to sort them by.
   * Finished jobs sit below the lot, newest first, since they are history.
   */
  const queue = useMemo(() => {
    const rank = (j: Job) => (j.status === "queued" || j.status === "armed" ? 0 : 1);
    return [...jobs].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (rank(a) === 1) return b.addedAt - a.addedAt;
      return (a.startTime ?? Infinity) - (b.startTime ?? Infinity) || a.addedAt - b.addedAt;
    });
  }, [jobs]);
  // Compared by host: the stored URLs are never sent back with their keys.
  const rpcsDiffer =
    props.extraRpcs.length > 0 &&
    JSON.stringify(props.extraRpcs.map(hostOf)) !== JSON.stringify(status?.rpcHosts ?? []);

  return (
    // Named so the Snipe tab above can send you here — it is where firing
    // happens now, and the review step points at it rather than at a button
    // that no longer exists.
    <div className="panel" id="remote-runner">
      <h2>Runner — queue</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Queue drops in advance on a server sitting next to the chain&apos;s
        sequencer. Each job is armed ahead of its stage and fires on the
        server&apos;s own clock, so once a drop is queued you can close this page
        and it will still fire.
      </p>
      {admin ? (
        <p className="dim">
          <b>Wallets come from the server</b>, from its <code>snipe.keys</code> file —
          not from the Wallets box above. Keys never travel to this panel; it only
          ever receives addresses and balances.
        </p>
      ) : null}

      {admin ? (
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
      ) : null}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        {admin ? (
          <button className="secondary" onClick={() => void connect()} disabled={busy || !base || !token}>
            {busy ? <span className="spin">BUSY</span> : connected ? "refresh" : "connect"}
          </button>
        ) : null}
        <button
          className={admin ? "secondary" : "primary"}
          onClick={() => void signIn()}
          disabled={signingIn || !base}
          title="prove your wallet to get in — no token to paste"
        >
          {signingIn ? (
            <span className="spin">SIGNING</span>
          ) : !walletConnected ? (
            "connect wallet"
          ) : (
            "sign in with wallet"
          )}
        </button>
        {admin ? (
          <label className="dim" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={rememberToken}
              onChange={(e) => setRememberToken(e.target.checked)}
            />
            remember token in this browser
          </label>
        ) : null}
        {connected ? (
          <span className="pill ok">
            connected{pending.length ? ` · ${pending.length} pending` : ""}
          </span>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {loginNote ? (
        <p className="ok" style={{ marginBottom: 0 }}>
          {loginNote}
        </p>
      ) : null}

      {admin ? <StaleServer version={serverVersion} /> : null}

      {rpcError ? (
        <p className="warn" style={{ marginBottom: 0 }}>
          The server would not take an endpoint from this page: {rpcError}. It
          keeps reading through the one it already had — fix the URL above and
          press refresh.
        </p>
      ) : null}

      {connected && admin && status?.readRpc ? (
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
            emptyHint={
              <>
                No wallets on the server yet — add them in the <b>WALLETS</b>{" "}
                tab, or a queued job will have nothing to mint with.
              </>
            }
          />

          <div className="scan-bar" style={{ marginTop: 14 }}>
            <span className="bar-label">STYLE</span>
            <div className="chip-group">
              <button
                className={style === "single" ? "secondary active-chip" : "secondary"}
                onClick={() => setStyle("single")}
                title="One burst, exactly at the start time."
              >
                single burst
              </button>
              <button
                className={style === "spread" ? "secondary active-chip" : "secondary"}
                onClick={() => setStyle("spread")}
                title="Several transactions per wallet, sent a step apart around the start."
              >
                spread
              </button>
            </div>
            {style === "spread" ? (
              <>
                <div className="field field-inline">
                  <label>before</label>
                  <input
                    inputMode="numeric"
                    value={before}
                    onChange={(e) => setBefore(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <div className="field field-inline">
                  <label>after</label>
                  <input
                    inputMode="numeric"
                    value={after}
                    onChange={(e) => setAfter(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <div className="field field-inline">
                  <label>step ms</label>
                  <input
                    inputMode="numeric"
                    value={stepMs}
                    onChange={(e) => setStepMs(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <span className="pill">{spreadLabel(before, after, stepMs)}</span>
              </>
            ) : null}
          </div>
          {style === "spread" ? (
            <p className="hint dim" style={{ marginTop: 6 }}>
              Each wallet signs {before + after + 1} transactions on consecutive nonces and
              they go a step apart, so you have transactions arriving in every block either
              side of the start. A block&apos;s timestamp is stamped when the sequencer seals
              it, so the block that carries the mint is already full of people who arrived
              <i> before</i> the start — a single volley at the start cannot be in it. The
              early shots revert with <code>NotActive</code>; that is the price of not knowing
              where the boundary falls. A burned shot costs about 0.0000024 ETH, so{" "}
              {before + after} of them across 100 wallets is roughly{" "}
              {(0.0000024 * (before + after) * 100).toFixed(5)} ETH.
            </p>
          ) : null}

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
            <div className="empty-state">
              QUEUE EMPTY — <span className="es-action">READ A COLLECTION ABOVE AND QUEUE IT →</span>
            </div>
          ) : (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="ledger-table collapsible">
                <thead>
                  <tr>
                    <th>opens</th>
                    <th>drop</th>
                    <th className="num">price</th>
                    <th className="num">supply</th>
                    <th>stage</th>
                    <th>status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {queue.map((j) => {
                    const opensIn = j.startTime ? j.startTime - now : null;
                    const minted =
                      j.outcomes?.filter((o) => o.status === "mined").reduce((n, o) => n + (o.tokenIds?.length ?? 0), 0) ??
                      0;
                    const isOpen = openJob === j.id;
                    return [
                      <tr
                        key={j.id}
                        className={`project-row${isOpen ? " row-open" : ""}`}
                        onClick={() => setOpenJob(isOpen ? null : j.id)}
                      >
                        <td data-label="opens">
                          {j.startTime ? (
                            <>
                              <span className="cell-name">
                                {unixToLocalAndUtc(j.startTime).local}
                              </span>
                              {/* A countdown only means something while the job
                                  is still waiting; on a finished one the date
                                  is the whole story. */}
                              {j.status === "queued" || j.status === "armed" ? (
                                <span
                                  className={`cell-sub ${opensIn !== null && opensIn > 0 && opensIn < 3600 ? "warn" : "dim"}`}
                                >
                                  {opensIn !== null && opensIn > 0 ? (
                                    <span key={opensIn} className="tick">
                                      in {formatCountdown(opensIn)}
                                    </span>
                                  ) : (
                                    "open now"
                                  )}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <span className="dim">as soon as due</span>
                          )}
                        </td>
                        <td data-label="drop">
                          {/* Straight through to the collection — stopPropagation
                              so following the link does not also toggle the row. */}
                          <a
                            className="cell-name"
                            href={openSeaCollectionUrl(chain, j.collection)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={j.collection}
                          >
                            {j.drop?.name ?? j.label}
                          </a>
                          {j.dryRun ? <span className="cell-sub dim">dry run</span> : null}
                        </td>
                        <td className="num" data-label="price">
                          {j.drop ? (
                            BigInt(j.drop.priceWei) === 0n ? (
                              <span className="ok">free</span>
                            ) : (
                              formatEthShort(BigInt(j.drop.priceWei))
                            )
                          ) : (
                            <span className="dim">?</span>
                          )}
                        </td>
                        <td className="num" data-label="supply">
                          {j.drop ? (
                            <>
                              <span className="cell-name">{Number(j.drop.maxSupply).toLocaleString("en-US")}</span>
                              <span className="cell-sub dim">
                                {Number(j.drop.totalSupply).toLocaleString("en-US")} minted
                              </span>
                            </>
                          ) : (
                            <span className="dim">?</span>
                          )}
                        </td>
                        <td className="dim" data-label="stage">
                          {j.stage} ×{j.quantity}
                          {j.wallets?.length ? ` · ${j.wallets.length}w` : ""}
                        </td>
                        <td data-label="status">
                          <span className={STATUS_CLASS[j.status]}>{j.status}</span>
                          {j.status === "done" && minted > 0 ? (
                            <span className="ok"> · {minted} NFT</span>
                          ) : null}
                        </td>
                        <td className="num" data-label="">
                          {j.status === "queued" ? (
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <button
                                className="secondary"
                                style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                                title={
                                  j.gas
                                    ? "Top the wallets this job fires from up to what it will cost them"
                                    : "This server is too old to say what gas the job was queued with — update it"
                                }
                                disabled={!j.gas}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFunding(j.id);
                                }}
                              >
                                fund
                              </button>
                              <button
                                className="secondary"
                                style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void remove(j.id);
                                }}
                              >
                                remove
                              </button>
                            </span>
                          ) : null}
                        </td>
                      </tr>,
                      isOpen ? (
                        <tr key={`${j.id}-detail`} className="detail-row">
                          <td colSpan={7}>
                            <JobDetail job={j} chain={chain} />
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {fundingJob && fundingJob.gas ? (
        <FundJobPanel
          jobLabel={fundingJob.label}
          cost={{
            priceWei: BigInt(fundingJob.drop?.priceWei ?? "0"),
            // "max" means as many as the stage allows, and the stage cap is
            // what the wallet must be able to pay for.
            quantity:
              fundingJob.quantity === "max"
                ? Number(fundingJob.drop?.perWallet ?? 1) || 1
                : fundingJob.quantity,
            maxFeeGwei: fundingJob.gas.maxFeeGwei,
            gasLimit: fundingJob.gas.limit,
            // A spread job needs gas for every shot, not just the one that mints.
            shots: fundingJob.shots ?? 1,
          }}
          wallets={fundingWallets}
          onClose={() => setFunding(null)}
          onFunded={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

/**
 * Expanded view for one job: what the drop is, then how the run went.
 *
 * The drop half is there from the moment the job is queued — before it runs
 * there is no plan and no outcome, and "nothing here yet" is a poor answer to
 * someone checking what they queued.
 */
function JobDetail({ job, chain }: { job?: Job; chain: ChainInfo }) {
  if (!job) return null;
  const d = job.drop;
  return (
    <div>
      {job.error ? <p className="error">{job.error}</p> : null}
      {job.reminder ? <p className="notice notice-withdraw">{job.reminder}</p> : null}

      {d ? (
        <dl className="kv">
          <dt>collection</dt>
          <dd>
            <a href={openSeaCollectionUrl(chain, job.collection)} target="_blank" rel="noreferrer">
              {d.name}
            </a>{" "}
            <span className="dim">on OpenSea</span> ·{" "}
            <a href={`${chain.explorerUrl}/address/${job.collection}`} target="_blank" rel="noreferrer">
              contract
            </a>
          </dd>
          <dt>price</dt>
          <dd>
            {BigInt(d.priceWei) === 0n ? "free" : `${formatEthShort(BigInt(d.priceWei))} ETH`} per NFT
            {BigInt(d.priceWei) > 0n && job.quantity !== "max" ? (
              <span className="dim">
                {" "}
                · {formatEthShort(BigInt(d.priceWei) * BigInt(job.quantity))} ETH per wallet for{" "}
                {job.quantity}
              </span>
            ) : null}
          </dd>
          <dt>supply</dt>
          <dd>
            {Number(d.maxSupply).toLocaleString("en-US")} total ·{" "}
            {Number(d.totalSupply).toLocaleString("en-US")} minted so far ·{" "}
            {Math.max(0, Number(d.maxSupply) - Number(d.totalSupply)).toLocaleString("en-US")} left
          </dd>
          <dt>per wallet</dt>
          <dd>{d.perWallet === 0 ? "no cap" : `${d.perWallet} max`}</dd>
          <dt>window</dt>
          <dd>
            {d.startTime > 0 ? unixToLocalAndUtc(d.startTime).local : "not set"}
            {d.endTime > 0 ? ` → ${unixToLocalAndUtc(d.endTime).local}` : ""}
            <span className="dim"> · read {new Date(d.readAt).toLocaleString()}</span>
          </dd>
        </dl>
      ) : null}

      {job.plan ? (
        <dl className="kv">
          {/* Only when the drop block above isn't already saying it — a job
              queued by an older server has the plan and nothing else. */}
          {d ? null : (
            <>
              <dt>collection</dt>
              <dd>
                {job.plan.name} — {job.plan.totalSupply}/{job.plan.maxSupply}
              </dd>
            </>
          )}
          <dt>endpoints</dt>
          <dd>{job.plan.endpoints.join(", ")}</dd>
          <dt>wallets</dt>
          <dd>
            {job.plan.wallets.map((w) => (
              <div key={w.address}>
                <Addr value={w.address} head={10} />{" "}
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
                <Addr value={o.address} head={10} />
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

