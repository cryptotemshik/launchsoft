/**
 * How big and how old the account behind a drop is.
 *
 * A handle on its own says almost nothing — anyone can connect one — and the
 * two numbers that make it mean something are the follower count and the day
 * the account was opened. Measured on this chain they separate the field
 * sharply: of the collections sampled with an account attached, one had 136
 * followers on an account two weeks old and another had 17 on an account eight
 * days old. That is the whole point of the column.
 *
 * X's own API is $200 a month for this. The public mirrors that render tweets
 * for chat apps answer the same question for free, in about a fifth of a
 * second and a kilobyte, so this reads those. Two of them, with different
 * field names, because one being down should cost a refresh rather than the
 * feature.
 */

export interface TwitterStats {
  followers: number;
  /** Posts, when the mirror reports them. */
  tweets: number | null;
  /** When the account was opened, unix ms. */
  joinedMs: number | null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/**
 * Read whichever mirror answered.
 *
 * Returns null for anything that isn't recognisably an account: a mirror that
 * is down serves an HTML error page with a 200, and a zero follower count is
 * a very different claim from "we could not ask".
 */
export function parseTwitterStats(raw: unknown): TwitterStats | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // fxtwitter nests the account under `user`; vxtwitter returns it flat.
  const u = (o.user && typeof o.user === "object" ? o.user : o) as Record<string, unknown>;

  const followers = int(u.followers) ?? int(u.followers_count);
  if (followers === null) return null;
  // A record with a follower count but no name is a shape we don't know.
  if (typeof u.screen_name !== "string" || !u.screen_name) return null;

  const joined = u.joined ?? u.created_at;
  const at = typeof joined === "string" ? Date.parse(joined) : NaN;

  return {
    followers,
    tweets: int(u.tweets) ?? int(u.tweet_count),
    joinedMs: Number.isFinite(at) ? at : null,
  };
}

/** "2w", "8d", "3y" — the age at a glance, which is all it is read for. */
export function accountAge(joinedMs: number, now: number): string {
  const days = Math.max(0, Math.floor((now - joinedMs) / 86_400_000));
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** 136 · 2.4k · 241M — narrow enough for a table cell. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
