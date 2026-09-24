/**
 * One core's share of a pattern search. Runs until the page terminates it;
 * reports progress about four times a second and every match as it lands.
 */
import { startWalk, stepWalk } from "./vanity";

interface Start {
  prefix: string;
  suffix: string;
}

self.onmessage = (e: MessageEvent<Start>) => {
  const { prefix, suffix } = e.data;
  let walk = startWalk();
  let tried = 0;
  let lastReport = performance.now();
  for (;;) {
    const r = stepWalk(walk, prefix, suffix);
    tried += r.tried;
    if (r.found) {
      postMessage({ type: "found", ...r.found, tried });
      tried = 0;
      // Never continue from next to a key someone now holds.
      walk = startWalk();
    }
    const now = performance.now();
    if (now - lastReport > 250) {
      postMessage({ type: "progress", tried });
      tried = 0;
      lastReport = now;
    }
  }
};
