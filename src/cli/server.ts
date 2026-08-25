/**
 * Control server — a queue of drops, executed next to the sequencer.
 *
 * The important property: this does NOT put the browser in the firing path. A
 * request only *queues* or *starts* a run; the run itself holds and fires on
 * this machine's own clock (see runner.ts). So a browser-triggered snipe is
 * exactly as fast as one typed over SSH — what matters is that this process
 * sits next to the sequencer.
 *
 * Why the queue runs strictly one job at a time: every wallet's transactions
 * are pre-signed against a specific nonce. Two jobs armed at once for the same
 * wallets would sign the same nonce twice and the second would be rejected. So
 * the scheduler arms the next job only once the previous has settled, reading
 * fresh nonces at arm time — which still leaves the full pre-sign advantage,
 * since arming happens ARM_LEAD_MS before the stage opens.
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
import { timingSafeEqual, randomUUID } from "node:crypto";
import { loadConfig, loadKeys } from "./config";
import { runSnipe, type RunOptions, type RunResult } from "./runner";
import { formatMintReport, sendTelegram, type MintedWallet } from "../lib/telegram";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

const PORT = Number(process.env.SNIPE_PORT ?? 8787);
const HOST = process.env.SNIPE_HOST ?? "127.0.0.1";
const TOKEN = process.env.SNIPE_TOKEN ?? "";
/** Comma-separated list; "*" allows any origin (only sane behind a tunnel + token). */
const ORIGINS = (process.env.SNIPE_ORIGINS ?? "*").split(",").map((s) => s.trim());
const CONFIG_PATH = process.env.SNIPE_CONFIG ?? "snipe.config.json";
/** How far ahead of a stage a job is armed (read nonces, pre-sign, warm). */
const ARM_LEAD_MS = Number(process.env.SNIPE_ARM_LEAD_MS ?? 120_000);

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    "SNIPE_TOKEN must be set to a secret of at least 16 characters — it is the only thing\n" +
      "standing between the internet and your wallets. Generate one with:\n" +
      "  openssl rand -hex 32",
  );
  process.exit(1);
}

// ── Queue ────────────────────────────────────────────────────────────────────
type JobStatus = "queued" | "armed" | "done" | "error" | "aborted";

interface Job {
  id: string;
  label: string;
  addedAt: number;
  status: JobStatus;
  /** Everything runSnipe needs except the keys, which are read at arm time. */
  request: Omit<RunOptions, "keys">;
  /** Stage start, once known — filled in by a dry run or by the job itself. */
  startTime?: number;
  logs: string[];
  result?: RunResult;
  error?: string;
  abort?: AbortController;
}

const jobs: Job[] = [];
/** At most one job may be armed/firing — see the nonce note in the header. */
let activeJobId: string | null = null;

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
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("vary", "origin");
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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

/** Public view of a job — logs and outcomes, never keys. */
function jobView(j: Job) {
  return {
    id: j.id,
    label: j.label,
    status: j.status,
    addedAt: j.addedAt,
    startTime: j.startTime,
    collection: j.request.collection,
    stage: j.request.stage,
    quantity: j.request.quantity,
    dryRun: j.request.dryRun,
    logs: j.logs.slice(-60),
    plan: j.result?.plan,
    outcomes: j.result?.outcomes,
    error: j.error,
  };
}

/** Merge the on-disk defaults with whatever the panel supplied. */
function buildRequest(body: Record<string, unknown>): Omit<RunOptions, "keys"> {
  const cfg = loadConfig(CONFIG_PATH);

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

/** Send the run summary to Telegram, if configured. Never throws. */
async function notify(job: Job) {
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch {
    return;
  }
  if (!cfg.telegram) return;
  const plan = job.result?.plan;
  const outcomes = job.result?.outcomes;
  if (!plan) return;

  const wallets: MintedWallet[] = (outcomes ?? []).map((o) => ({
    address: o.address,
    status: o.status,
    quantity: o.tokenIds?.length ?? 0,
    tokenIds: o.tokenIds ?? [],
    txHash: o.txHash,
    detail: o.detail,
  }));

  const slug = plan.openSeaSlug;
  const html = formatMintReport({
    collectionName: plan.name,
    collection: plan.collection,
    chainLabel: plan.chain,
    stage: plan.stage,
    dryRun: job.request.dryRun,
    collectionUrl: `https://opensea.io/assets/${slug}/${plan.collection}`,
    itemUrl: (id) => `https://opensea.io/item/${slug}/${plan.collection}/${id}`,
    profileUrl: (a) => `https://opensea.io/${a}`,
    explorerTxUrl: (h) => `${plan.explorerUrl}/tx/${h}`,
    wallets,
  });

  const r = await sendTelegram(cfg.telegram, html);
  log(r.ok ? `telegram sent for job ${job.id}` : `telegram failed: ${r.error}`);
}

/** Run one job to completion, then notify. Only ever called by the scheduler. */
async function execute(job: Job) {
  activeJobId = job.id;
  const abort = new AbortController();
  job.abort = abort;
  job.status = "armed";
  const keys = loadKeys(CONFIG_PATH, loadConfig(CONFIG_PATH).keysFile);
  log(`job ${job.id} (${job.label}) arming — ${job.request.dryRun ? "dry run" : "LIVE"}`);

  try {
    const result = await runSnipe(
      { ...job.request, keys },
      {
        signal: abort.signal,
        onLog: (line) => {
          const entry = `[${stamp()}] ${line}`;
          job.logs.push(entry);
          if (job.logs.length > 500) job.logs.shift();
          console.log(`  ${entry}`);
        },
      },
    );
    job.result = result;
    job.startTime = result.plan.startTime;
    // The abort route may have fired while this was running; the signal is the
    // authority, since `status` was narrowed to "armed" above.
    job.status = abort.signal.aborted ? "aborted" : "done";
  } catch (e) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    log(`job ${job.id} failed: ${job.error}`);
  } finally {
    activeJobId = null;
  }
  await notify(job);
}

