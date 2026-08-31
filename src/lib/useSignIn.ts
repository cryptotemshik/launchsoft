import { useCallback, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { useSigner } from "../signer";
import { saveRunnerCreds, signInWithWallet, useRunnerApi } from "./runnerClient";

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
 * Returns a `signIn` to call, whether a wallet is connected yet, and any error.
 */
export function useSignIn() {
  const { base } = useRunnerApi();
  const signer = useSigner();
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setError(null);
    if (!base) {
      setError("the service address isn't configured yet");
      return;
    }
    if (!isConnected || !signer.address || !signer.walletClient) {
      // Connect the wallet first; the user presses sign in once more to sign.
      if (connectors[0]) connect({ connector: connectors[0] });
      setError("approve the wallet, then press sign in again");
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
  }, [base, isConnected, signer, connect, connectors]);

  return { signIn, busy, error, walletConnected: isConnected, hasBackend: Boolean(base) };
}
