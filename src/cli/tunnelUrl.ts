/**
 * Finding out what address the box is reachable at.
 *
 * A Cloudflare quick tunnel picks a fresh random hostname every time
 * `cloudflared` starts, and prints it to its log exactly once. So a tunnel
 * restart — planned or not — silently changes the only address the panel can
 * reach, and the new one is recoverable only by opening a terminal on the box:
 * precisely the thing someone away from their desk cannot do, and precisely
 * when they most need to get back in.
 *
 * The server therefore reads the URL out of the tunnel's log on startup,
 * reports it, and messages it to Telegram whenever it changes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Quick-tunnel hostnames are `https://<words>.trycloudflare.com`. */
const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

/**
 * cloudflared says this immediately before printing a freshly issued address.
 * Anchoring on it is what makes the answer trustworthy: pm2's log file
 * accumulates across restarts, so it still holds every dead address the box
 * has ever had, and simply taking the last URL in the file returns a stale one
 * whenever the new banner has not been written yet — which is exactly the
 * moment anyone asks.
 */
const NEW_TUNNEL_RE = /(?:Requesting new quick Tunnel|quick Tunnel has been created)/gi;

/**
 * The address the *current* cloudflared is serving, or null.
 *
 * Looks only after the last "new tunnel" banner in the log. Falls back to the
 * last URL in the file when there is no banner at all — better than nothing,
 * and the caller can still check it.
 */
export function extractTunnelUrl(log: string): string | null {
  let searchFrom = 0;
  const banners = [...log.matchAll(NEW_TUNNEL_RE)];
  if (banners.length > 0) {
    const last = banners[banners.length - 1];
    searchFrom = (last.index ?? 0) + last[0].length;
  }

  const after = log.slice(searchFrom).match(TUNNEL_RE);
  if (after && after.length > 0) return after[after.length - 1].toLowerCase();

  // A banner with no URL after it means cloudflared is still negotiating: the
  // address it had before that banner is already dead, so say we don't know.
  if (banners.length > 0) return null;

  const anywhere = log.match(TUNNEL_RE);
  return anywhere && anywhere.length > 0 ? anywhere[anywhere.length - 1].toLowerCase() : null;
}

/**
 * Ask pm2 for the tunnel's log and pull the address out of it.
 *
 * @param processName the pm2 process running cloudflared.
 */
export async function currentTunnelUrl(processName = "tunnel"): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(
      "pm2",
      ["logs", processName, "--lines", "400", "--nostream"],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return extractTunnelUrl(`${stdout}\n${stderr}`);
  } catch {
    // No pm2, no such process, or it has printed nothing yet. Not knowing the
    // URL is not a reason to fail starting up.
    return null;
  }
}
