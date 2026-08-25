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
 * A run summary as Telegram HTML: the headline numbers first, then one line
 * per wallet with its token links, so the whole result is readable on a phone
 * without opening anything.
 */
export function formatMintReport(r: MintReport): string {
  const minted = r.wallets.filter((w) => w.status === "mined");
  const totalNfts = minted.reduce((n, w) => n + w.quantity, 0);
  const failed = r.wallets.filter((w) => w.status !== "mined" && w.status !== "skipped");

  const head = r.dryRun
    ? "🧪 <b>DRY RUN</b> (nothing broadcast)"
    : totalNfts > 0
      ? "✅ <b>MINT COMPLETE</b>"
      : "⚠️ <b>MINT FAILED</b>";

  const lines: string[] = [
    head,
    `<a href="${r.collectionUrl}">${escapeHtml(r.collectionName)}</a> · ${escapeHtml(r.chainLabel)} · ${escapeHtml(r.stage)} stage`,
    "",
    `<b>${totalNfts}</b> NFT${totalNfts === 1 ? "" : "s"} from <b>${minted.length}</b> wallet${minted.length === 1 ? "" : "s"}` +
      (failed.length ? ` · ${failed.length} failed` : ""),
    "",
  ];

  for (const w of r.wallets) {
    const icon = STATUS_ICON[w.status] ?? "•";
    const short = `${w.address.slice(0, 8)}…${w.address.slice(-4)}`;
    let line = `${icon} <a href="${r.profileUrl(w.address)}">${short}</a>`;
    if (w.status === "mined") {
      line += ` — ${w.quantity} NFT${w.quantity === 1 ? "" : "s"}`;
      if (w.tokenIds.length > 0) {
        // Cap the token links so a 50-mint run doesn't blow the length limit.
        const shown = w.tokenIds.slice(0, 8);
        const links = shown.map((id) => `<a href="${r.itemUrl(id)}">#${id}</a>`).join(" ");
        line += `\n   ${links}${w.tokenIds.length > shown.length ? ` +${w.tokenIds.length - shown.length} more` : ""}`;
      }
    } else {
      line += ` — ${escapeHtml(w.status)}${w.detail ? `: ${escapeHtml(w.detail.slice(0, 120))}` : ""}`;
    }
    if (w.txHash) line += `\n   <a href="${r.explorerTxUrl(w.txHash)}">tx</a>`;
    lines.push(line);
  }

  let out = lines.join("\n");
  if (out.length > MAX_LEN) out = `${out.slice(0, MAX_LEN)}\n…(truncated)`;
  return out;
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
