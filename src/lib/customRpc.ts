/**
 * The endpoints the user has chosen to work through, shared by every tab.
 *
 * These started life as a box in the snipe tab, which made them feel like a
 * snipe-only setting — so a launch, a reveal or a status read still went
 * through the chain's public RPC even when someone had pasted a paid endpoint
 * one tab over. There is only ever one answer to "which node do I use", so
 * there is one place to store it, and any tab may edit it.
 *
 * Kept in localStorage rather than in React state alone: retyping a keyed
 * provider URL on every visit is how it ends up not being used at all.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

const KEY = "launchpad.rpcs";
/** Where the snipe tab kept them before this was shared. */
const LEGACY_KEY = "launchpad.snipe.rpcs";
/** Fired on write so other mounted tabs pick the change up immediately. */
const EVENT = "launchpad:rpcs";

export function loadCustomRpcText(): string {
  try {
    const now = localStorage.getItem(KEY);
    if (now !== null) return now;
    // One-time migration, so anyone who already pasted an endpoint keeps it.
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) {
      localStorage.setItem(KEY, old);
      localStorage.removeItem(LEGACY_KEY);
      return old;
    }
  } catch {
    // Private mode or storage disabled — fall through to the empty default.
  }
  return "";
}

/** One URL per line, blanks dropped. Order is meaningful: best first. */
export function parseCustomRpcs(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function useCustomRpcs() {
  const [text, setTextState] = useState(loadCustomRpcText);

  const setText = useCallback((next: string) => {
    setTextState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not being able to remember it is survivable; using it is not.
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }, []);

  useEffect(() => {
    // Two tabs of the app can be open at once, and both render an RPC box.
    const onLocal = (e: Event) => setTextState((e as CustomEvent<string>).detail);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setTextState(e.newValue ?? "");
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Memoised: callers build viem clients keyed on this, and a fresh array
  // every render would rebuild the client every render.
  const urls = useMemo(() => parseCustomRpcs(text), [text]);

  return { text, setText, urls };
}
