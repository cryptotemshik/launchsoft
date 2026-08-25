/**
 * Measure your endpoints from the box that will actually fire.
 *
 * Published RPC benchmarks are run from the provider's chosen regions against
 * the provider's chosen methods, and none of them tell you the one number that
 * decides a first-come-first-served race: how long a packet takes from *your*
 * VPS to *this* chain's sequencer. That is a property of your machine's
 * location, not of anyone's marketing page — so measure it here.
 *
 * Two different things are measured, because they answer different questions:
 *
 *   connect  — TCP + TLS handshake, cold, no connection reuse. This is the
 *              cost the very first request pays, and the reason the runner
 *              warms every endpoint before a stage opens.
 *   request  — a round-trip on an already-open connection. This is what a
 *              pre-warmed blast actually costs at T-0, and what to compare
 *              endpoints on.
 *
 *   npm run rpc:bench                    # config + chain endpoints
 *   npm run rpc:bench -- https://your.rpc/… --samples 30
 */
import { connect as tlsConnect } from "node:tls";
import { getChainInfo } from "../chains";
import { loadConfig } from "./config";
import { ms, summarise, type LatencySummary } from "../lib/latency";

const CONFIG_PATH = process.env.SNIPE_CONFIG ?? "snipe.config.json";

interface Row {
  label: string;
  host: string;
  connect: LatencySummary;
  request: LatencySummary;
  note?: string;
}

/** Host only — endpoint URLs usually carry a provider API key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One cold TCP+TLS handshake, torn down straight away. */
function connectOnce(url: string, timeoutMs = 8_000): Promise<number | null> {
  const u = new URL(url);
  if (u.protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve) => {
    const started = performance.now();
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const socket = tlsConnect(
      { host: u.hostname, port: Number(u.port) || 443, servername: u.hostname },
      () => {
        finish(performance.now() - started);
        socket.destroy();
      },
    );
    socket.setTimeout(timeoutMs, () => {
      finish(null);
      socket.destroy();
    });
    socket.on("error", () => finish(null));
  });
}

/**
 * One JSON-RPC round-trip. `keepAlive` is on so repeated samples measure the
 * request rather than a fresh handshake each time.
 */
async function requestOnce(url: string, method: string): Promise<number | null> {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "keep-alive" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    await res.text();
    // A 429 is an answer, but not one worth timing — it says nothing about the
    // path and would flatter an endpoint that is refusing to work.
    if (res.status === 429) return null;
    return performance.now() - started;
  } catch {
    return null;
  }
}

async function measure(label: string, url: string, samples: number): Promise<Row> {
  const connects: (number | null)[] = [];
  for (let i = 0; i < Math.min(samples, 5); i++) connects.push(await connectOnce(url));

  // One throwaway request opens the connection the timed ones will reuse.
  await requestOnce(url, "eth_chainId");
  const reqs: (number | null)[] = [];
  for (let i = 0; i < samples; i++) reqs.push(await requestOnce(url, "eth_blockNumber"));

  const request = summarise(reqs);
  let note: string | undefined;
  if (request.n === 0 && summarise(connects).n > 0) {
    // Expected for a sequencer: it accepts eth_sendRawTransaction and refuses
    // reads. The handshake time is still exactly what a blast pays.
    note = "no reads (send-only) — connect time is the number that matters";
  }
  return { label, host: hostOf(url), connect: summarise(connects), request, note };
}

function table(rows: Row[]): string {
  const head = ["endpoint", "connect", "request p50", "request p95", "fastest", "failed"];
  const body = rows.map((r) => [
    r.host,
    ms(r.connect.median),
    ms(r.request.median),
    ms(r.request.p95),
    ms(r.request.min),
    String(r.connect.failed + r.request.failed),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(head), line(w.map((n) => "─".repeat(n))), ...body.map(line)].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const sIdx = args.indexOf("--samples");
  const samples = sIdx === -1 ? 20 : Number(args[sIdx + 1]);
  const extra = args.filter((a) => a.startsWith("http"));

  let cfg: ReturnType<typeof loadConfig> | null = null;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch {
    // Benching without a config is fine — pass endpoints on the command line.
  }
  const info = getChainInfo(cfg?.chainId ?? 4663);
  if (!info) throw new Error(`chain ${cfg?.chainId} isn't in the registry`);

  const seen = new Set<string>();
  const targets: { label: string; url: string }[] = [];
  const add = (label: string, url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    targets.push({ label, url });
  };
  (info.submitRpcs ?? []).forEach((u) => add("sequencer", u));
  info.chain.rpcUrls.default.http.forEach((u) => add("public", u));
  (cfg?.extraRpcs ?? []).forEach((u) => add("yours", u));
  extra.forEach((u) => add("cli", u));

  console.log(`${info.label} · ${samples} samples per endpoint\n`);
  const rows: Row[] = [];
  for (const t of targets) {
    process.stdout.write(`measuring ${hostOf(t.url)} … `);
    const row = await measure(t.label, t.url, samples);
    rows.push(row);
    console.log("done");
  }
  console.log(`\n${table(rows)}`);
  for (const r of rows) if (r.note) console.log(`\n${r.host}: ${r.note}`);

  console.log(
    "\nconnect is what a cold request pays; request is what a pre-warmed blast pays.\n" +
      "On a first-come-first-served chain the sequencer is the shortest path in — the\n" +
      "others are there so a bad moment at one endpoint doesn't cost you the drop.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
