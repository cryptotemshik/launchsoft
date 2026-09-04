import { useRef, useState, type ReactNode } from "react";
import WalletCard from "./WalletCard";

/**
 * An address that shows a wallet card when you hover or tap it — balance, NFTs
 * and NFT PnL, without leaving the page. The card only mounts (and only then
 * fetches) once opened, so a list of a hundred of these costs nothing until one
 * is looked at.
 */
export default function PeekAddr({
  address,
  children,
}: {
  address: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  const openSoon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 300);
  };
  const closeSoon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 200);
  };

  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={openSoon}
      onMouseLeave={closeSoon}
    >
      <span
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen((o) => !o)}
        style={{
          cursor: "pointer",
          textDecoration: "underline",
          textDecorationStyle: "dotted",
          textUnderlineOffset: 2,
        }}
        title="hover for balance & PnL"
      >
        {children ?? short}
      </span>
      {open ? (
        <span
          onMouseEnter={openSoon}
          onMouseLeave={closeSoon}
          style={{
            position: "absolute",
            zIndex: 60,
            top: "calc(100% + 4px)",
            left: 0,
            display: "block",
            minWidth: 300,
            maxWidth: 440,
            padding: 12,
            borderRadius: 8,
            background: "var(--panel-bg, #14171c)",
            border: "1px solid var(--border, #2b2f37)",
            boxShadow: "0 10px 30px rgba(0,0,0,.45)",
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          <WalletCard address={address} compact />
        </span>
      ) : null}
    </span>
  );
}
