import { useCallback, useMemo, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { useSigner } from "../signer";
import { saveRunnerCreds, signInWithWallet, useRunnerApi } from "./runnerClient";

/**
 * How a wallet reaches us. "auto" is the only one the UI needs: it picks the
 * injected provider when one is present (a desktop extension, or a wallet's own
 * in-app browser) and WalletConnect otherwise (QR on desktop, deep link on a
 * phone). The explicit kinds remain for callers that want to force a path.
 */
export type ConnectKind = "auto" | "injected" | "walletConnect";

/** True when a wallet has injected a provider into this page. */
function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
}

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

  const signIn = useCallback(async (kind: ConnectKind = "auto") => {
    setError(null);
    if (!base) {
      setError("the service address isn't configured yet");
      return;
    }
    if (!isConnected || !signer.address || !signer.walletClient) {
      // Connect the wallet first; the user presses sign in once more to sign.
      // "auto" is what every button uses: an injected provider if the page has
      // one, else WalletConnect (which itself shows a QR on desktop and a deep
      // link on a phone) — so one button covers every device.
      const chosen =
        kind === "walletConnect"
          ? walletConnectConnector
          : kind === "injected"
            ? injectedConnector
            : hasInjectedProvider()
              ? injectedConnector
              : (walletConnectConnector ?? injectedConnector);
      if (chosen) {
        connect({ connector: chosen });
        setError("approve in your wallet, then press sign in");
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
