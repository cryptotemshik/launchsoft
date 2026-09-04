import { useState } from "react";
import WalletCard from "./WalletCard";
import { useMe } from "../lib/runnerClient";

/**
 * Inspect any wallet on Robinhood Chain: paste an address and see its balance,
 * NFT holdings and NFT (OpenSea) PnL — every figure from the chain. It is for
 * strangers' wallets as much as your own: paste one someone posted and see what
 * they actually made.
 */
const RECENT_KEY = "launchpad.inspect.recent";

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export default function WalletInspectTab() {
  const { me } = useMe();
  const [input, setInput] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [error, setError] = useState<string | null>(null);

  function look(raw?: string) {
    const a = (raw ?? input).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) {
      setError("that isn't a wallet address");
      return;
    }
    setError(null);
    setAddress(a);
    setInput(a);
    const next = [a, ...recent.filter((x) => x !== a)].slice(0, 8);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>Inspect a wallet</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Paste any address on Robinhood Chain and see its balance, NFT holdings
          and NFT PnL — mint cost against what its tokens have sold for, straight
          from the chain. Works on anyone&apos;s wallet, not just yours.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ flex: 1, minWidth: 260 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && look()}
            placeholder="0x… wallet address"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="primary" onClick={() => look()} disabled={!input.trim()}>
            inspect
          </button>
        </div>
        {error ? <p className="error" style={{ marginBottom: 0 }}>{error}</p> : null}
        {recent.length > 0 ? (
          <div className="wallet-picker-chips" style={{ marginTop: 10 }}>
            {recent.map((a) => (
              <button
                key={a}
                className={address === a ? "secondary active-chip" : "secondary"}
                onClick={() => look(a)}
                title={a}
              >
                {a.slice(0, 6)}…{a.slice(-4)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {address ? (
        <div className="panel">
          <WalletCard address={address} />
        </div>
      ) : !me ? (
        <div className="panel panel-locked">
          <p className="warn" style={{ margin: 0 }}>
            Sign in with your wallet (top bar) to inspect addresses.
          </p>
        </div>
      ) : null}
    </div>
  );
}
