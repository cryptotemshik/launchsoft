/**
 * One core's share of a Solana address search. Runs until the page ends it;
 * reports progress about four times a second and every match as it lands.
 */
import { freshKeys, matches, walletFromSeed } from "./solVanity";

interface Start {
  prefix: string;
  suffix: string;
  ignoreCase: boolean;
}

self.onmessage = async (e: MessageEvent<Start>) => {
  const { prefix, suffix, ignoreCase } = e.data;
  let tried = 0;
  let lastReport = performance.now();
  for (;;) {
    const batch = await freshKeys(128);
    for (const k of batch) {
      tried += 1;
      const w = walletFromSeed(k.seed, k.pub);
      if (matches(w.address, prefix, suffix, ignoreCase)) {
        postMessage({ type: "found", ...w, tried });
        tried = 0;
      }
    }
    const now = performance.now();
    if (now - lastReport > 250) {
      postMessage({ type: "progress", tried });
      tried = 0;
      lastReport = now;
    }
  }
};
