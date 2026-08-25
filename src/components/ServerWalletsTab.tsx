import { useCallback, useEffect, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { AddrLink } from "./Bits";

/**
 * Wallets that live on the VPS runner.
 *
 * These are the wallets that actually mint: the server signs with them, next to
 * the sequencer. This tab is how you add and remove them without SSH.
 *
 * The API behind it is write-only by design — keys go up, and only addresses,
 * labels and balances come back. Nothing here (or on the server's API) can read
 * a stored key out again, so a leaked token cannot drain what is already there.
 */

interface ServerWallet {
  address: `0x${string}`;
  label?: string;
  balance: string | null;
}

interface WalletsView {
  chainId: number;
  chain?: string;
  wallets: ServerWallet[];
}

export default function ServerWalletsTab() {
  const api = useRunnerApi();
  const { url, setUrl, token, setToken, remember, setRemember, base, call, save } = api;

  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<WalletsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysText, setKeysText] = useState("");
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

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

  // Auto-connect when credentials are already remembered from another tab.
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

  async function addWallets() {
    if (!keysText.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = (await call("/api/wallets", {
        method: "POST",
        body: JSON.stringify({ keys: keysText, label: label.trim() || undefined }),
      })) as unknown as WalletsView & { added: number; rejected: number };
      setView(r);
      // Clear immediately: the box held private keys.
      setKeysText("");
      setLabel("");
      setNotice(
        `Added ${r.added} wallet${r.added === 1 ? "" : "s"}` +
          (r.rejected ? ` · ${r.rejected} line(s) rejected as invalid` : "") +
          (r.added === 0 && !r.rejected ? " — they were already on the server" : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeWallet(address: string) {
    setBusy(true);
    setError(null);
    try {
      const v = (await call(`/api/wallets?address=${encodeURIComponent(address)}`, {
        method: "DELETE",
      })) as unknown as WalletsView;
      setView(v);
      setNotice(`Removed ${address.slice(0, 10)}…`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const wallets = view?.wallets ?? [];

  return (
    <div>
      <div className="panel">
        <h2>Server wallets</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          The wallets your VPS runner mints with. Add them here once and they
          stay on the server — closing this page, or the phone, changes nothing.
          The Snipe tab&apos;s own Wallets box is a different thing entirely
          (it fires from this browser); if you use the runner, ignore it.
        </p>
        <p className="warn" style={{ marginBottom: 0 }}>
          Keys are sent to your server over the tunnel and stored there in{" "}
          <code>snipe.keys</code> (readable only by the server&apos;s user). They
          are <b>never sent back</b> — this page can only ever see addresses, so
          a stolen token cannot extract a key already on the box. Still: fund
          these wallets with what a mint needs, not with savings.
        </p>
      </div>

      <div className="panel">
        <h2>Connection</h2>
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
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            remember token in this browser
          </label>
          {connected ? (
            <span className="pill ok">
              ● connected{view?.chain ? ` · ${view.chain}` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <p className="hint dim" style={{ marginBottom: 0 }}>
          Same server and token as the Snipe tab — connect in either and both
          are connected.
        </p>
      </div>

      {connected ? (
        <>
          <div className="panel">
            <h2>Add wallets</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              One private key per line. They upload to the server and this box is
              cleared straight away.
            </p>
            <textarea
              rows={4}
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
              placeholder={"0x…\n0x…"}
              autoComplete="off"
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", WebkitTextSecurity: "disc" } as React.CSSProperties}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 8 }}>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>label (optional — shown next to these wallets)</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. batch A" />
              </div>
              <button className="primary" disabled={busy || !keysText.trim()} onClick={() => void addWallets()}>
                UPLOAD TO SERVER
              </button>
            </div>
            {notice ? <p className="ok" style={{ marginBottom: 0 }}>{notice}</p> : null}
          </div>

          <div className="panel">
            <h2>On the server ({wallets.length})</h2>
            {wallets.length === 0 ? (
              <p className="dim" style={{ marginBottom: 0 }}>
                No wallets yet — add some above and the runner will mint with them.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="projects">
                  <thead>
                    <tr>
                      <th>address</th>
                      <th>label</th>
                      <th>balance</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((w) => (
                      <tr key={w.address}>
                        <td>
                          <AddrLink address={w.address} />
                        </td>
                        <td className="dim">{w.label ?? "—"}</td>
                        <td className={w.balance && Number(w.balance) > 0 ? "" : "warn"}>
                          {w.balance === null ? "—" : `${Number(w.balance).toFixed(4)} ETH`}
                        </td>
                        <td>
                          <button
                            className="secondary"
                            style={{ padding: "2px 10px", fontSize: 11 }}
                            disabled={busy}
                            onClick={() => void removeWallet(w.address)}
                          >
                            remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint dim" style={{ marginBottom: 0 }}>
              Every wallet here fires on every queued drop. Removing one only
              deletes its key from the server — the wallet itself and its
              contents are untouched.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
