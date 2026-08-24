/**
 * Control server — lets the browser panel drive a run that executes here.
 *
 * The important property: this does NOT put the browser in the firing path.
 * A request only *starts* a run; once started, the run holds and fires on this
 * machine's own clock (see runner.ts). So a browser-triggered snipe is exactly
 * as fast as one typed over SSH — what matters is that this process sits next
 * to the sequencer.
 *
 * Security posture:
 *   - binds to 127.0.0.1 by default, so nothing is exposed until you publish
 *     it deliberately (Cloudflare Tunnel is the documented route — outbound
 *     only, no inbound port open on the box);
 *   - every route needs a bearer token, compared in constant time;
 *   - private keys never leave this process. The panel sees addresses and
 *     balances, never a key;
 *   - CORS is limited to the origins you list.
 *
 *   npm run snipe:server
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, loadKeys } from "./config";
import { runSnipe, type RunOptions, type RunResult } from "./runner";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

const PORT = Number(process.env.SNIPE_PORT ?? 8787);
const HOST = process.env.SNIPE_HOST ?? "127.0.0.1";
const TOKEN = process.env.SNIPE_TOKEN ?? "";
/** Comma-separated list; "*" allows any origin (only sane behind a tunnel + token). */
const ORIGINS = (process.env.SNIPE_ORIGINS ?? "*").split(",").map((s) => s.trim());
const CONFIG_PATH = process.env.SNIPE_CONFIG ?? "snipe.config.json";

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    "SNIPE_TOKEN must be set to a secret of at least 16 characters — it is the only thing\n" +
      "standing between the internet and your wallets. Generate one with:\n" +
      "  openssl rand -hex 32",
  );
  process.exit(1);
}

// ── Run state — one run at a time, which is what a single set of nonces allows ──
interface RunState {
  id: string;
  startedAt: number;
  status: "running" | "done" | "error" | "aborted";
  dryRun: boolean;
  logs: string[];
  result?: RunResult;
  error?: string;
  abort: AbortController;
}
let current: RunState | null = null;

function tokenOk(header: string | undefined): boolean {
  const given = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual throws on length mismatch, so equalise first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes("*") ? origin ?? "*" : ORIGINS.find((o) => o === origin);
  if (allow) res.setHeader("access-control-allow-origin", allow);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("vary", "origin");
}

function json(res: ServerResponse, code: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Public view of a run — logs and outcomes, never keys. */
function stateView(s: RunState | null) {
  if (!s) return { running: false };
  return {
    running: s.status === "running",
    id: s.id,
    status: s.status,
    dryRun: s.dryRun,
    startedAt: s.startedAt,
    logs: s.logs,
    plan: s.result?.plan,
    outcomes: s.result?.outcomes,
    error: s.error,
  };
}

/** Merge the on-disk config with whatever the panel overrode. */
function buildOptions(body: Record<string, unknown>): RunOptions {
  const cfg = loadConfig(CONFIG_PATH);
  const keys = loadKeys(CONFIG_PATH, cfg.keysFile);

  const collection = typeof body.collection === "string" ? body.collection : cfg.collection;
  if (!/^0x[0-9a-fA-F]{40}$/.test(collection)) throw new Error("collection must be a 0x address");

  const stage = body.stage === "allowlist" || body.stage === "public" ? body.stage : cfg.stage;
  const timing = body.timing === "now" || body.timing === "wait" ? body.timing : cfg.timing;
  const quantity =
    typeof body.quantity === "number" && Number.isInteger(body.quantity) && body.quantity >= 1
      ? body.quantity
      : cfg.quantity;
  const gasIn = (body.gas ?? {}) as Partial<RunOptions["gas"]>;

  return {
    chainId: typeof body.chainId === "number" ? body.chainId : cfg.chainId,
    collection: collection as `0x${string}`,
    stage,
    quantity,
    keys,
    extraRpcs: Array.isArray(body.extraRpcs)
      ? (body.extraRpcs as unknown[]).filter((x): x is string => typeof x === "string")
      : cfg.extraRpcs,
    gas: {
      maxFeeGwei: gasIn.maxFeeGwei ?? cfg.gas.maxFeeGwei,
      tipGwei: gasIn.tipGwei ?? cfg.gas.tipGwei,
      limit: gasIn.limit ?? cfg.gas.limit,
    },
    timing,
    dryRun: body.dryRun !== false,
  };
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Unauthenticated liveness probe — says nothing about the wallets.
  if (url.pathname === "/api/ping") {
    json(res, 200, { ok: true, service: "launchpad-snipe" });
    return;
  }

  if (!tokenOk(req.headers.authorization)) {
    json(res, 401, { error: "bad or missing token" });
    return;
  }

  try {
    if (url.pathname === "/api/status" && req.method === "GET") {
      json(res, 200, stateView(current));
      return;
    }

    if (url.pathname === "/api/abort" && req.method === "POST") {
      if (!current || current.status !== "running") {
        json(res, 409, { error: "no run in progress" });
        return;
      }
      current.abort.abort();
      current.status = "aborted";
      log("abort requested from the panel");
      json(res, 200, stateView(current));
      return;
    }

    if (url.pathname === "/api/snipe" && req.method === "POST") {
      if (current?.status === "running") {
        json(res, 409, { error: "a run is already in progress — abort it first" });
        return;
      }
      const body = await readBody(req);
      const opts = buildOptions(body);

      const state: RunState = {
        id: `${Date.now()}`,
        startedAt: Date.now(),
        status: "running",
        dryRun: opts.dryRun,
        logs: [],
        abort: new AbortController(),
      };
      current = state;
      log(`run ${state.id} started (${opts.dryRun ? "dry run" : "LIVE"}) for ${opts.collection}`);

      // Kick the run off and answer immediately: the panel polls /api/status.
      // Nothing about the caller is in the firing path from here on.
      void runSnipe(opts, {
        signal: state.abort.signal,
        onLog: (line) => {
          const entry = `[${stamp()}] ${line}`;
          state.logs.push(entry);
          if (state.logs.length > 500) state.logs.shift();
          console.log(entry);
        },
      })
        .then((result) => {
          state.result = result;
          if (state.status !== "aborted") state.status = "done";
        })
        .catch((e) => {
          state.status = "error";
          state.error = e instanceof Error ? e.message : String(e);
          log(`run ${state.id} failed: ${state.error}`);
        });

      json(res, 202, { started: true, id: state.id, dryRun: opts.dryRun });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`control server on http://${HOST}:${PORT}`);
  log(`config ${CONFIG_PATH} · origins ${ORIGINS.join(", ")}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    log("WARNING binding to a public interface — prefer 127.0.0.1 behind a Cloudflare Tunnel");
  }
});
