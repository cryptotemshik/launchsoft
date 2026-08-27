/**
 * Drops that haven't happened yet, and the conversation that collects them.
 *
 * A mint worth sniping is usually announced on Twitter days before it has an
 * OpenSea page, a contract, or anything else this app can look up. Until then
 * the only record of it is a link someone saw — so the bot takes that link,
 * asks the three things that decide whether the drop is worth watching, and
 * keeps them until the drop is real.
 *
 * Everything here is pure. The conversation is a function from state and one
 * message to the next state plus what to say back, so the whole flow can be
 * tested without a network, and the part that talks to Telegram stays a thin
 * shell around it.
 */

export interface UpcomingMint {
  /** Short and stable — it travels in Telegram callback data, capped at 64 bytes. */
  id: string;
  name: string;
  /** Always a full URL by the time it is stored. Empty when only a contract is known. */
  twitter: string;
  /**
   * The collection, once there is one.
   *
   * Optional because the point of this list is drops that exist as a Twitter
   * account and nothing else — but a drop found in the scanner already has a
   * contract, and throwing it away would mean looking it up again later.
   */
  contract?: string;
  /** How many NFTs the drop will have. Undefined when nobody has said yet. */
  supply?: number;
  /** Unix seconds of the expected mint. Undefined means "to be announced". */
  at?: number;
  /** A date given without a time, so the UI can say "1 Sep" rather than "1 Sep 00:00". */
  dayOnly?: boolean;
  addedAt: number;
}

/** Minutes east of UTC that a bare date typed into the bot is read in. */
export const DEFAULT_TZ_OFFSET = 180; // Moscow, which is where the dates come from.

const DAY = 86_400;

/**
 * Turn what someone typed into a moment, or into "not known yet".
 *
 * Accepts what a person actually types on a phone: `1.9`, `01.09.2026`,
 * `2026-09-01`, any of those with `18:00` after it, and the words for today
 * and tomorrow in either language. A bare day-and-month with no year means the
 * next time that date comes round, because nobody announces a drop for last
 * March.
 *
 * @param now unix seconds, so the "next occurrence" rule is testable.
 * @returns null when the text is not a date at all — the caller asks again.
 */
export function parseWhen(
  text: string,
  now: number,
  tzOffsetMin = DEFAULT_TZ_OFFSET,
): { at?: number; dayOnly?: boolean } | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  if (/^(tba|tbd|unknown|нет|незнаю|не знаю|неизвестно|\?)$/.test(s)) return {};

  const offset = tzOffsetMin * 60;
  /** Midnight of the local day `now` falls in, as a unix second. */
  const localMidnight = (t: number) => Math.floor((t + offset) / DAY) * DAY - offset;

  const timeMatch = s.match(/(\d{1,2}):(\d{2})/);
  const timeSecs = timeMatch
    ? Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60
    : undefined;
  if (timeMatch && (Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59)) return null;
  const withTime = (midnight: number) => ({
    at: midnight + (timeSecs ?? 0),
    ...(timeSecs === undefined ? { dayOnly: true } : {}),
  });

  // \b is no use here: JavaScript's word class is ASCII, so it never matches
  // after a Cyrillic letter. An explicit "space or end" does the same job.
  if (/^(today|сегодня)(\s|$)/.test(s)) return withTime(localMidnight(now));
  if (/^(tomorrow|завтра)(\s|$)/.test(s)) return withTime(localMidnight(now) + DAY);

  // 2026-09-01
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const at = utcMidnight(Number(iso[1]), Number(iso[2]), Number(iso[3]), offset);
    return at === null ? null : withTime(at);
  }

  // 1.9, 01.09.2026, 1/9, 1-9
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = dmy[3] ? Number(dmy[3]) : undefined;
    if (year !== undefined && year < 100) year += 2000;
    if (year === undefined) {
      const thisYear = new Date((now + offset) * 1000).getUTCFullYear();
      const candidate = utcMidnight(thisYear, month, day, offset);
      if (candidate === null) return null;
      // A day that has already gone by means next year's one.
      year = candidate + DAY < now ? thisYear + 1 : thisYear;
    }
    const at = utcMidnight(year, month, day, offset);
    return at === null ? null : withTime(at);
  }

  return null;
}

/** Midnight of a local calendar date, as unix seconds; null if the date is not real. */
function utcMidnight(year: number, month: number, day: number, offsetSecs: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Date.UTC rolls 31 April over into May; reject rather than silently move it.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return Math.floor(ms / 1000) - offsetSecs;
}

/**
 * A full Twitter/X URL from whatever was pasted — a link, an @handle, or a
 * bare name. Null when it is plainly not one of those.
 */
export function normaliseTwitter(text: string): string | null {
  const s = text.trim();
  if (!s || /\s/.test(s)) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?(twitter\.com|x\.com)\/(.+)$/i);
  if (url) return `https://x.com/${url[2].replace(/^@/, "")}`;
  const handle = s.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (handle) return `https://x.com/${handle[1]}`;
  return null;
}

