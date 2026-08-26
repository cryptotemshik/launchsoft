import { useState } from "react";
import { ArrowRight } from "./icons";

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
          LAUNCH
          <span className="brand-dim">PAD</span>
          <span className="cursor" aria-hidden>
            _
          </span>
        </h1>
        <p className="landing-tag">
          Launch NFT drops on <b>OpenSea</b>. On any EVM chain. In one sitting.
        </p>

        <div className="landing-chips">
          <span className="chip">20 OpenSea chains</span>
          <span className="chip">One-click SeaDrop</span>
          <span className="chip">Live profit</span>
        </div>

        <button className="landing-enter" onClick={enter}>
          ENTER APP <ArrowRight width={16} height={16} />
        </button>

        <p className="landing-foot">Non-custodial · your wallet, your keys · no sign-up</p>
      </div>
    </div>
  );
}
