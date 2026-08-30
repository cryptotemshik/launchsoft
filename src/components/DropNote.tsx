/**
 * What a person says about a drop, as opposed to what the chain says.
 *
 * Every other column in these tables is a fact read off a contract. This is
 * the one place for the things that decide whether a drop is worth wallets and
 * that no contract will ever know: which allow-list you got on, what the
 * founder promised in the space, why the supply looks wrong. A colour to find
 * it again at a glance, and a line of text to say why.
 *
 * Shared by the watchlist and the calendar because it is the same annotation
 * on the same entry — both write to the same watchlist row, and a note added
 * in one has to be there in the other.
 */
import { useEffect, useState } from "react";
import { COLOR_LABEL, PICKABLE, type Pickable } from "../lib/calendarColor";
import { MAX_NOTE } from "../lib/upcoming";

/** A swatch that opens the palette. */
export function ColorPicker({
  value,
  onPick,
}: {
  value: Pickable;
  onPick: (c: Pickable) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="swatch-wrap">
      <button
        className={`swatch swatch-${value}`}
        title={`colour: ${COLOR_LABEL[value]}`}
        aria-label={`colour: ${COLOR_LABEL[value]}`}
        onClick={(e) => {
          // These sit inside rows that open a detail panel when clicked.
          e.stopPropagation();
          setOpen(!open);
        }}
      />
      {open ? (
        <span className="swatch-menu">
          {PICKABLE.map((c) => (
            <button
              key={c}
              className={`swatch swatch-${c}${c === value ? " swatch-on" : ""}`}
              title={COLOR_LABEL[c]}
              aria-label={COLOR_LABEL[c]}
              onClick={(e) => {
                e.stopPropagation();
                onPick(c);
                setOpen(false);
              }}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The note itself.
 *
 * Saved on a button rather than on every keystroke: this writes to a file the
 * Telegram bot also reads, and a request per character would be both wasteful
 * and a way to lose half a sentence to a failed write. Escape abandons an
 * edit, Enter commits one — a note is a line, not a document.
 */
export function NoteBox({
  value,
  onSave,
  placeholder = "why this one matters — allow-list, promises, doubts",
}: {
  value?: string;
  onSave: (note: string) => void | Promise<void>;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // A refresh can bring a note written on the phone. Adopting it while
  // somebody is mid-sentence here would delete what they are typing, so it
  // only lands when the box is closed.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  async function commit() {
    setSaving(true);
    try {
      await onSave(draft.trim().slice(0, MAX_NOTE));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        className="note-read"
        title={value ? "Edit this note" : "Add a note"}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        {value ? <span className="note-text">{value}</span> : <span className="dim">+ note</span>}
      </button>
    );
  }

  return (
    <span className="note-edit" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        className="note-input"
        value={draft}
        maxLength={MAX_NOTE}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
      />
      <button className="secondary note-btn" disabled={saving} onClick={() => void commit()}>
        {saving ? "…" : "save"}
      </button>
      <button
        className="secondary note-btn"
        disabled={saving}
        onClick={() => {
          setDraft(value ?? "");
          setEditing(false);
        }}
      >
        cancel
      </button>
    </span>
  );
}
