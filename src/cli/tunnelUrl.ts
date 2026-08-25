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
 * The most recently printed tunnel URL in a log, or null.
 *
 * Last, not first: the log accumulates across restarts, and every earlier URL
 * in it is dead. Taking the first match would hand back an address that is
 * guaranteed not to work.
 */
export function extractTunnelUrl(log: string): string | null {
  const found = log.match(TUNNEL_RE);
  if (!found || found.length === 0) return null;
  return found[found.length - 1].toLowerCase();
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
