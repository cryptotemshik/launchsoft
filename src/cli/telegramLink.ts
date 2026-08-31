/**
 * Linking an account to a Telegram chat, so alerts can reach it privately.
 *
 * One bot serves everyone, but a bot can only message a chat that has written
 * to it first — and it addresses that chat by a numeric id, never by an @handle.
 * So an account cannot just type its username and start receiving messages; it
 * has to press Start in the bot, and the bot has to learn which chat that was.
 *
 * The link is a short-lived code. The account asks for one, opens the bot with
 * it (`t.me/<bot>?start=<code>`), and when the bot sees `/start <code>` the
 * server matches the code to the account and records the chat id it came from.
 * From then on that id is where the account's whale alerts, tracker hits and
 * snipe results are delivered. The code is single-use and expires, so a leaked
 * one is worth nothing for long; the chat id is what persists.
 *
 * Stored per account beside its config, like every other thing a wallet owns,
 * so one account can never see or divert another's chat.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface TelegramLink {
  /** The numeric chat id, once the account has pressed Start. */
  chatId?: string;
  /** A pending link code, waiting for the bot to see it. */
  code?: string;
  /** When the code was issued, so a stale one can be refused. */
  codeAt?: number;
  /** When the chat was linked. */
  linkedAt?: number;
}

/** A code is only good for a quarter of an hour — long enough to press Start. */
export const CODE_TTL_MS = 15 * 60_000;

function pathFor(configPath: string): string {
  return `${resolve(configPath)}.telegram.json`;
}

export function loadLink(configPath: string): TelegramLink {
  try {
    const r = JSON.parse(readFileSync(pathFor(configPath), "utf8")) as Partial<TelegramLink>;
    const out: TelegramLink = {};
    if (typeof r.chatId === "string" && /^-?\d+$/.test(r.chatId)) out.chatId = r.chatId;
    if (typeof r.code === "string" && r.code) out.code = r.code;
    if (Number.isFinite(r.codeAt)) out.codeAt = r.codeAt as number;
    if (Number.isFinite(r.linkedAt)) out.linkedAt = r.linkedAt as number;
    return out;
  } catch {
    return {};
  }
}

function save(configPath: string, link: TelegramLink): void {
  const target = pathFor(configPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Issue a fresh link code for an account, replacing any pending one.
 *
 * The code is URL-safe and short — it rides in a `t.me` deep link and a person
 * may end up typing it — but random enough that it cannot be guessed into
 * another account's chat before it expires.
 */
export function issueCode(configPath: string, nowMs = Date.now()): string {
  const code = randomBytes(9).toString("base64url");
  const link = loadLink(configPath);
  save(configPath, { ...link, code, codeAt: nowMs });
  return code;
}

/** Whether a code matches the account's pending, unexpired one. */
export function codeIsValid(link: TelegramLink, code: string, nowMs = Date.now()): boolean {
  return (
    !!link.code &&
    link.code === code &&
    typeof link.codeAt === "number" &&
    nowMs - link.codeAt <= CODE_TTL_MS
  );
}

/** Bind a chat id to an account and clear the pending code. */
export function setChatId(configPath: string, chatId: string, nowMs = Date.now()): void {
  const link = loadLink(configPath);
  save(configPath, { chatId, linkedAt: nowMs });
  void link;
}

/** Forget the chat — a disconnect. */
export function unlink(configPath: string): void {
  save(configPath, {});
}

export function getChatId(configPath: string): string | null {
  return loadLink(configPath).chatId ?? null;
}

export function isLinked(configPath: string): boolean {
  return Boolean(loadLink(configPath).chatId);
}
