import { clearRunnerToken, useMe } from "../lib/runnerClient";
import { useSignIn } from "../lib/useSignIn";

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The account control in the top bar — the front door to the public app.
 *
 * Signed out, it is a single "sign in" that connects the wallet and signs the
 * server's challenge. Signed in, it shows who you are and your plan, with a way
 * out. It only appears when a backend is configured (a public build with
 * VITE_RUNNER_URL, or once the operator has connected one), so a bare operator
 * build shows nothing here and the owner keeps using the Snipe tab as before.
 */
export default function AccountBadge() {
  const { me } = useMe();
  const { signIn, busy, error, hasBackend, walletConnected, hasWalletConnect } = useSignIn();

  if (!hasBackend) return null;

  if (me) {
    const label = me.profile.nickname?.trim() || (me.address ? shortAddress(me.address) : "operator");
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className={`pill ${me.tier === "pro" ? "ok" : ""}`} title={me.address ?? "operator token"}>
          {label}
          {me.tier === "pro" ? " · PRO" : ""}
        </span>
        <button
          className="secondary"
          style={{ padding: "2px 8px", fontSize: 11 }}
          title="sign out"
          onClick={() => {
            clearRunnerToken();
            window.location.reload();
          }}
        >
          out
        </button>
      </div>
    );
  }

  // Once a wallet is connected the only step left is to sign — one button.
  // Before that, offer the two ways in: a browser extension, or a phone over
  // WalletConnect's QR (only when a project id was baked in, so a build without
  // one falls back to the single extension button it always had).
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {walletConnected ? (
        <button className="secondary" disabled={busy} onClick={() => void signIn()} title="prove your wallet to sign in">
          {busy ? <span className="spin">…</span> : "sign in"}
        </button>
      ) : (
        <>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void signIn("injected")}
            title="connect a browser extension wallet"
          >
            {busy ? <span className="spin">…</span> : hasWalletConnect ? "browser wallet" : "connect & sign in"}
          </button>
          {hasWalletConnect ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void signIn("walletConnect")}
              title="connect a phone wallet with a QR code"
            >
              mobile / QR
            </button>
          ) : null}
        </>
      )}
      {error ? <span className="error" style={{ fontSize: 11 }}>{error}</span> : null}
    </div>
  );
}
