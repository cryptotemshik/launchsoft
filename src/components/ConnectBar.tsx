import { useState } from "react";
import GasBlock from "./GasBlock";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { CHAINS } from "../chains";
import { useChainSwitcher, useSigner, useSignerControls } from "../signer";

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function ConnectBar({ onHome }: { onHome?: () => void }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { chainInfo, wrongNetwork } = useSigner();
  const { select, switching, activeId } = useChainSwitcher();

  const { mode, setMode, locals, active, addLocalKey, removeLocal, clearLocals, selectLocal } =
    useSignerControls();
  const [keyInput, setKeyInput] = useState("");
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
          LAUNCH
          <span className="brand-dim">PAD</span>
          <span className="cursor" aria-hidden>_</span>
        </h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <GasBlock />
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

          {/* Network selector — works in both modes. */}
          <select
            className={`net-select ${wrongNetwork ? "bad" : ""}`}
            value={CHAINS.some((c) => c.id === activeId) ? activeId : ""}
            disabled={switching}
            onChange={(e) => select(Number(e.target.value))}
          >
            {!CHAINS.some((c) => c.id === activeId) ? (
              <option value="">
                {wrongNetwork ? "unsupported — pick a network" : "select network"}
              </option>
            ) : null}
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          {mode === "wallet" ? (
            !isConnected ? (
              <>
                <button
                  className="secondary"
                  disabled={isPending}
                  onClick={() => connect({ connector: connectors[0] })}
                >
                  {isPending ? <span className="spin">CONNECTING</span> : "connect wallet"}
                </button>
                {error ? <span className="error">{error.message}</span> : null}
              </>
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
            XSS bug) can read them. For real funds, run LaunchPad locally
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
