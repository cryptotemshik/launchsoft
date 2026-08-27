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
import { useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";

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
      setState("added");
      onAdded?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState("error");
      setWhy(/404/.test(msg) ? "server is too old — update it" : msg);
    }
  }

  return (
    <button
      className={state === "added" ? "secondary active-chip" : "secondary"}
      style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
      disabled={state === "adding" || state === "added" || !base || !token}
      title={why ?? "Add to the watchlist and open it"}
      onClick={(e) => {
        e.stopPropagation();
        void add();
      }}
    >
      {state === "adding" ? (
        <span className="spin">…</span>
      ) : state === "added" ? (
        "watching"
      ) : state === "error" ? (
        "failed"
      ) : (
        "watch"
      )}
    </button>
  );
}
