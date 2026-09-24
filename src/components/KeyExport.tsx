/**
 * Download every wallet's private key as an Excel sheet: address in column A,
 * key in column B.
 *
 * The server hands keys back only against a fresh signature from the wallet
 * that owns the account (see src/cli/keyExport.ts): the session alone is not
 * enough, so a stolen login cannot empty the wallets this way. The message is
 * written by the server and shown in the wallet as-is.
 */
import { useState } from "react";
import { useSignMessage } from "wagmi";
import { useSigner } from "../signer";
import { XLSX_TYPE, downloadBytes, stampedName, walletsXlsx } from "../lib/xlsx";

type Call = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

export default function KeyExport({ call, walletCount }: { call: Call; walletCount: number }) {
  const signer = useSigner();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState<null | "sign" | "fetch">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function exportAll() {
    setError(null);
    setDone(null);
    if (!signer.isConnected || !signer.address) {
      setError("Connect the wallet you sign in with — the export has to be approved by its signature.");
      return;
    }
    try {
      setBusy("sign");
      const ch = (await call("/api/wallets/export-challenge", { method: "POST", body: "{}" })) as {
        nonce: string;
        message: string;
        signer: string;
      };
      if (ch.signer && ch.signer.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(`Approve with ${ch.signer} — switch to that wallet and try again.`);
      }
      const signature = await signMessageAsync({
        account: signer.txAccount ?? signer.address,
        message: ch.message,
      });
      setBusy("fetch");
      const r = (await call("/api/wallets/export", {
        method: "POST",
        body: JSON.stringify({ nonce: ch.nonce, signature }),
      })) as { wallets: { address: string; key: string }[] };
      downloadBytes(walletsXlsx(r.wallets), stampedName("orvex-all-wallets"), XLSX_TYPE);
      setDone(`Downloaded ${r.wallets.length} wallet(s). Keep the file offline — it is every key you have.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /404/.test(msg)
          ? "The server is too old for this — update it (git pull, restart)."
          : /reject|denied|cancel/i.test(msg)
            ? "Cancelled in the wallet — nothing was exported."
            : msg,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>Back up keys</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Every wallet on the server — generated here, pasted in, all of them — as
        an Excel file: address in the left column, private key in the right.
        Your wallet asks you to sign an approval first; the server sends the keys
        only against that signature and pings Telegram when it does.
      </p>
      <button className="primary" disabled={busy !== null || walletCount === 0} onClick={() => void exportAll()}>
        {busy === "sign" ? (
          <span className="spin">APPROVE IN WALLET</span>
        ) : busy === "fetch" ? (
          <span className="spin">DOWNLOADING</span>
        ) : (
          `EXPORT ALL ${walletCount} WALLETS (.xlsx)`
        )}
      </button>
      {error ? <p className="error">{error}</p> : null}
      {done ? <p className="ok">{done}</p> : null}
      <p className="hint dim" style={{ marginBottom: 0 }}>
        Anyone with this file controls every wallet in it. Don&apos;t send it in a
        chat, don&apos;t leave it in Downloads — move it somewhere offline.
      </p>
    </div>
  );
}
