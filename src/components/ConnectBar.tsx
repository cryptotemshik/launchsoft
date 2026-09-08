import { useState } from "react";
import GasBlock from "./GasBlock";
import AccountBadge from "./AccountBadge";
import { setSoundEnabled, soundEnabled } from "../lib/sound";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { DEFAULT_CHAIN_ID } from "../chains";
import { useChainSwitcher, useSigner, useSignerControls } from "../signer";
import { useRunnerApi } from "../lib/runnerClient";
import { OrvexMark } from "./icons";

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function ConnectBar({ onHome }: { onHome?: () => void }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  // Two doors into a wallet: a browser extension (injected) or a phone over
  // WalletConnect's QR. The QR connector only exists when a project id was
  // baked in at build (wagmi.ts) — without one we show the single extension
  // button this bar always had.
  const injectedConnector = connectors.find((c) => c.type === "injected") ?? connectors[0];
  const walletConnectConnector = connectors.find((c) => c.type === "walletConnect");
  const { chainInfo, wrongNetwork } = useSigner();
  const { select, switching } = useChainSwitcher();
  // When a backend is configured, the account badge is the single connect entry
  // point; ConnectBar shows its own connect button only without one.
  const { base } = useRunnerApi();

  const { mode, setMode, locals, active, addLocalKey, removeLocal, clearLocals, selectLocal } =
    useSignerControls();
  const [keyInput, setKeyInput] = useState("");
  const [snd, setSnd] = useState(soundEnabled);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  function loadKey() {
    // Accept several keys at once — one per line, comma- or space-separated.
    const raws = keyInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (raws.length === 0) return;
    const errs: string[] = [];
    for (const raw of raws) {
      try {
        addLocalKey(raw);
      } catch (e) {
        errs.push((e as Error).message);
      }
    }
    setKeyInput("");
    setKeyError(errs.length ? `${errs.length} key(s) rejected: ${errs[0]}` : null);
  }

  return (
    <div>
      <div className="topbar">
        <h1
          className={onHome ? "brand-home" : undefined}
          onClick={onHome}
          role={onHome ? "button" : undefined}
          title={onHome ? "back to cover" : undefined}
        >
          <OrvexMark className="brand-mark" width={20} height={20} aria-hidden />
          ORVEX
          <span className="cursor" aria-hidden>_</span>
        </h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <GasBlock />
          <AccountBadge />
          <button
            type="button"
            className="snd-toggle"
            aria-pressed={snd}
            title="terminal sounds"
            onClick={() => {
              setSoundEnabled(!snd);
              setSnd(!snd);
            }}
          >
            [SND {snd ? "ON" : "OFF"}]
          </button>
          <div className="mode-toggle">
            <button
              className={mode === "wallet" ? "active" : ""}
              onClick={() => setMode("wallet")}
            >
              wallet
            </button>
            <button
              className={mode === "local" ? "active" : ""}
              onClick={() => setMode("local")}
            >
              fast ⚡
            </button>
          </div>

          {/* One chain for now — Robinhood. No picker: a static badge when the
              wallet is on it, and a one-tap switch when it isn't. */}
          {wrongNetwork ? (
            <button
              className="net-select bad"
              disabled={switching}
              onClick={() => select(DEFAULT_CHAIN_ID)}
              title="switch your wallet to Robinhood Chain"
            >
              {switching ? "switching…" : "switch to Robinhood ⚠"}
            </button>
          ) : (
            <span className="pill">Robinhood Chain</span>
          )}

          {mode === "wallet" ? (
            !isConnected ? (
              // The single "connect wallet" lives in the account badge (it
              // connects the wallet AND signs in). Only a build with no backend
              // — where the badge isn't shown — needs its own connect button
              // here, so this one appears only then.
              !base ? (
                <>
                  {/* An injected wallet if the page has one, else WalletConnect
                      (QR on desktop, deep link on a phone). */}
                  <button
                    className="secondary"
                    disabled={isPending}
                    onClick={() => {
                      const hasInjected =
                        typeof window !== "undefined" &&
                        Boolean((window as { ethereum?: unknown }).ethereum);
                      const chosen = hasInjected
                        ? injectedConnector
                        : (walletConnectConnector ?? injectedConnector);
                      connect({ connector: chosen });
                    }}
                  >
                    {isPending ? <span className="spin">CONNECTING</span> : "connect wallet"}
                  </button>
                  {error ? <span className="error">{error.message}</span> : null}
                </>
              ) : null
            ) : (
              <>
                {chainInfo ? (
                  <span className="pill ok">{chainInfo.label}</span>
                ) : (
                  <span className="pill bad">wrong network</span>
                )}
                <span className="pill">{shortAddress(address!)}</span>
                <button className="secondary" onClick={() => disconnect()}>
                  disconnect
                </button>
              </>
            )
          ) : active ? (
            <>
              <span className="pill warn">⚡ local · auto-sign</span>
              {locals.length > 1 ? (
                <select
                  className="net-select"
                  value={active.account.address}
                  onChange={(e) => selectLocal(e.target.value)}
                  title="wallet that signs / launches"
                >
                  {locals.map((l) => (
                    <option key={l.account.address} value={l.account.address}>
                      {shortAddress(l.account.address)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="pill">{shortAddress(active.account.address)}</span>
              )}
              <button className="danger" onClick={clearLocals}>
                remove {locals.length > 1 ? `all (${locals.length})` : "key"}
              </button>
            </>
          ) : (
            <span className="pill warn">no key loaded</span>
          )}
        </div>
      </div>

      {mode === "local" ? (
        <div className="panel signer-panel">
          <h2>Fast mode — local signer{locals.length > 0 ? ` (${locals.length} loaded)` : ""}</h2>
          <p className="warn" style={{ marginTop: 0 }}>
            ⚠ Paste one or more private keys (one per line). Transactions then
            sign automatically with no wallet pop-up, from whichever wallet is
            selected as active. Keys stay in this tab&apos;s memory only — never
            saved, never sent anywhere — and are gone on refresh. Anyone who can
            run script in this page (a browser extension, a bad dependency, an
            XSS bug) can read them. For real funds, run Orvex locally
            (<span className="mono-break">git clone … &amp;&amp; npm run dev</span>)
            rather than on the public URL, and use wallets that hold only what
            this session needs.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <textarea
              rows={2}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={"0x… (64 hex chars) — one per line to add several"}
              autoComplete="off"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 240,
                fontFamily: "var(--mono)",
                ...(reveal ? {} : { WebkitTextSecurity: "disc" }),
              } as React.CSSProperties}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button className="secondary" onClick={() => setReveal(!reveal)}>
                {reveal ? "hide" : "show"}
              </button>
              <button className="primary" onClick={loadKey}>
                add key(s)
              </button>
            </div>
          </div>
          {keyError ? <p className="error">{keyError}</p> : null}

          {locals.length > 0 ? (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="dim" style={{ fontSize: 12, marginBottom: 2 }}>
                loaded wallets — the selected one signs and launches:
              </div>
              {locals.map((l) => {
                const isActive = active?.account.address === l.account.address;
                return (
                  <div
                    key={l.account.address}
                    style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}
                  >
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="active-local"
                        checked={isActive}
                        onChange={() => selectLocal(l.account.address)}
                      />
                      <span className={isActive ? "ok mono-break" : "mono-break"}>
                        {l.account.address}
                      </span>
                    </label>
                    <button
                      className="secondary"
                      style={{ padding: "2px 10px", fontSize: 11 }}
                      onClick={() => removeLocal(l.account.address)}
                    >
                      remove
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
