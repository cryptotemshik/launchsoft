/**
 * Mark a collection for the snipe tab without leaving the row.
 *
 * This used to switch tabs the moment it was pressed, which made marking more
 * than one drop a walk back and forth: press, get thrown into the snipe tab,
 * navigate back, find your place in the list, press the next one. So it parks
 * the collection and stays put, and says so — the confirmation is the whole
 * point, because nothing else on screen moves any more.
 */
import { useState } from "react";
import { setPendingTarget } from "../lib/snipeTarget";

export default function SnipeButton({ contract }: { contract: string }) {
  const [parked, setParked] = useState(false);

  return (
    <button
      className={parked ? "secondary active-chip" : "secondary"}
      style={{ padding: "2px 10px", fontSize: 11, width: "auto" }}
      title={
        parked
          ? "Waiting in the Snipe tab — mark as many as you like, they queue up"
          : "Send this collection to the Snipe tab. The tab does not change; it will be waiting there."
      }
      onClick={(e) => {
        e.stopPropagation();
        setPendingTarget(contract);
        setParked(true);
      }}
    >
      {parked ? "sent ✓" : "snipe"}
    </button>
  );
}
