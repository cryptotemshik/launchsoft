/**
 * The half of the Telegram bot that listens.
 *
 * Until now the bot only spoke: it posted a report when a run finished and
 * never read a thing. Adding a drop needs the other direction, and long
 * polling is the way to get it without exposing a webhook — the box asks
 * Telegram for updates on a connection it opened itself, so nothing new has to
 * be reachable from outside.
 *
 * The conversation itself lives in ../lib/upcoming as a pure function. This
 * file is the shell around it: it fetches updates, hands each message to that
 * function, and performs whatever the reply asks for.
 *
 * Only the configured chat is answered. A bot token is effectively public —
 * anyone who learns the bot's name can message it — so every update from
 * anywhere else is dropped without a reply.
 */
import {
  describe as describeMint,
  formatWhen,
  IDLE,
  sortByDate,
  step,
  DEFAULT_TZ_OFFSET,
  type Button,
  type Session,
} from "../lib/upcoming";
import type { TelegramConfig } from "../lib/telegram";
import { addUpcoming, loadUpcoming, removeUpcoming } from "./upcomingStore";

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number | string } };
  };
}

type Log = (s: string) => void;

async function api(
  cfg: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  } finally {
    clearTimeout(timer);
  }
}

function keyboard(rows?: Button[][]) {
  if (!rows?.length) return undefined;
  return {
    inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))),
  };
}

async function say(cfg: TelegramConfig, text: string, rows?: Button[][]): Promise<void> {
  await api(cfg, "sendMessage", {
    chat_id: cfg.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard(rows) ? { reply_markup: keyboard(rows) } : {}),
  });
}

/** The whole list, each entry with its own delete button. */
async function sendList(cfg: TelegramConfig, configPath: string, tz: number): Promise<void> {
  const list = sortByDate(loadUpcoming(configPath));
  if (list.length === 0) {
    await say(cfg, "Nothing on the list yet.", [[{ label: "➕ Add a mint", data: "add" }]]);
    return;
  }
  // One message per entry, because a delete button has to sit next to the
  // thing it deletes — a single message could only carry one row of buttons
  // for the lot, and you would have to guess which is which.
  await say(cfg, `<b>${list.length} upcoming</b> — soonest first`);
  for (const m of list) {
    await say(cfg, describeMint(m, tz), [[{ label: "🗑 Remove", data: `del:${m.id}` }]]);
  }
}

/**
 * Start listening. Returns a function that stops it.
 *
 * @param tzOffsetMin timezone that a bare date typed into the bot is read in.
 */
export function startTelegramBot(
  cfg: TelegramConfig,
  configPath: string,
  log: Log,
  tzOffsetMin = DEFAULT_TZ_OFFSET,
): () => void {
  let offset = 0;
  let stopped = false;
  let session: Session = IDLE;
  let lastComplaint = 0;

  /**
   * Say why polling is failing, but not on every attempt.
   *
   * Telegram answers 409 for as long as a second process polls the same bot,
   * and that state can last hours. Silence would leave someone wondering why
   * `/add` does nothing; a line every attempt would bury the log.
   */
  function complain(what: string): void {
    const now = Date.now();
    if (now - lastComplaint < 300_000) return;
    lastComplaint = now;
    log(`telegram bot: ${what}`);
  }

  // The menu button in Telegram's UI, so the commands are discoverable without
  // anyone having to remember them.
  void api(cfg, "setMyCommands", {
    commands: [
      { command: "add", description: "Add an upcoming mint" },
      { command: "list", description: "Show upcoming mints" },
      { command: "cancel", description: "Stop what you were adding" },
    ],
  }).catch(() => undefined);

  async function handle(u: TgUpdate): Promise<void> {
    const chat = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
    // Anyone can find a bot and message it; only one chat gets answered.
    if (String(chat ?? "") !== String(cfg.chatId)) return;

    if (u.callback_query) {
      // Telegram spins the button until this is answered.
      void api(cfg, "answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(
        () => undefined,
      );
    }

    const input = { text: u.message?.text, data: u.callback_query?.data };
    if (!input.text && !input.data) return;

    const now = Math.floor(Date.now() / 1000);
    const turn = step(session, input, now, tzOffsetMin);
    session = turn.session;
    const { reply } = turn;

    if (reply.save) {
      addUpcoming(configPath, reply.save);
      const when =
        reply.save.at === undefined
          ? "date not announced"
          : formatWhen(reply.save.at, reply.save.dayOnly, tzOffsetMin);
      log(`upcoming: added ${reply.save.name} (${when})`);
      await say(
        cfg,
        `✅ <b>Saved</b>\n\n${describeMint(reply.save, tzOffsetMin)}\n\nIt is on the site under <b>Upcoming</b>.`,
        [
          [
            { label: "➕ Add another", data: "add" },
            { label: "📋 List", data: "list" },
          ],
        ],
      );
      return;
    }

    if (reply.remove) {
      const { removed } = removeUpcoming(configPath, reply.remove);
      await say(
        cfg,
        removed ? `🗑 Removed <b>${removed.name}</b>.` : "That one is already gone.",
        [
          [
            { label: "➕ Add a mint", data: "add" },
            { label: "📋 List", data: "list" },
          ],
        ],
      );
      return;
    }

    if (reply.list) {
      await sendList(cfg, configPath, tzOffsetMin);
      return;
    }

    if (reply.text) await say(cfg, reply.text, reply.keyboard);
  }

  async function loop(): Promise<void> {
    // Drop whatever piled up while the server was down: acting on a day-old
    // half-conversation would be worse than starting fresh.
    try {
      const first = await api(cfg, "getUpdates", { timeout: 0, offset: -1 }, 20_000);
      const seen = (first.result as TgUpdate[] | undefined) ?? [];
      if (seen.length) offset = seen[seen.length - 1].update_id + 1;
    } catch {
      // Not reachable yet; the loop below keeps trying.
    }

    while (!stopped) {
      try {
        const r = await api(
          cfg,
          "getUpdates",
          { timeout: 50, offset, allowed_updates: ["message", "callback_query"] },
          60_000,
        );
        if (r.ok === false) complain(r.description ?? "getUpdates refused");
        const updates = (r.result as TgUpdate[] | undefined) ?? [];
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          try {
            await handle(u);
          } catch (e) {
            log(`telegram bot: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        // A dropped long-poll is normal — the tunnel flaps, Telegram closes an
        // idle connection. Pause briefly so a hard outage doesn't spin.
        complain(e instanceof Error ? e.message : String(e));
        if (!stopped) await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  void loop();
  log("telegram bot listening for /add and /list");
  return () => {
    stopped = true;
  };
}
