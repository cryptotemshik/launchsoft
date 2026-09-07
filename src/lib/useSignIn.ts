import { useCallback, useMemo, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { useSigner } from "../signer";
import { saveRunnerCreds, signInWithWallet, useRunnerApi } from "./runnerClient";

/** How a wallet reaches us: an extension in this browser, or a phone over QR. */
export type ConnectKind = "injected" | "walletConnect";

/**
 * Signing in with a wallet, as one action any part of the app can offer.
 *
 * It rolls the whole handshake into a single call: connect a wallet to the
 * browser if none is, sign the server's challenge, store the returned session
 * token as the runner credential, and reload so every tab picks it up. The
 * reload is deliberate — the token lives in a per-hook state that does not
 * otherwise propagate between components, and a login is exactly the moment a
 * clean reload is acceptable.
 *
 * A wallet can arrive two ways — a browser extension (injected) or a phone
 * scanning a WalletConnect QR — so `signIn` takes an optional kind. On a phone
 * with no extension the injected path has nothing to connect to; WalletConnect
 * is what makes the app usable there. The QR connector only exists when a
 * project id was baked in at build (see wagmi.ts), so `hasWalletConnect` tells
 * the UI whether to offer that choice at all.
 *
 * Returns a `signIn(kind?)` to call, whether a wallet is connected yet, whether
 * WalletConnect is available, and any error.
 */
export function useSignIn() {
  const { base } = useRunnerApi();
  const signer = useSigner();
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const injectedConnector = useMemo(
    () => connectors.find((c) => c.type === "injected") ?? connectors[0],
    [connectors],
  );
  const walletConnectConnector = useMemo(
    () => connectors.find((c) => c.type === "walletConnect"),
    [connectors],
  );

  const signIn = useCallback(async (kind: ConnectKind = "injected") => {
    setError(null);
    if (!base) {
      setError("the service address isn't configured yet");
      return;
    }
    if (!isConnected || !signer.address || !signer.walletClient) {
      // Connect the wallet first; the user presses sign in once more to sign.
      const chosen = kind === "walletConnect" ? walletConnectConnector : injectedConnector;
      if (chosen) {
        connect({ connector: chosen });
        setError(
          kind === "walletConnect"
            ? "scan the QR / approve on your phone, then press sign in"
            : "approve the wallet, then press sign in again",
        );
      } else {
        setError("no wallet available to connect");
      }
      return;
    }
    const address = signer.address;
    const account = signer.txAccount ?? address;
    setBusy(true);
    try {
      const { token } = await signInWithWallet(base, address, (message) =>
        signer.walletClient!.signMessage({ account, message }),
      );
      saveRunnerCreds(base, token, true);
      // Everything keys off the stored token on load — reload to adopt it.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [base, isConnected, signer, connect, injectedConnector, walletConnectConnector]);

  return {
    signIn,
    busy,
    error,
    walletConnected: isConnected,
    hasBackend: Boolean(base),
    hasWalletConnect: Boolean(walletConnectConnector),
  };
}
