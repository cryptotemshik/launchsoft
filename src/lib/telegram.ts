/**
 * Telegram notifications for finished runs.
 *
 * Server-side only: the bot token lives on the VPS, never in the browser.
 * Failures here are deliberately swallowed by the caller — a notification that
 * didn't send must never turn a successful mint into a failed run.
 */

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Telegram rejects messages over 4096 chars; leave room for the closing tags. */
const MAX_LEN = 3900;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface MintedWallet {
  address: string;
  status: string;
  quantity: number;
  tokenIds: string[];
  txHash?: string;
  detail?: string;
}

export interface MintReport {
  collectionName: string;
  collection: string;
  chainLabel: string;
  stage: string;
  /** Base URL for an item, given a token id — chain-aware. */
  itemUrl: (tokenId: string) => string;
  collectionUrl: string;
  explorerTxUrl: (hash: string) => string;
  profileUrl: (address: string) => string;
  wallets: MintedWallet[];
  dryRun?: boolean;
}

const STATUS_ICON: Record<string, string> = {
  mined: "✅",
  reverted: "❌",
  rejected: "⛔",
  timeout: "⏳",
  skipped: "⚪",
};

/**
 * Pack lines into as many messages as they need.
 *
 * Truncating is the wrong answer for a failure list: the wallets that got cut
 * are exactly the ones someone needs to look at. So a long section becomes
 * several messages, each carrying the header again with its part number, and
 * nothing is dropped. A single line longer than the limit is trimmed — that
 * can only be one over-long error string, and losing part of one reason is
 * better than losing the wallets after it.
 */
export function packMessages(header: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const out: string[] = [];
  let current: string[] = [];
  let length = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push([header, "", ...current].join("\n"));
    current = [];
    length = 0;
  };

  for (const raw of lines) {
    const line = raw.length > MAX_LEN - 200 ? `${raw.slice(0, MAX_LEN - 200)}…` : raw;
    if (length + line.length + 1 > MAX_LEN - header.length - 32) flush();
    current.push(line);
    length += line.length + 1;
  }
  flush();

  return out.length === 1
    ? out
    : out.map((m, i) => m.replace(header, `${header} (${i + 1}/${out.length})`));
}

const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

/**
 * A finished run as Telegram messages: an overview, then the wallets that
 * minted with their token ids, then every wallet that did not with its reason.
 *
 * Three messages rather than one because they answer different questions and
 * get read at different times. The overview is the glance from a lock screen;
 * the second says which wallets to go and list from, each linked to its
 * OpenSea profile; the third is the post-mortem, and it lists **every** failed
 * wallet — a partial list of failures is the one thing that makes a report
 * untrustworthy.
 */
export function formatMintReport(r: MintReport): string[] {
  const minted = r.wallets.filter((w) => w.status === "mined");
  const totalNfts = minted.reduce((n, w) => n + w.quantity, 0);
  const failed = r.wallets.filter((w) => w.status !== "mined" && w.status !== "skipped");
  const skipped = r.wallets.filter((w) => w.status === "skipped");

  const head = r.dryRun
    ? "🧪 <b>DRY RUN</b> (nothing broadcast)"
    : totalNfts > 0
      ? "✅ <b>MINT COMPLETE</b>"
      : "⚠️ <b>MINT FAILED</b>";

  // Numbers first, name after: on a lock screen the first line is all that is
  // read, and "28 NFTs from 4 wallets" is the thing worth knowing there.
  const overview = [
    head,
    "",
    `💎 <b>${totalNfts}</b> NFT${totalNfts === 1 ? "" : "s"} on <b>${minted.length}</b> wallet${minted.length === 1 ? "" : "s"}`,
    failed.length ? `❌ <b>${failed.length}</b> wallet${failed.length === 1 ? "" : "s"} failed` : "",
    skipped.length ? `⚪ ${skipped.length} skipped (not eligible)` : "",
    "",
    `<a href="${r.collectionUrl}">${escapeHtml(r.collectionName)}</a>`,
    `${escapeHtml(r.chainLabel)} · ${escapeHtml(r.stage)} stage`,
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [overview];
  const collectionLine = `<a href="${r.collectionUrl}">${escapeHtml(r.collectionName)}</a>`;

  if (minted.length > 0) {
    const lines = minted.map((w) => {
      const links = w.tokenIds.map((id) => `<a href="${r.itemUrl(id)}">#${id}</a>`).join(" ");
      const tx = w.txHash ? ` · <a href="${r.explorerTxUrl(w.txHash)}">tx</a>` : "";
      return (
        `✅ <a href="${r.profileUrl(w.address)}">${shortAddr(w.address)}</a>` +
        ` — <b>${w.quantity}</b> NFT${w.quantity === 1 ? "" : "s"}${tx}` +
        (links ? `\n   ${links}` : "")
      );
    });
    const header =
      `💎 <b>MINTED — ${minted.length} wallet${minted.length === 1 ? "" : "s"}, ` +
      `${totalNfts} NFT${totalNfts === 1 ? "" : "s"}</b>\n${collectionLine}`;
    messages.push(...packMessages(header, lines));
  }

  if (failed.length > 0) {
    const lines = failed.map((w) => {
      const icon = STATUS_ICON[w.status] ?? "•";
      const tx = w.txHash ? ` · <a href="${r.explorerTxUrl(w.txHash)}">tx</a>` : "";
      const why = w.detail ? escapeHtml(w.detail.slice(0, 160)) : escapeHtml(w.status);
      // Reason on its own line: a wallet and a revert string on one line wraps
      // into an unreadable block on a phone.
      return (
        `${icon} <a href="${r.profileUrl(w.address)}">${shortAddr(w.address)}</a>${tx}` +
        `\n   ${why}`
      );
    });
    const header =
      `❌ <b>FAILED — ${failed.length} wallet${failed.length === 1 ? "" : "s"}</b>\n${collectionLine}`;
    messages.push(...packMessages(header, lines));
  }

  return messages;
}

/** Post a message. Returns false instead of throwing — see the file header. */
export async function sendTelegram(
  cfg: TelegramConfig,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !body.ok) return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