/**
 * Scheduler tick. Picks the next job to run: a job is due when its stage is
 * within ARM_LEAD_MS (or already open), and nothing else is armed. Jobs whose
 * start time isn't known yet are treated as due immediately — the run itself
 * reads the drop and then holds.
 */
function tick() {
  if (activeJobId) return;
  const now = Date.now();
  const due = jobs
    .filter((j) => j.status === "queued")
    .filter((j) => j.startTime === undefined || j.startTime * 1000 - now <= ARM_LEAD_MS)
    // Soonest stage first; unknown start times go last so a dated job wins.
    .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
  const next = due[0];
  if (next) void execute(next);
}
setInterval(tick, 1000);

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
      json(res, 200, {
        running: activeJobId !== null,
        activeJobId,
        armLeadMs: ARM_LEAD_MS,
        jobs: jobs.map(jobView),
      });
      return;
    }

    // Queue a drop. This is the normal path — add ten of them hours ahead.
    if (url.pathname === "/api/queue" && req.method === "POST") {
      const body = await readBody(req);
      const request = buildRequest(body);
      const job: Job = {
        id: randomUUID().slice(0, 8),
        label: typeof body.label === "string" && body.label ? body.label : request.collection.slice(0, 10),
        addedAt: Date.now(),
        status: "queued",
        request,
        startTime: typeof body.startTime === "number" ? body.startTime : undefined,
        logs: [],
      };
      jobs.push(job);
      log(`queued job ${job.id} (${job.label}) for ${request.collection}`);
      json(res, 201, jobView(job));
      return;
    }

    if (url.pathname === "/api/queue" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const i = jobs.findIndex((j) => j.id === id);
      if (i === -1) {
        json(res, 404, { error: "no such job" });
        return;
      }
      if (jobs[i].id === activeJobId) {
        json(res, 409, { error: "job is running — abort it first" });
        return;
      }
      const [removed] = jobs.splice(i, 1);
      log(`removed job ${removed.id}`);
      json(res, 200, { removed: removed.id });
      return;
    }

    if (url.pathname === "/api/abort" && req.method === "POST") {
      const job = jobs.find((j) => j.id === activeJobId);
      if (!job) {
        json(res, 409, { error: "no run in progress" });
        return;
      }
      job.abort?.abort();
      job.status = "aborted";
      log(`abort requested for job ${job.id}`);
      json(res, 200, jobView(job));
      return;
    }

    // Back-compat single-shot: queue it and let the scheduler pick it up now.
    if (url.pathname === "/api/snipe" && req.method === "POST") {
      const body = await readBody(req);
      const request = buildRequest(body);
      const job: Job = {
        id: randomUUID().slice(0, 8),
        label: typeof body.label === "string" && body.label ? body.label : request.collection.slice(0, 10),
        addedAt: Date.now(),
        status: "queued",
        request,
        logs: [],
      };
      jobs.push(job);
      json(res, 202, { started: true, id: job.id, dryRun: request.dryRun });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`control server on http://${HOST}:${PORT}`);
  log(`config ${CONFIG_PATH} · origins ${ORIGINS.join(", ")} · arm lead ${ARM_LEAD_MS / 1000}s`);
  try {
    const cfg = loadConfig(CONFIG_PATH);
    log(cfg.telegram ? "telegram notifications ON" : "telegram notifications off (no token/chat id)");
  } catch {
    log("config not readable yet — queue requests will report the error");
  }
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    log("WARNING binding to a public interface — prefer 127.0.0.1 behind a Cloudflare Tunnel");
  }
});
