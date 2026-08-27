/**
 * Whether an endpoint will actually serve the scanner.
 *
 * This exists because of a failure that hid for days. Alchemy's free tier caps
 * `eth_getLogs` at ten blocks — an hour of this chain is thirty-five thousand —
 * so every scan through it is refused. The read client is a viem `fallback`
 * with the chain's public RPC behind whatever the user configured, and viem
 * quietly moves to the next transport when one errors. The scan therefore kept
 * working, through the public node, while the panel's badge went on naming the
 * paid endpoint that had not answered a single log request. The visible
 * symptom was rate limits from a host the user believed they had stopped using.
 *
 * A range that fits is the only honest test: the cap is per plan and per
 * provider, and no amount of reading documentation substitutes for asking.
 */

/** Wide enough that any endpoint fit for scanning says yes, and the rest say no. */
export const PROBE_BLOCKS = 10_000n;

export interface LogRangeVerdict {
  /** True when the endpoint answered a range worth scanning with. */
  ok: boolean;
  /** What it said instead, trimmed for a log line. */
  reason?: string;
  /** The widest range it suggested, when it named one. */
  suggested?: number;
}

/**
 * Ask one endpoint for a modest range of SeaDrop logs.
 *
 * Deliberately a bare fetch rather than a viem client: the whole point is to
 * hear this endpoint's own answer, and a fallback client would hide it behind
 * the next endpoint in the list — which is the bug being diagnosed.
 */
export async function probeLogRange(
  url: string,
  address: string,
  tip: bigint,
  fetchImpl: typeof fetch = fetch,
): Promise<LogRangeVerdict> {
  const from = tip > PROBE_BLOCKS ? tip - PROBE_BLOCKS : 0n;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${tip.toString(16)}` }],
      }),
    });
    // A 429 here is the endpoint being busy, not incapable. Calling that a
    // failure would have the server cry wolf about a perfectly good node.
    if (res.status === 429) return { ok: true };
    const body = (await res.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (!message) return { ok: true };
    // Only a refusal that is actually about the range counts. The chain's own
    // node answers a wide unfiltered query with "internal server errror" when
    // it is having a moment, and reading that as a cap had the server accuse
    // the one endpoint on this chain that has no cap at all.
    if (!namesARangeLimit(message)) return { ok: true, reason: trim(message) };
    return { ok: false, reason: trim(message), suggested: suggestedWidth(message) };
  } catch (e) {
    // Unreachable is a different problem with a different fix, and the read
    // client's own fallback already covers it. Don't report it as a cap.
    return { ok: true, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Whether a refusal is about how much was asked for, rather than the endpoint
 * having a bad day. Providers word it differently, but all of them name the
 * size of the ask; none of them do for a genuine internal error.
 */
function namesARangeLimit(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("range") ||
    m.includes("limit") ||
    m.includes("too large") ||
    m.includes("too many") ||
    m.includes("more than") ||
    m.includes("exceed")
  );
}

function trim(message: string): string {
  const one = message.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}…` : one;
}

/**
 * Providers that refuse a range usually name one that would have worked, as a
 * pair of hex block numbers. That number is the single most useful thing to
 * put in front of someone wondering why their scanner is slow.
 */
function suggestedWidth(message: string): number | undefined {
  const hex = message.match(/0x[0-9a-fA-F]+/g);
  if (!hex || hex.length < 2) return undefined;
  const width = Number(BigInt(hex[1]) - BigInt(hex[0])) + 1;
  return Number.isFinite(width) && width > 0 ? width : undefined;
}
