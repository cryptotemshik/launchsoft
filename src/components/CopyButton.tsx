/**
 * Copy something without leaving the row.
 *
 * Shared rather than repeated because it appears beside every contract in the
 * app now, and three copies of a clipboard call is three places for the
 * "copied" state to behave differently.
 */
import { useEffect, useRef, useState } from "react";

export default function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      className="copy-btn"
      title={done ? "copied" : `Copy ${value}`}
      onClick={async (e) => {
        // Rows here are often clickable themselves; copying is not opening.
        e.stopPropagation();
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1200);
        } catch {
          // Clipboard blocked — the value is still on screen to select.
        }
      }}
    >
      {done ? "✓" : label}
    </button>
  );
}
