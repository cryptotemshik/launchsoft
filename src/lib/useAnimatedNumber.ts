/**
 * A number that ticks through intermediate values instead of jumping.
 *
 * ~400ms per change, driven by requestAnimationFrame, rendered by the caller
 * in a tabular-nums mono face so the width never wobbles. Honors
 * prefers-reduced-motion by jumping straight to the target — a counter is
 * decoration, and decoration is exactly what that setting turns off.
 */
import { useEffect, useRef, useState } from "react";

const DURATION_MS = 400;

export function useAnimatedNumber(target: number | null): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const fromRef = useRef<number | null>(target);
  const frame = useRef<number>();

  useEffect(() => {
    if (target === null) return;
    const from = fromRef.current;
    fromRef.current = target;
    if (
      from === null ||
      from === target ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(target);
      return;
    }
    const started = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - started) / DURATION_MS);
      // The house easing, approximated: fast out, settled landing.
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (target - from) * eased));
      if (p < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current!);
  }, [target]);

  return shown;
}
