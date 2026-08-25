import { useCallback, useEffect, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { AddrLink, TxLink } from "./Bits";

/**
 * Move ETH across the server's wallet set: fan it out before a mint, sweep it
 * back after.
 *
 * Both run on the server, so a hundred transfers are signed together and fired
 * at the sequencer at once — roughly one round-trip, not a hundred. Keys never
 * come here; the only key this page can send is the optional one-off payer,
 * which the server uses for that call and never stores.
 */

interface TransferOutcome {
  address: string;
  txHash?: string;
  amountWei?: string;
  status: "sent" | "rejected" | "skipped";
  detail?: string;
}

interface ServerWallet {
  address: `0x${string}`;
  label?: string;
  balance: string | null;
}

interface WalletsView {
  chain?: string;
  wallets: ServerWallet[];
}

interface DisperseResult {
  from: string;
  fromBalanceWei: string;
  requiredWei: string;
  funded: number;
  skipped: number;
  outcomes: TransferOutcome[];
}

interface CollectResult {
  to: string;
  swept: number;
  skipped: number;
  totalWei: string;
  outcomes: TransferOutcome[];
}

const eth = (wei?: string) => (wei ? Number(wei) / 1e18 : 0);

export default function FundingTab() {
  const { url, setUrl, token, setToken, remember, setRemember, base, call, save } = useRunnerApi();

  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<WalletsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Disperse
  const [payerMode, setPayerMode] = useState<"stored" | "key">("key");
  const [payerAddress, setPayerAddress] = useState("");
  const [payerKey, setPayerKey] = useState("");
  const [amount, setAmount] = useState("0.001");
  const [skipFunded, setSkipFunded] = useState(true);
  const [dResult, setDResult] = useState<DisperseResult | null>(null);

  // Collect
  const [dest, setDest] = useState("");
  const [cResult, setCResult] = useState<CollectResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const v = (await call("/api/wallets")) as unknown as WalletsView;
      setView(v);
      setConnected(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call]);

  useEffect(() => {
    if (base && token) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      save();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runDisperse(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setDResult(null);
    try {
      const body: Record<string, unknown> = {
        amountEth: amount.trim(),
        dryRun,
        ...(skipFunded ? { skipIfAtLeastEth: amount.trim() } : {}),
      };
      if (payerMode === "key") body.fromKey = payerKey.trim();
      else body.fromAddress = payerAddress;

      const r = (await call("/api/disperse", {
        method: "POST",
        body: JSON.stringify(body),
      })) as unknown as DisperseResult;
      setDResult(r);
      if (!dryRun) {
        // It was a private key; don't leave it on screen.
        setPayerKey("");
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runCollect(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setCResult(null);
    try {
      const r = (await call("/api/collect", {
        method: "POST",
        body: JSON.stringify({ to: dest.trim(), dryRun }),
      })) as unknown as CollectResult;
      setCResult(r);
      if (!dryRun) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const wallets = view?.wallets ?? [];
  const total = wallets.reduce((n, w) => n + Number(w.balance ?? 0), 0);
  const empty = wallets.filter((w) => Number(w.balance ?? 0) === 0).length;

  return (
    <div>
      <div className="panel">
        <h2>Funding</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Top the wallet set up before a mint, and sweep it back afterwards.
          Everything runs on the server: a hundred transfers are signed together
          and fired at the sequencer at once, so it takes about one round-trip
          rather than a hundred of them.
        </p>
        <p className="hint dim" style={{ marginBottom: 0 }}>
          For a free mint on this chain the real cost is the gas <i>reservation</i>,
          not the fee: a node checks the wallet holds{" "}
          <code>gas limit × max fee</code> before it will even accept the
          transaction, while the fee actually paid is a few millionths of an ETH.
          With the default 250,000 limit at 2 gwei that reservation is 0.0005 ETH,
          so <b>0.001 ETH per wallet</b> is a comfortable float. Add the mint
          price on top for a paid drop.
        </p>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 2, minWidth: 240 }}>
            <label>server URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" />
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
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            remember token in this browser
          </label>
          {connected ? (
            <span className="pill ok">
              ● {wallets.length} wallets · {total.toFixed(4)} ETH total
              {empty ? ` · ${empty} empty` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {connected ? (
        <>
          <div className="panel">
            <h2>Send out — one wallet → all {wallets.length}</h2>
            <div className="mode-toggle" style={{ marginBottom: 12 }}>
              <button className={payerMode === "key" ? "active" : ""} onClick={() => setPayerMode("key")}>
                paste a payer key
              </button>
              <button className={payerMode === "stored" ? "active" : ""} onClick={() => setPayerMode("stored")}>
                use a stored wallet
              </button>
            </div>

            {payerMode === "key" ? (
              <div className="field">
                <label>payer private key — used for this transfer, never stored</label>
                <input
                  type="password"
                  value={payerKey}
                  onChange={(e) => setPayerKey(e.target.value)}
                  placeholder="0x… (64 hex chars)"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="field">
                <label>payer — one of the wallets already on the server</label>
                <select value={payerAddress} onChange={(e) => setPayerAddress(e.target.value)}>
                  <option value="">select a wallet…</option>
                  {wallets.map((w) => (
                    <option key={w.address} value={w.address}>
                      {w.address.slice(0, 10)}…{w.address.slice(-4)} — {Number(w.balance ?? 0).toFixed(4)} ETH
                      {w.label ? ` (${w.label})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 10 }}>
              <div className="field" style={{ width: 190 }}>
                <label>amount per wallet (ETH)</label>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.001" />
              </div>
              <label className="dim" style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 10 }}>
                <input type="checkbox" checked={skipFunded} onChange={(e) => setSkipFunded(e.target.checked)} />
                skip wallets that already hold this much
              </label>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button className="secondary" disabled={busy} onClick={() => void runDisperse(true)}>
                DRY RUN
              </button>
              <button
                className="primary"
                disabled={busy || (payerMode === "key" ? !payerKey.trim() : !payerAddress)}
                onClick={() => void runDisperse(false)}
              >
                SEND TO ALL WALLETS
              </button>
            </div>

            {dResult ? (
              <>
                <dl className="kv" style={{ marginTop: 14 }}>
                  <dt>payer</dt>
                  <dd>
                    <AddrLink address={dResult.from} /> — {eth(dResult.fromBalanceWei).toFixed(4)} ETH
                  </dd>
                  <dt>needs</dt>
                  <dd>{eth(dResult.requiredWei).toFixed(5)} ETH incl. gas</dd>
                  <dt>result</dt>
                  <dd>
                    <span className="ok">{dResult.funded} sent</span>
                    {dResult.skipped ? <span className="dim"> · {dResult.skipped} already funded</span> : null}
                  </dd>
                </dl>
                <OutcomeList outcomes={dResult.outcomes} />
              </>
            ) : null}
          </div>

          <div className="panel">
            <h2>Collect back — all {wallets.length} → one address</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              Every wallet with a balance sends what it holds, minus the gas it
              must reserve. Empty and dust wallets are skipped automatically —
              nothing to type but the destination.
            </p>
            <div className="field">
              <label>destination address</label>
              <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="0x…" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button className="secondary" disabled={busy || !dest.trim()} onClick={() => void runCollect(true)}>
                DRY RUN
              </button>
              <button className="primary" disabled={busy || !dest.trim()} onClick={() => void runCollect(false)}>
                COLLECT EVERYTHING
              </button>
            </div>

            {cResult ? (
              <>
                <dl className="kv" style={{ marginTop: 14 }}>
                  <dt>to</dt>
                  <dd>
                    <AddrLink address={cResult.to} />
                  </dd>
                  <dt>result</dt>
                  <dd>
                    <span className="ok">
                      {cResult.swept} swept · {eth(cResult.totalWei).toFixed(5)} ETH
                    </span>
                    {cResult.skipped ? <span className="dim"> · {cResult.skipped} skipped</span> : null}
                  </dd>
                </dl>
                <OutcomeList outcomes={cResult.outcomes} />
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function OutcomeList({ outcomes }: { outcomes: TransferOutcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table className="projects">
        <thead>
          <tr>
            <th>wallet</th>
            <th>amount</th>
            <th>status</th>
            <th>tx</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.address + (o.txHash ?? o.status)}>
              <td className="dim">
                {o.address.slice(0, 10)}…{o.address.slice(-4)}
              </td>
              <td>{o.amountWei ? `${eth(o.amountWei).toFixed(5)} ETH` : "—"}</td>
              <td>
                <span className={o.status === "sent" ? "ok" : o.status === "skipped" ? "dim" : "error"}>
                  {o.status}
                </span>
                {o.detail ? <span className="dim"> — {o.detail}</span> : null}
              </td>
              <td>{o.txHash ? <TxLink hash={o.txHash} label="tx" /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
