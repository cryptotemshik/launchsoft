import { useState } from "react";
import { ArrowRight } from "./icons";

/** Decorative floating "NFT cards" — gradient art tiles drifting in the back. */
const CARDS = [
  { left: "8%", top: "18%", size: 128, dur: 15, delay: 0, art: "linear-gradient(135deg,#00c805,#0a6b4a)", rot: -8 },
  { left: "78%", top: "12%", size: 104, dur: 18, delay: 1.5, art: "linear-gradient(135deg,#12d6c8,#0a3f6b)", rot: 10 },
  { left: "62%", top: "62%", size: 150, dur: 21, delay: 0.8, art: "conic-gradient(from 120deg,#00c805,#7b5cff,#00c805)", rot: 6 },
  { left: "16%", top: "66%", size: 96, dur: 17, delay: 2.4, art: "linear-gradient(135deg,#7b5cff,#00c805)", rot: -12 },
  { left: "88%", top: "48%", size: 88, dur: 19, delay: 3.1, art: "linear-gradient(135deg,#00c805,#0a6b4a)", rot: 14 },
  { left: "40%", top: "8%", size: 92, dur: 16, delay: 1.1, art: "radial-gradient(circle at 30% 30%,#2bf06a,#0a3f6b)", rot: -5 },
  { left: "34%", top: "78%", size: 84, dur: 20, delay: 2.9, art: "linear-gradient(135deg,#12d6c8,#00c805)", rot: 9 },
];

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
      <div className="landing-cards" aria-hidden>
        {CARDS.map((c, i) => (
          <div
            key={i}
            className="nft-card"
            style={{
              left: c.left,
              top: c.top,
              width: c.size,
              height: c.size,
              animationDuration: `${c.dur}s`,
              animationDelay: `${c.delay}s`,
              // @ts-expect-error custom props
              "--rot": `${c.rot}deg`,
            }}
          >
            <div className="nft-art" style={{ background: c.art }} />
          </div>
        ))}
      </div>

      <div className="landing-center">
        <div className="landing-mark" aria-hidden>
          <span>◆</span>
        </div>
        <h1 className="landing-title">LaunchPad</h1>
        <p className="landing-tag">
          Launch NFT drops on <b>OpenSea</b>. On any EVM chain. In one sitting.
        </p>

        <div className="landing-chips">
          <span className="chip">20 OpenSea chains</span>
          <span className="chip">One-click SeaDrop</span>
          <span className="chip">Live profit</span>
        </div>

        <button className="enter-btn" onClick={enter}>
          <span className="enter-ring" aria-hidden />
          <span className="enter-label">
            ENTER APP <ArrowRight width={18} height={18} />
          </span>
        </button>

        <p className="landing-note">
          Non-custodial · your wallet, your keys · no sign-up
        </p>
      </div>
    </div>
  );
}
