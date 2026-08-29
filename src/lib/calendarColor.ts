/**
 * What colour a calendar block gets.
 *
 * Two things want to say something with colour and they must not fight. The
 * calendar knows a fact about every drop — free or paid — that decides at a
 * glance whether a row is worth the wallets, and a person knows things the
 * chain never will: which drop actually matters this week. So the fact is the
 * default and the person overrides it, one row at a time.
 *
 * The stored value is a palette key, never a CSS colour. A raw colour written
 * into a shared list would follow the app into its next theme and be wrong
 * there, and it would let anything that can write the watchlist put arbitrary
 * text into a style attribute.
 */

/** Colours a person can pick. `auto` means "decide from the price". */
export const PICKABLE = ["auto", "green", "amber", "cyan", "violet", "red", "grey"] as const;
export type Pickable = (typeof PICKABLE)[number];

/** What a row is finally painted with, including the two derived from price. */
export type ColorKey = Exclude<Pickable, "auto"> | "free" | "paid" | "unknown";

export function isPickable(v: unknown): v is Pickable {
  return typeof v === "string" && (PICKABLE as readonly string[]).includes(v);
}

/**
 * Free, paid, or not yet knowable.
 *
 * A missing price is not a free mint: it is a drop whose stage nobody has
 * configured yet, and painting it like a free one would promise something the
 * chain has not said.
 */
export function priceClass(priceWei: string | undefined | null): "free" | "paid" | "unknown" {
  if (priceWei === undefined || priceWei === null || priceWei === "") return "unknown";
  try {
    return BigInt(priceWei) === 0n ? "free" : "paid";
  } catch {
    return "unknown";
  }
}

/** The palette key for one event: what was picked, else what the price says. */
export function resolveColor(e: {
  priceWei?: string | null;
  color?: string | null;
}): ColorKey {
  if (isPickable(e.color) && e.color !== "auto") return e.color;
  return priceClass(e.priceWei);
}

/** The class the row and the week block both carry. */
export function colorClass(e: { priceWei?: string | null; color?: string | null }): string {
  return `cal-c-${resolveColor(e)}`;
}

/** How the swatch is labelled in the picker and the drawer. */
export const COLOR_LABEL: Record<Pickable, string> = {
  auto: "auto",
  green: "green",
  amber: "amber",
  cyan: "cyan",
  violet: "violet",
  red: "red",
  grey: "grey",
};