/** The handle alone, for showing in a table where a URL would not fit. */
export function twitterHandle(url: string): string {
  const m = url.match(/(?:twitter\.com|x\.com)\/([^/?#]+)/i);
  return m ? `@${m[1]}` : url;
}

/**
 * Soonest first, with the undated at the end.
 *
 * A drop with no date is not "infinitely far away" — it is unknown, which is a
 * different thing and belongs after everything scheduled rather than mixed in
 * among it.
 */
export function sortByDate(list: readonly UpcomingMint[], desc = false): UpcomingMint[] {
  const dir = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    if (a.at === undefined && b.at === undefined) return a.name.localeCompare(b.name);
    if (a.at === undefined) return 1;
    if (b.at === undefined) return -1;
    return dir * (a.at - b.at);
  });
}

/** Eight hex characters: unique enough here, short enough for callback data. */
export function makeId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Build a record from four typed fields, or say what is wrong with them.
 *
 * The bot asks these one at a time and the panel asks them all at once, but
 * the validation has to be the same or the two sources drift — a name the bot
 * accepts and the form rejects is a bug that only shows up on a phone. So both
 * end here.
 */
export function buildUpcoming(
  input: { name: string; twitter?: string; contract?: string; supply?: string; when?: string },
  now: number,
  tzOffsetMin = DEFAULT_TZ_OFFSET,
): { mint: UpcomingMint } | { error: string } {
  const name = input.name.trim();
  if (!name) return { error: "a name is needed" };
  if (name.length > 80) return { error: "that name is too long" };

  const rawTwitter = (input.twitter ?? "").trim();
  const twitter = (rawTwitter ? normaliseTwitter(rawTwitter) : "") ?? "";
  if (rawTwitter && !twitter) return { error: "that doesn't look like a Twitter handle or link" };

  const rawContract = (input.contract ?? "").trim();
  if (rawContract && !/^0x[0-9a-fA-F]{40}$/.test(rawContract)) {
    return { error: "that doesn't look like a contract address" };
  }
  const contract = rawContract ? rawContract.toLowerCase() : undefined;

  // One or the other is enough to find the thing again. Requiring both would
  // rule out the two cases this list exists for: an account with no contract
  // yet, and a contract the scanner found before anyone announced it.
  if (!twitter && !contract) {
    return { error: "a Twitter handle or a contract address is needed" };
  }

  let supply: number | undefined;
  const raw = (input.supply ?? "").trim();
  if (raw && !/^(tba|tbd|unknown|\?)$/i.test(raw)) {
    const n = Number(raw.replace(/[\s,]/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n !== Math.floor(n)) {
      return { error: "supply must be a whole number, or left blank" };
    }
    supply = n;
  }

  // An empty date means the same as the bot's "TBA": not announced, which is
  // a real state and not a missing field.
  const when = parseWhen((input.when ?? "").trim() || "tba", now, tzOffsetMin);
  if (!when) return { error: "that date didn't parse — try 01.09, 1.9 18:00, or leave it blank" };

  return {
    mint: {
      id: makeId(`${twitter || contract}${name}${now}`),
      name,
      twitter,
      contract,
      supply,
      at: when.at,
      dayOnly: when.dayOnly,
      addedAt: now,
    },
  };
}

// ── The conversation ────────────────────────────────────────────────────────

export type Step = "idle" | "name" | "twitter" | "supply" | "date";

export interface Session {
  step: Step;
  draft: Partial<UpcomingMint>;
}

export const IDLE: Session = { step: "idle", draft: {} };

export interface Button {
  label: string;
  data: string;
}

export interface BotReply {
  text: string;
  keyboard?: Button[][];
  /** Save this record — the caller writes it and confirms. */
  save?: UpcomingMint;
  /** Delete this id. */
  remove?: string;
  /** Answer with the current list. */
  list?: boolean;
}

export interface Turn {
  session: Session;
  reply: BotReply;
}

const MENU: Button[][] = [
  [
    { label: "➕ Add a mint", data: "add" },
    { label: "📋 List", data: "list" },
  ],
];

const menuText =
  "<b>Upcoming mints</b>\n\n" +
  "Drops that have a Twitter account and nothing else yet. What you add here " +
  "shows up on the site under <b>Upcoming</b>, sorted by date.";

/**
 * One message in, one reply out.
 *
 * @param input.text what was typed, if anything.
 * @param input.data the callback data of a button that was pressed.
 */
export function step(
  session: Session,
  input: { text?: string; data?: string },
  now: number,
  tzOffsetMin = DEFAULT_TZ_OFFSET,
): Turn {
  const text = (input.text ?? "").trim();
  const data = input.data;

  // Commands and buttons work at any point, so a half-finished draft is never
  // a trap you have to talk your way out of.
  if (data === "cancel" || /^\/cancel$/i.test(text)) {
    return { session: IDLE, reply: { text: "Dropped it.", keyboard: MENU } };
  }
  if (data === "list" || /^\/list$/i.test(text)) {
    return { session: IDLE, reply: { text: "", list: true } };
  }
  if (data?.startsWith("del:")) {
    return { session: IDLE, reply: { text: "", remove: data.slice(4) } };
  }
  if (data === "add" || /^\/add$/i.test(text)) {
    return {
      session: { step: "name", draft: {} },
      reply: {
        text: "<b>New mint · 1 of 4</b>\n\nWhat is it called?",
        keyboard: [[{ label: "✖️ Cancel", data: "cancel" }]],
      },
    };
  }
  if (/^\/(start|menu|help)$/i.test(text) || (session.step === "idle" && !text && !data)) {
    return { session: IDLE, reply: { text: menuText, keyboard: MENU } };
  }

  switch (session.step) {
    case "name": {
      if (!text) return again(session, "Send the name as text.");
      return {
        session: { step: "twitter", draft: { ...session.draft, name: text.slice(0, 80) } },
        reply: {
          text: "<b>2 of 4</b>\n\nTwitter link? A URL, an @handle or just the name all work.",
          keyboard: [[{ label: "✖️ Cancel", data: "cancel" }]],
        },
      };
    }

    case "twitter": {
      const twitter = normaliseTwitter(text);
      if (!twitter) {
        return again(session, "That doesn't look like a Twitter account. Try <code>@name</code> or a link to it.");
      }
      return {
        session: { step: "supply", draft: { ...session.draft, twitter } },
        reply: {
          text: "<b>3 of 4</b>\n\nHow many NFTs will there be?",
          keyboard: [
            [{ label: "🤷 Not known", data: "skip" }],
            [{ label: "✖️ Cancel", data: "cancel" }],
          ],
        },
      };
    }

    case "supply": {
      let supply: number | undefined;
      if (data !== "skip") {
        // "10 000", "10k", "10,000" — all the ways a supply gets written.
        const cleaned = text.replace(/[\s,._]/g, "").replace(/k$/i, "000");
        const n = Number(cleaned);
        if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) {
          return again(session, "Send a number, or press <i>Not known</i>.");
        }
        supply = Math.round(n);
      }
      return {
        session: { step: "date", draft: { ...session.draft, supply } },
        reply: {
          text:
            "<b>4 of 4</b>\n\nWhen? Send a date — <code>1.9</code>, <code>01.09.2026</code> " +
            "or <code>1.9 18:00</code> — or pick one below.",
          keyboard: [
            [
              { label: "Today", data: "when:today" },
              { label: "Tomorrow", data: "when:tomorrow" },
            ],
            [{ label: "📅 Date not announced", data: "when:tba" }],
            [{ label: "✖️ Cancel", data: "cancel" }],
          ],
        },
      };
    }

    case "date": {
      const source = data?.startsWith("when:") ? data.slice(5) : text;
      const when = source === "tba" ? {} : parseWhen(source, now, tzOffsetMin);
      if (when === null) {
        return again(
          session,
          "Didn't follow that date. Try <code>1.9</code>, <code>01.09.2026</code>, " +
            "<code>1.9 18:00</code> — or press <i>Date not announced</i>.",
        );
      }
      const draft = session.draft;
      const record: UpcomingMint = {
        id: makeId(`${draft.twitter}${draft.name}${now}`),
        name: draft.name!,
        twitter: draft.twitter!,
        supply: draft.supply,
        at: when.at,
        dayOnly: when.dayOnly,
        addedAt: now,
      };
      return { session: IDLE, reply: { text: "", save: record } };
    }

    default:
      return { session: IDLE, reply: { text: menuText, keyboard: MENU } };
  }
}

/** Ask the same question again without losing the draft. */
function again(session: Session, text: string): Turn {
  return {
    session,
    reply: { text, keyboard: [[{ label: "✖️ Cancel", data: "cancel" }]] },
  };
}

/** How a stored record reads back in a message. */
export function describe(m: UpcomingMint, tzOffsetMin = DEFAULT_TZ_OFFSET): string {
  const bits = [
    m.supply ? `${m.supply.toLocaleString("en-US")} NFTs` : "supply unknown",
    m.at === undefined ? "date not announced" : formatWhen(m.at, m.dayOnly, tzOffsetMin),
  ];
  return `<b>${escape(m.name)}</b> — ${bits.join(" · ")}\n${escape(m.twitter)}`;
}

/** A date as a person writes it, in the timezone the bot reads dates in. */
export function formatWhen(at: number, dayOnly?: boolean, tzOffsetMin = DEFAULT_TZ_OFFSET): string {
  const d = new Date((at + tzOffsetMin * 60) * 1000);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const stamp = `${day} ${month} ${year}`;
  if (dayOnly) return stamp;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${stamp}, ${hh}:${mm}`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
