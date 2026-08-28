/**
 * Put a collection on the watchlist without leaving the row.
 *
 * The scanner and the live feed both find things worth coming back to, and
 * the watchlist is where coming back happens — but everything it needs is
 * already on the row: the name, the contract, the supply, the start, and the
 * handle if the marketplace lookup found one. Retyping any of that into a form
 * is how a drop gets forgotten instead.
 *
 * The button reports its own outcome rather than throwing the row's state
 * away: added, already there, or the reason it could not be.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import {
  ensureWatchedLoaded,
  isWatched,
  markWatched,
  subscribeWatched,
  watchedVersion,
} from "../lib/watchedStore";

export interface WatchDraft {
  name: string;
  contract: string;
  twitter?: string | null;
  supply?: number;
  /** Unix seconds of the stage start, when the chain has one. */
  startTime?: number;
}

type State = "idle" | "adding" | "added" | "error";

/** The date format `buildUpcoming` reads, in the timezone the bot assumes. */
function whenField(startTime: number | undefined): string | undefined {
  if (!startTime) return undefined;
  const d = new Date(startTime * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function WatchButton({
  draft,
  onAdded,
}: {
  draft: WatchDraft;
  /** Called once the server has it, so the tab can move. */
  onAdded?: () => void;
}) {
  const { base, token, call } = useRunnerApi();
  const [state, setState] = useState<State>("idle");
  const [why, setWhy] = useState<string | null>(null);

  // What is already on the list, so this button can be dead before it is
  // pressed rather than reporting the duplicate afterwards.
  useSyncExternalStore(subscribeWatched, watchedVersion, watchedVersion);
  useEffect(() => {
    if (base && token) void ensureWatchedLoaded(call);
  }, [base, token, call]);
  const already = isWatched(draft.contract, draft.twitter);

  async function add() {
    setState("adding");
    setWhy(null);
    try {
      await call("/api/upcoming", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          contract: draft.contract,
          twitter: draft.twitter ?? "",
          supply: draft.supply === undefined ? undefined : String(draft.supply),
          when: whenField(draft.startTime),
        }),
      });
      markWatched(draft.contract, draft.twitter);
      setState("added");
      onAdded?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState("error");
      setWhy(/404/.test(msg) ? "server is too old — update it" : msg);
    }
  }

  const done = state === "added" || already;

  return (
    <button
      className={done ? "secondary active-chip" : "secondary"}
      style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
      disabled={state === "adding" || done || !base || !token}
      title={
        why ??
        (done
          ? "Already on your watchlist — remove it there if you want it gone"
          : "Add to the watchlist. The tab does not change.")
      }
      onClick={(e) => {
        e.stopPropagation();
        void add();
      }}
    >
      {state === "adding" ? (
        <span className="spin">…</span>
      ) : done ? (
        "watching"
      ) : state === "error" ? (
        "failed"
      ) : (
        "watch"
      )}
    </button>
  );
}
