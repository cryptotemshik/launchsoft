/**
 * Fund the wallets a queued mint will fire from, from one place.
 *
 * The alternative was arithmetic on a napkin: read the price off the queue,
 * multiply by the quantity, remember the gas limit, look up what each wallet
 * still holds from the last drop, subtract, and type the result into the
 * funding tab — for every drop, minutes before it opens. What that produced
 * was wallets funded a shade too little, which arm, wait, and revert for gas at
 * the one moment nobody is watching.
 *
 * So this reads the job's own numbers, shows the shortfall wallet by wallet,
 * and tops each one up to exactly what it needs. A wallet already there is
 * left alone; a wallet holding half gets the other half.
 */
import { useMemo, useState } from "react";
import { formatEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import { planFunding, weiToEthString, type JobCost } from "../lib/fundingPlan";
import Addr from "./Addr";

interface Wallet {
  address: string;
  label?: string;
  balance: string | null;
}

/** A balance string from /api/wallets, as wei. Null keeps "not read" distinct. */
function toWei(balance: string | null): bigint | null {
  if (balance == null) return null;
  const n = balance.trim();
  if (!/^\d+(\.\d+)?$/.test(n)) return null;
  const [whole, frac = ""] = n.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

const eth = (wei: bigint) => {
  const s = formatEther(wei);
  const n = Number(s);
  // Enough places to see a gas-sized number, without a wall of zeroes.
  return n === 0 ? "0" : n < 0.0001 ? s : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
};

export default function FundJobPanel({
  jobLabel,
  cost,
  wallets,
  onClose,
  onFunded,
}: {
  jobLabel: string;
  cost: JobCost;
  /** The wallets this job fires from — already narrowed by the caller. */
  wallets: Wallet[];
  onClose: () => void;
  onFunded: () => void;
}) {
  const { call } = useRunnerApi();
  const [fromKey, setFromKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const plan = useMemo(
    () => planFunding(wallets.map((w) => ({ address: w.address, balanceWei: toWei(w.balance) })), cost),
    [wallets, cost],
  );

  async function send(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = (await call("/api/disperse", {
        method: "POST",
        body: JSON.stringify({
          fromKey: fromKey.trim(),
          // Top up to the level rather than sending a flat amount: the wallets
          // carry different leftovers and a flat send gets every one of them
          // wrong in one direction or the other.
          topUpToEth: weiToEthString(plan.perWalletWei),
          targets: wallets.map((w) => w.address),
          dryRun,
        }),
      })) as unknown as {
        funded?: number;
        skipped?: number;
        requiredWei?: string;
        logs?: string[];
      };
      setLog(r.logs ?? []);
      setResult(
        dryRun
          ? `Dry run: would fund ${plan.needy} wallet(s), ${eth(plan.totalWei)} ETH plus transfer fees. Nothing was sent.`
          : `Funded ${r.funded ?? 0} wallet(s)${r.skipped ? `, ${r.skipped} already had enough` : ""}.`,
      );
      if (!dryRun) onFunded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const nothingToDo = plan.needy === 0;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <h3>Fund · {jobLabel}</h3>
            <span className="pill">{wallets.length} wallet(s)</span>{" "}
            {nothingToDo ? (
              <span className="pill ok">ALL READY</span>
            ) : (
              <span className="pill warn">{plan.needy} SHORT</span>
            )}
          </div>
          <button className="secondary" onClick={onClose}>
            close
          </button>
        </div>

        <dl className="kv">
          <dt>each wallet needs</dt>
          <dd>
            <b>{eth(plan.perWalletWei)} ETH</b>
            <span className="dim">
              {" "}
              = {eth(plan.mintWei)} mint + {eth(plan.gasWei)} gas
              {(cost.shots ?? 1) > 1 ? ` (${cost.shots} shots per wallet)` : ""}
            </span>
          </dd>
          <dt>still to send</dt>
          <dd>
            {nothingToDo ? (
              <span className="ok">nothing — every wallet is already there</span>
            ) : (
              <>
                <b>{eth(plan.totalWei)} ETH</b>{" "}
                <span className="dim">across {plan.needy} wallet(s), plus transfer fees</span>
              </>
            )}
          </dd>
        </dl>

        <div className="wallet-picker" style={{ marginTop: 12 }}>
          {plan.rows.map((r) => (
            <div key={r.address} className={`wallet-pick ${r.shortfallWei > 0n ? "" : "on"}`}>
              <span className="mono-break">
                <Addr value={r.address} head={8} />
              </span>
              <span className="dim">{r.balanceWei === null ? "—" : eth(r.balanceWei)}</span>
              <span className={r.shortfallWei > 0n ? "warn" : "ok"}>
                {r.shortfallWei > 0n ? `+${eth(r.shortfallWei)}` : "ready"}
              </span>
            </div>
          ))}
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label>
            paying wallet's private key — used for this transfer and never
            stored on the server
          </label>
          <input
            type="password"
            value={fromKey}
            onChange={(e) => setFromKey(e.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button
            className="secondary"
            disabled={busy || !fromKey.trim() || nothingToDo}
            onClick={() => void send(true)}
          >
            {busy ? <span className="spin">…</span> : "dry run"}
          </button>
          <button
            className="primary"
            disabled={busy || !fromKey.trim() || nothingToDo}
            onClick={() => void send(false)}
          >
            {busy ? <span className="spin">sending…</span> : `fund ${plan.needy} wallet(s)`}
          </button>
        </div>

        {error ? <p className="error">{error}</p> : null}
        {result ? <p className={result.startsWith("Dry") ? "dim" : "ok"}>{result}</p> : null}
        {log.length > 0 ? (
          <pre className="log" style={{ marginTop: 10 }}>
            {log.join("\n")}
          </pre>
        ) : null}

        <p className="dim hint">
          The transfer goes out through the server's own endpoint, the same one
          the mint uses — not the chain's public RPC.
        </p>
      </aside>
    </>
  );
}
