/**
 * Choosing which of the server's wallets an operation touches.
 *
 * Shared, because the question comes up in two places that had drifted apart:
 * which wallets a queued mint fires from, and which wallets an NFT sweep
 * gathers from. They are the same question and deserve the same controls —
 * chips for the obvious groupings, a count you can set exactly, and a draw for
 * spreading over a random handful.
 *
 * Every wallet is either ticked or not. There is no "empty means all": it made
 * "none" impossible to say, and so made picking a handful by hand a chore of
 * unticking ninety.
 */
import { useEffect, useState } from "react";
import { FUNDED_MIN_ETH, isFunded, pickRandom } from "../lib/walletSelection";
import Addr from "./Addr";

export interface PickableWallet {
  address: string;
  label?: string;
  balance: string | null;
  /** Optional right-hand column, e.g. how many NFTs the wallet holds. */
  note?: string;
}

export default function WalletPicker({
  wallets,
  chosen,
  setChosen,
  title = "wallets for this job",
  emptyHint,
}: {
  wallets: PickableWallet[];
  chosen: Set<string>;
  setChosen: (s: Set<string>) => void;
  title?: string;
  emptyHint?: React.ReactNode;
}) {
  const [drawSize, setDrawSize] = useState(10);
  const [typed, setTyped] = useState("10");

  // The slider and the box are two views of one number, so each follows the
  // other. Without this, dragging the slider leaves a stale figure in the box
  // and the next keystroke silently reverts the drag.
  useEffect(() => setTyped(String(drawSize)), [drawSize]);

  if (wallets.length === 0) {
    return emptyHint ? <p className="warn" style={{ marginTop: 14, marginBottom: 0 }}>{emptyHint}</p> : null;
  }

  const labels = [...new Set(wallets.map((w) => w.label).filter((l): l is string => Boolean(l)))];
  const all = chosen.size === wallets.length;
  const fundedWallets = wallets.filter((w) => isFunded(w.balance));

  const pick = (addresses: string[]) => setChosen(new Set(addresses));

  /**
   * Narrow what is already ticked, rather than always drawing from everything.
   *
   * This is what makes the chips compose: press "funded only", then draw, and
   * you get a random handful of the funded ones. Drawing from the whole list
   * regardless would silently undo the filter just applied.
   */
  const pool = chosen.size > 0 ? wallets.filter((w) => chosen.has(w.address)) : wallets;
  const drawMax = Math.max(1, pool.length);
  const draw = () => pick(pickRandom(pool, Math.min(drawSize, drawMax)).map((w) => w.address));

  /** A typed count, clamped to something drawable, or nothing if unreadable. */
  const commitTyped = (raw: string) => {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) {
      setTyped(String(drawSize));
      return;
    }
    setDrawSize(Math.min(n, drawMax));
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="field" style={{ marginBottom: 8 }}>
        <label>
          {title} —{" "}
          {chosen.size === 0 ? (
            <span className="warn">none ticked</span>
          ) : all ? (
            `all ${wallets.length}`
          ) : (
            `${chosen.size} of ${wallets.length}`
          )}
          {fundedWallets.length < wallets.length
            ? ` · ${wallets.length - fundedWallets.length} below ${FUNDED_MIN_ETH} ETH`
            : ""}
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <button
          className={all ? "secondary active-chip" : "secondary"}
          style={{ padding: "3px 12px", fontSize: 11 }}
          onClick={() => pick(wallets.map((w) => w.address))}
        >
          all ({wallets.length})
        </button>
        <button
          className={chosen.size === 0 ? "secondary active-chip" : "secondary"}
          style={{ padding: "3px 12px", fontSize: 11 }}
          title="Clear the lot, then tick the few you want"
          onClick={() => setChosen(new Set())}
        >
          none
        </button>
        <button
          className="secondary"
          style={{ padding: "3px 12px", fontSize: 11 }}
          title={`Wallets holding at least ${FUNDED_MIN_ETH} ETH — enough to pay for gas`}
          onClick={() => pick(fundedWallets.map((w) => w.address))}
        >
          funded only ({fundedWallets.length})
        </button>
        {labels.map((l) => (
          <button
            key={l}
            className="secondary"
            style={{ padding: "3px 12px", fontSize: 11 }}
            onClick={() => pick(wallets.filter((w) => w.label === l).map((w) => w.address))}
          >
            {l} ({wallets.filter((w) => w.label === l).length})
          </button>
        ))}
      </div>

      {/* Taking a handful without ticking them one at a time. The slider is for
          finding a number by feel; the box is for when you already know it and
          the slider would take a dozen nudges to land on 37. */}
      <div
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}
      >
        <button
          className="secondary"
          style={{ padding: "3px 12px", fontSize: 11 }}
          onClick={draw}
          title="Pick this many at random out of what is ticked now"
        >
          draw {Math.min(drawSize, drawMax)} at random
        </button>
        <input
          type="range"
          min={1}
          max={drawMax}
          value={Math.min(drawSize, drawMax)}
          onChange={(e) => setDrawSize(Number(e.target.value))}
          style={{ flex: "1 1 160px", minWidth: 120, accentColor: "var(--green)" }}
          aria-label="how many wallets to draw"
        />
        <input
          type="number"
          min={1}
          max={drawMax}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={(e) => commitTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTyped((e.target as HTMLInputElement).value);
          }}
          style={{ width: 74, padding: "3px 8px", fontSize: 11 }}
          aria-label="how many wallets to draw, typed"
        />
        <span className="dim" style={{ fontSize: 11 }}>
          of {drawMax}
        </span>
      </div>

      <div className="wallet-picker">
        {wallets.map((w) => {
          const on = chosen.has(w.address);
          return (
            <label key={w.address} className={`wallet-pick ${on ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => {
                  const next = new Set(chosen);
                  if (next.has(w.address)) next.delete(w.address);
                  else next.add(w.address);
                  setChosen(next);
                }}
              />
              <span className="mono-break">
                <Addr value={w.address} head={8} />
              </span>
              <span className={isFunded(w.balance) ? "dim" : "warn"}>
                {w.balance === null ? "—" : `${Number(w.balance).toFixed(4)}`}
              </span>
              {w.note ? <span className="ok">{w.note}</span> : w.label ? <span className="dim">{w.label}</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}
