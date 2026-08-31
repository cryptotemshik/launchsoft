import { useCallback, useEffect, useState } from "react";
import RunnerConnect from "./RunnerConnect";
import { useRunnerApi } from "../lib/runnerClient";
import StaleServer from "./StaleServer";
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
  const { url, setUrl, token, setToken, remember, setRemember, base, call, save, serverVersion } = api;

  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<WalletsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysText, setKeysText] = useState("");
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  /** Removes one wallet, or every ticked one when called with no argument. */
  async function removeWallets(addresses: string[]) {
    if (addresses.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let v: (WalletsView & { removed: number }) | null = null;
      if (serverVersion !== null && serverVersion < 2) {
        // An old server only understands one address in the query string. Go
        // one at a time so the button still works before the box is updated;
        // the notice above tells the user why this is slow.
        let removed = 0;
        for (const a of addresses) {
          v = (await call(`/api/wallets?address=${a}`, {
            method: "DELETE",
          })) as unknown as WalletsView & { removed: number };
          removed += v.removed ?? 0;
        }
        v = v ? { ...v, removed } : null;
      } else {
        v = (await call("/api/wallets", {
          method: "DELETE",
          body: JSON.stringify({ addresses }),
        })) as unknown as WalletsView & { removed: number };
      }
      if (v) setView(v);
      setSelected(new Set());
      setNotice(`Removed ${v?.removed ?? 0} wallet${v?.removed === 1 ? "" : "s"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(address: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
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
        <RunnerConnect url={url} setUrl={setUrl} token={token} setToken={setToken} />
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <button className="secondary" onClick={() => void connect()} disabled={busy || !base || !token}>
            {busy ? <span className="spin">BUSY</span> : connected ? "refresh" : "connect"}
          </button>
          <label className="dim" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            remember token in this browser
          </label>
          {connected ? (
            <span className="pill ok">
              connected{view?.chain ? ` · ${view.chain}` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />
        <p className="hint dim" style={{ marginBottom: 0 }}>
          Same server and token as the Snipe tab — connect in either and both
          are connected.
        </p>
      </div>

      {/* Shown even before connecting, disabled, so it's obvious this is where
          wallets go rather than leaving the page looking empty. */}
      <>
        <div className={`panel ${connected ? "" : "panel-locked"}`}>
            <h2>Add wallets</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              One private key per line. They upload to the server and this box is
              cleared straight away.
            </p>
            {!connected ? (
              <p className="warn" style={{ marginTop: 0 }}>
                Connect to your server above first — that&apos;s where the wallets
                are stored.
              </p>
            ) : null}
            <textarea
              rows={4}
              value={keysText}
              disabled={!connected}
              onChange={(e) => setKeysText(e.target.value)}
              placeholder={"0x…\n0x…"}
              autoComplete="off"
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", WebkitTextSecurity: "disc" } as React.CSSProperties}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 8 }}>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>label (optional — shown next to these wallets)</label>
                <input
                  value={label}
                  disabled={!connected}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. batch A"
                />
              </div>
              <button
                className="primary"
                disabled={!connected || busy || !keysText.trim()}
                onClick={() => void addWallets()}
              >
                UPLOAD TO SERVER
              </button>
            </div>
            {notice ? <p className="ok" style={{ marginBottom: 0 }}>{notice}</p> : null}
          </div>

          <div className={`panel ${connected ? "" : "panel-locked"}`}>
            <h2>On the server ({wallets.length})</h2>
            {!connected ? (
              <p className="dim" style={{ marginBottom: 0 }}>
                Connect above to see the wallets already stored on your server.
              </p>
            ) : wallets.length === 0 ? (
              <p className="dim" style={{ marginBottom: 0 }}>
                No wallets yet — add some above and the runner will mint with them.
              </p>
            ) : (
              <>
                <div
                  style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}
                >
                  <button
                    className="secondary"
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    disabled={busy}
                    onClick={() =>
                      setSelected(
                        selected.size === wallets.length
                          ? new Set()
                          : new Set(wallets.map((w) => w.address)),
                      )
                    }
                  >
                    {selected.size === wallets.length ? "clear selection" : "select all"}
                  </button>
                  <button
                    className="danger"
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    disabled={busy || selected.size === 0}
                    onClick={() => void removeWallets([...selected])}
                  >
                    remove selected ({selected.size})
                  </button>
                </div>
                <div className="table-wrap">
                  <table className="projects">
                    <thead>
                      <tr>
                        <th style={{ width: 34 }}>
                          <input
                            type="checkbox"
                            checked={selected.size === wallets.length && wallets.length > 0}
                            onChange={() =>
                              setSelected(
                                selected.size === wallets.length
                                  ? new Set()
                                  : new Set(wallets.map((w) => w.address)),
                              )
                            }
                            aria-label="select every wallet"
                          />
                        </th>
                        <th>address</th>
                        <th>label</th>
                        <th>balance</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {wallets.map((w) => (
                        <tr key={w.address} className={selected.has(w.address) ? "row-selected" : ""}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(w.address)}
                              onChange={() => toggle(w.address)}
                              aria-label={`select ${w.address}`}
                            />
                          </td>
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
                              onClick={() => void removeWallets([w.address])}
                            >
                              remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="hint dim" style={{ marginBottom: 0 }}>
              Every wallet here fires on every queued drop. Removing one only
              deletes its key from the server — the wallet itself and its
              contents are untouched.
            </p>
          </div>
      </>
    </div>
  );
}
