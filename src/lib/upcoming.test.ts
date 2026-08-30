import { describe, expect, it } from "vitest";
import {
  IDLE,
  MAX_NOTE,
  buildUpcoming,
  cleanNote,
  formatWhen,
  normaliseTwitter,
  parseWhen,
  sortByDate,
  step,
  twitterHandle,
  type Session,
  type UpcomingMint,
} from "./upcoming";

/** 2026-08-26 00:00 UTC — a Wednesday, so "next year" cases are unambiguous. */
const NOW = Math.floor(Date.UTC(2026, 7, 26, 12, 0, 0) / 1000);
const TZ = 180;

const mint = (over: Partial<UpcomingMint> = {}): UpcomingMint => ({
  id: "aaaa1111",
  name: "Test Drop",
  twitter: "https://x.com/testdrop",
  addedAt: NOW,
  ...over,
});

describe("parseWhen", () => {
  it("reads a day and month as the next time that date comes round", () => {
    const r = parseWhen("1.9", NOW, TZ)!;
    expect(formatWhen(r.at!, r.dayOnly, TZ)).toBe("1 Sep 2026");
  });

  it("rolls a date that has already passed into next year", () => {
    // A drop announced on 26 August for "1.3" means next March, not last one.
    const r = parseWhen("1.3", NOW, TZ)!;
    expect(formatWhen(r.at!, r.dayOnly, TZ)).toBe("1 Mar 2027");
  });

  it("keeps a year that was given", () => {
    expect(formatWhen(parseWhen("01.09.2028", NOW, TZ)!.at!, true, TZ)).toBe("1 Sep 2028");
    expect(formatWhen(parseWhen("2026-12-31", NOW, TZ)!.at!, true, TZ)).toBe("31 Dec 2026");
  });

  it("takes a time when one is given, and says so by dropping dayOnly", () => {
    const r = parseWhen("1.9 18:30", NOW, TZ)!;
    expect(r.dayOnly).toBeUndefined();
    expect(formatWhen(r.at!, false, TZ)).toBe("1 Sep 2026, 18:30");
  });

  it("reads a bare date as midnight in the timezone dates are typed in", () => {
    // 1 Sep 00:00 in UTC+3 is 31 Aug 21:00 UTC — the stored value is UTC.
    const r = parseWhen("1.9", NOW, TZ)!;
    expect(new Date(r.at! * 1000).toISOString()).toBe("2026-08-31T21:00:00.000Z");
  });

  it("understands today and tomorrow, in either language", () => {
    expect(formatWhen(parseWhen("today", NOW, TZ)!.at!, true, TZ)).toBe("26 Aug 2026");
    expect(formatWhen(parseWhen("завтра", NOW, TZ)!.at!, true, TZ)).toBe("27 Aug 2026");
  });

  it("treats the ways of saying 'not known' as no date at all", () => {
    for (const s of ["tba", "TBD", "не знаю", "неизвестно", "?"]) {
      expect(parseWhen(s, NOW, TZ)).toEqual({});
    }
  });

  it("refuses a date that does not exist rather than sliding it into next month", () => {
    expect(parseWhen("31.04.2026", NOW, TZ)).toBeNull();
    expect(parseWhen("45.13", NOW, TZ)).toBeNull();
    expect(parseWhen("1.9 25:00", NOW, TZ)).toBeNull();
  });

  it("returns null for text that is not a date, so the bot can ask again", () => {
    expect(parseWhen("soon", NOW, TZ)).toBeNull();
    expect(parseWhen("", NOW, TZ)).toBeNull();
  });
});

describe("normaliseTwitter", () => {
  it("accepts the three ways a link gets sent", () => {
    expect(normaliseTwitter("https://twitter.com/dagestanis")).toBe("https://x.com/dagestanis");
    expect(normaliseTwitter("x.com/dagestanis")).toBe("https://x.com/dagestanis");
    expect(normaliseTwitter("@dagestanis")).toBe("https://x.com/dagestanis");
    expect(normaliseTwitter("dagestanis")).toBe("https://x.com/dagestanis");
  });

  it("keeps the path of a link to a specific tweet", () => {
    expect(normaliseTwitter("https://x.com/a/status/123")).toBe("https://x.com/a/status/123");
  });

  it("rejects what is plainly not an account", () => {
    expect(normaliseTwitter("some drop tomorrow")).toBeNull();
    expect(normaliseTwitter("https://opensea.io/x")).toBeNull();
    expect(normaliseTwitter("")).toBeNull();
  });

  it("reads the handle back out for a narrow column", () => {
    expect(twitterHandle("https://x.com/dagestanis")).toBe("@dagestanis");
  });
});

