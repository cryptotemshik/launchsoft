/**
 * The collections behind a reuse badge.
 *
 * A `title` attribute would have been enough to *show* the list and useless
 * for what it is for: the whole point is clicking through to the sibling that
 * looks familiar. So this is a real panel.
 *
 * It is positioned `fixed` from coordinates captured when the badge is
 * hovered, rather than absolutely inside the row. The table scrolls sideways
 * inside its own container, and an absolutely-positioned panel would be
 * clipped by exactly the overflow that makes the table usable.
 *
 * Closing is on a short delay so the pointer can cross the gap between the
 * badge and the panel without the panel vanishing under it — the same reason
 * the nav's dropdown bridges its own gap.
 */
import { useEffect, useRef, useState } from "react";
import type { IndexedCollection } from "../lib/creatorIndex";

export interface RelatedAnchor {
  x: number;
  y: number;
  title: string;
  items: IndexedCollection[];
}

/** Where a badge is on screen, for the panel to hang off. */
export function anchorFrom(e: { currentTarget: Element }, title: string, items: IndexedCollection[]): RelatedAnchor {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom + 6, title, items };
}

export function useRelated() {
  const [anchor, setAnchor] = useState<RelatedAnchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const open = (a: RelatedAnchor) => {
    clearTimeout(timer.current);
    setAnchor(a);
  };
  const close = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnchor(null), 220);
  };
  const hold = () => clearTimeout(timer.current);

  // A panel pinned to viewport coordinates is wrong the moment anything
  // scrolls, and a stale panel over the wrong row is worse than none.
  useEffect(() => {
    if (!anchor) return;
    const drop = () => setAnchor(null);
    window.addEventListener("scroll", drop, true);
    window.addEventListener("resize", drop);
    return () => {
      window.removeEventListener("scroll", drop, true);
      window.removeEventListener("resize", drop);
    };
  }, [anchor]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { anchor, open, close, hold };
}

export default function RelatedPopover({
  anchor,
  onHold,
  onLeave,
  href,
}: {
  anchor: RelatedAnchor | null;
  onHold: () => void;
  onLeave: () => void;
  /** Where a listed collection should link to. */
  href: (contract: string) => string;
}) {
  if (!anchor) return null;
  const WIDTH = 300;
  // Kept inside the viewport: a badge near the right edge would otherwise
  // hang its panel off the page.
  const left = Math.min(Math.max(8, anchor.x - WIDTH / 2), window.innerWidth - WIDTH - 8);
  return (
    <div
      className="related-pop"
      style={{ left, top: anchor.y, width: WIDTH }}
      onMouseEnter={onHold}
      onMouseLeave={onLeave}
    >
      <div className="rp-title">{anchor.title}</div>
      {anchor.items.length === 0 ? (
        <div className="rp-empty dim">nothing else seen yet</div>
      ) : (
        <ul className="rp-list">
          {anchor.items.map((c) => (
            <li key={c.contract}>
              <a href={href(c.contract)} target="_blank" rel="noreferrer">
                <span className="rp-name">{c.name ?? `${c.contract.slice(0, 12)}…`}</span>
                <span className="rp-when dim">
                  {c.startTime
                    ? new Date(c.startTime * 1000).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    : "—"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The badge itself: a count, and nothing at all below two.
 *
 * One collection is not a finding — everyone's first drop is their first —
 * and a badge that appears on every row is a badge nobody reads.
 */
export function ReuseBadge({
  count,
  band,
  onEnter,
  onLeave,
}: {
  count: number;
  band: "warn" | "bad";
  onEnter: (e: { currentTarget: Element }) => void;
  onLeave: () => void;
}) {
  return (
    <span
      className={`reuse-badge reuse-${band}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation();
        onEnter(e);
      }}
      title={`${count} collections share this — hover to see them`}
    >
      ×{count}
    </span>
  );
}
