/**
 * An address the way the terminal always shows one: truncated in the middle,
 * mono, and copyable with a click — the full value goes to the clipboard and a
 * brief inline COPIED takes the place of a toast.
 *
 * Purely presentational. Wherever an address used to be a link, keep the link;
 * this is for the ones that were plain text you had to select by hand.
 */
import { useEffect, useRef, useState } from "react";

export function truncate(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export default function Addr({
  value,
  head = 6,
  tail = 4,
  className,
}: {
  value: string;
  head?: number;
  tail?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 900);
    } catch {
      // No clipboard permission — the click simply does nothing, which is
      // better than an error for a convenience feature.
    }
  }

  return (
    <button
      type="button"
      className={`addr${className ? ` ${className}` : ""}`}
      onClick={copy}
      title={`${value} — click to copy`}
    >
      {copied ? <span className="addr-copied">COPIED</span> : truncate(value, head, tail)}
    </button>
  );
}