describe("sortByDate", () => {
  it("puts the soonest first and the undated last", () => {
    const list = [
      mint({ id: "c", name: "no date" }),
      mint({ id: "b", name: "later", at: NOW + 86_400 * 5 }),
      mint({ id: "a", name: "sooner", at: NOW + 86_400 }),
    ];
    expect(sortByDate(list).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the undated at the end when the order is reversed", () => {
    // Unknown is not "far future" — flipping the sort must not float it to the top.
    const list = [
      mint({ id: "c", name: "no date" }),
      mint({ id: "a", at: NOW + 86_400 }),
      mint({ id: "b", at: NOW + 86_400 * 5 }),
    ];
    expect(sortByDate(list, true).map((m) => m.id)).toEqual(["b", "a", "c"]);
  });
});

describe("the add conversation", () => {
  /** Run a whole exchange, returning every reply and the record it saved. */
  function converse(inputs: { text?: string; data?: string }[]) {
    let session: Session = IDLE;
    const replies = [];
    let saved: UpcomingMint | undefined;
    for (const i of inputs) {
      const turn = step(session, i, NOW, TZ);
      session = turn.session;
      replies.push(turn.reply);
      if (turn.reply.save) saved = turn.reply.save;
    }
    return { session, replies, saved };
  }

  it("collects name, twitter, supply and date, then saves", () => {
    const { saved, session } = converse([
      { data: "add" },
      { text: "The Dagestanis" },
      { text: "@dagestanis" },
      { text: "5000" },
      { text: "1.9 18:00" },
    ]);
    expect(saved).toMatchObject({
      name: "The Dagestanis",
      twitter: "https://x.com/dagestanis",
      supply: 5000,
    });
    expect(formatWhen(saved!.at!, saved!.dayOnly, TZ)).toBe("1 Sep 2026, 18:00");
    // Back to the menu, so the next message is not read as an answer.
    expect(session.step).toBe("idle");
  });

  it("saves with no date when the date is not announced", () => {
    const { saved } = converse([
      { data: "add" },
      { text: "Mystery" },
      { text: "@mystery" },
      { data: "skip" },
      { data: "when:tba" },
    ]);
    expect(saved!.at).toBeUndefined();
    expect(saved!.supply).toBeUndefined();
  });

  it("asks again without losing the draft when an answer makes no sense", () => {
    const { saved, replies } = converse([
      { data: "add" },
      { text: "Drop" },
      { text: "this is not a handle" },
      { text: "@drop" },
      { text: "not a number" },
      { text: "1000" },
      { data: "when:tomorrow" },
    ]);
    expect(replies[2].text).toContain("doesn't look like a Twitter account");
    expect(replies[4].text).toContain("Send a number");
    expect(saved).toMatchObject({ name: "Drop", twitter: "https://x.com/drop", supply: 1000 });
  });

  it("reads a supply written the way people write it", () => {
    for (const [typed, expected] of [
      ["10 000", 10000],
      ["10,000", 10000],
      ["5k", 5000],
    ] as const) {
      const { saved } = converse([
        { data: "add" },
        { text: "N" },
        { text: "@n" },
        { text: typed },
        { data: "when:tba" },
      ]);
      expect(saved!.supply).toBe(expected);
    }
  });

  it("lets cancel out of a half-finished draft at any point", () => {
    const { session, replies } = converse([
      { data: "add" },
      { text: "Half typed" },
      { data: "cancel" },
    ]);
    expect(session).toEqual(IDLE);
    expect(replies[2].save).toBeUndefined();
  });

  it("answers /list and a delete button whatever step it is on", () => {
    expect(step({ step: "twitter", draft: { name: "x" } }, { text: "/list" }, NOW).reply.list).toBe(
      true,
    );
    expect(step(IDLE, { data: "del:abc123" }, NOW).reply.remove).toBe("abc123");
  });

  it("shows the menu on /start", () => {
    const r = step(IDLE, { text: "/start" }, NOW).reply;
    expect(r.text).toContain("Upcoming mints");
    expect(r.keyboard?.flat().map((b) => b.data)).toEqual(["add", "list"]);
  });

  it("does not read an idle message as an answer to a question it never asked", () => {
    const r = step(IDLE, { text: "just chatting" }, NOW).reply;
    expect(r.save).toBeUndefined();
    expect(r.text).toContain("Upcoming mints");
  });
});

describe("buildUpcoming", () => {
  const NOW_B = Date.UTC(2026, 7, 27, 12, 0, 0) / 1000;

  it("builds the same record the bot would from the same four answers", () => {
    const r = buildUpcoming(
      { name: "Pipe Dogs", twitter: "@pipedogsnft", supply: "5555", when: "01.09 18:00" },
      NOW_B,
    );
    expect(r).toMatchObject({
      mint: { name: "Pipe Dogs", twitter: "https://x.com/pipedogsnft", supply: 5555 },
    });
    expect("mint" in r && r.mint.at).toBeGreaterThan(NOW_B);
    expect("mint" in r && r.mint.dayOnly).toBeUndefined();
  });

  it("treats a blank date as not announced rather than as an error", () => {
    const r = buildUpcoming({ name: "X", twitter: "someone" }, NOW_B);
    expect("mint" in r && r.mint.at).toBeUndefined();
  });

  it("accepts a supply with separators and rejects a fractional one", () => {
    expect(buildUpcoming({ name: "X", twitter: "a", supply: "10 000" }, NOW_B)).toMatchObject({
      mint: { supply: 10_000 },
    });
    expect(buildUpcoming({ name: "X", twitter: "a", supply: "5.5" }, NOW_B)).toHaveProperty("error");
    expect(buildUpcoming({ name: "X", twitter: "a", supply: "-3" }, NOW_B)).toHaveProperty("error");
  });

  it("leaves supply out when nobody has said", () => {
    expect(buildUpcoming({ name: "X", twitter: "a", supply: "tba" }, NOW_B)).toMatchObject({
      mint: { supply: undefined },
    });
  });

  it("refuses what the bot would also refuse", () => {
    expect(buildUpcoming({ name: "  ", twitter: "a" }, NOW_B)).toHaveProperty("error");
    expect(buildUpcoming({ name: "X", twitter: "not a handle!!" }, NOW_B)).toHaveProperty("error");
    expect(buildUpcoming({ name: "X", twitter: "a", when: "the 45th" }, NOW_B)).toHaveProperty(
      "error",
    );
  });

  it("gives two drops added in the same second different ids", () => {
    const a = buildUpcoming({ name: "One", twitter: "a" }, NOW_B);
    const b = buildUpcoming({ name: "Two", twitter: "b" }, NOW_B);
    expect("mint" in a && "mint" in b && a.mint.id !== b.mint.id).toBe(true);
  });
});

describe("buildUpcoming with a contract", () => {
  const NOW_C = Date.UTC(2026, 7, 27, 12, 0, 0) / 1000;
  const ADDR = "0xcF541A3DB9328322e8FDAa6381242061D03875B8";

  it("takes a contract alongside a handle", () => {
    const r = buildUpcoming({ name: "Pipe Dogs", twitter: "@pipedogsnft", contract: ADDR }, NOW_C);
    expect(r).toMatchObject({ mint: { contract: ADDR.toLowerCase() } });
  });

  it("accepts a drop that has a contract and no account yet", () => {
    // The scanner's case: found on-chain before anyone announced it.
    expect(buildUpcoming({ name: "Unannounced", contract: ADDR }, NOW_C)).toMatchObject({
      mint: { contract: ADDR.toLowerCase(), twitter: "" },
    });
  });

  it("still accepts a drop that has an account and no contract yet", () => {
    // The bot's case, and the reason this list exists.
    expect(buildUpcoming({ name: "Rumour", twitter: "someone" }, NOW_C)).toMatchObject({
      mint: { twitter: "https://x.com/someone", contract: undefined },
    });
  });

  it("refuses a drop with neither", () => {
    expect(buildUpcoming({ name: "Nothing" }, NOW_C)).toHaveProperty("error");
  });

  it("refuses something that is not an address", () => {
    expect(buildUpcoming({ name: "X", contract: "0xnope" }, NOW_C)).toHaveProperty("error");
    expect(buildUpcoming({ name: "X", contract: ADDR.slice(0, -1) }, NOW_C)).toHaveProperty("error");
  });

  it("stores the address in one case, so two spellings are one drop", () => {
    const a = buildUpcoming({ name: "X", contract: ADDR }, NOW_C);
    const b = buildUpcoming({ name: "X", contract: ADDR.toLowerCase() }, NOW_C);
    expect("mint" in a && "mint" in b && a.mint.contract === b.mint.contract).toBe(true);
  });
});

describe("a note on a watched drop", () => {
  it("keeps what someone typed", () => {
    expect(cleanNote("  allow-listed, 2 wallets  ")).toBe("allow-listed, 2 wallets");
  });

  it("treats an empty note as no note", () => {
    expect(cleanNote("")).toBeUndefined();
    expect(cleanNote("   ")).toBeUndefined();
  });

  it("ignores anything that is not text", () => {
    expect(cleanNote(undefined)).toBeUndefined();
    expect(cleanNote(42)).toBeUndefined();
    expect(cleanNote({ note: "hi" })).toBeUndefined();
  });

  it("flattens newlines and control characters into spaces", () => {
    // It is one field on a card; a note with its own paragraphs would break
    // every row it appears in.
    expect(cleanNote("first\nsecond")).toBe("first second");
    expect(cleanNote("tab\there")).toBe("tab here");
  });

  it("caps a note that would fill a disk", () => {
    expect(cleanNote("x".repeat(MAX_NOTE + 500))).toHaveLength(MAX_NOTE);
  });
});
