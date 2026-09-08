import { useState } from "react";
import { ArrowRight, OrvexMark } from "./icons";

/**
 * The cover — styled as a boot screen, because that is what it is.
 *
 * Nothing decorative floats here any more: a faint grid, the wordmark with its
 * caret, three facts and the prompt. Everything a person can do on this page
 * is press enter.
 */
export default function Landing({ onEnter }: { onEnter: () => void }) {
  const [leaving, setLeaving] = useState(false);

  function enter() {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onEnter, 620);
  }

  return (
    <div className={`landing ${leaving ? "leaving" : ""}`}>
      <div className="landing-grid" aria-hidden />

      <div className="landing-center">
        <h1 className="landing-title">
          <OrvexMark className="brand-mark" width={40} height={40} aria-hidden />
          ORVEX
          <span className="cursor" aria-hidden>
            _
          </span>
        </h1>
        <p className="landing-tag">
          Snipe and launch NFT drops on <b>Robinhood Chain</b>. Before anyone else.
        </p>

        <div className="landing-chips">
          <span className="chip">Scanner + whale signal</span>
          <span className="chip">One-click snipe</span>
          <span className="chip">Live PnL</span>
        </div>

        <button className="landing-enter" onClick={enter}>
          ENTER APP <ArrowRight width={16} height={16} />
        </button>

        <p className="landing-foot">Non-custodial · your wallet, your keys · no sign-up</p>
      </div>
    </div>
  );
}
