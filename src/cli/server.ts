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
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPublicClient, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { collect, disperse } from "./funding";
import { findHoldings, sweepNfts, type Holding } from "./nftSweep";
import { getChainInfo } from "../chains";
import { normalizePrivateKey } from "../lib/convert";
import {
  keysPath,
  loadConfig,
  loadKeyEntries,
  loadKeys,
  serialiseKeys,
  type KeyEntry,
  type SnipeConfig,
} from "./config";
import { runSnipe, type RunOptions, type RunResult } from "./runner";
import { formatMintReport, sendTelegram, type MintedWallet } from "../lib/telegram";
import { API_VERSION } from "../lib/apiVersion";
import { mapWithLimit, readTransport } from "../lib/rpcRead";

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
  /**
   * Addresses this job may fire from (lowercase). Absent means every wallet on
   * the server — the restriction lives on the job, not on RunOptions, because
   * the server owns the keys and simply passes fewer of them.
   */
  wallets?: string[];
  /** Set when the post-run NFT sweep ran. */
  consolidated?: { to: string; moved: number; total: number };
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
  // Every response carries the version, so a panel learns the server is behind
  // from whichever route it happens to call first rather than only from /ping.
  const payload =
    body && typeof body === "object" && !Array.isArray(body)
      ? { apiVersion: API_VERSION, ...(body as Record<string, unknown>) }
      : body;
  res.end(JSON.stringify(payload));
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
    wallets: j.wallets,
    logs: j.logs.slice(-60),
    plan: j.result?.plan,
    outcomes: j.result?.outcomes,
    consolidated: j.consolidated,
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
  const quantity: number | "max" =
    body.quantity === "max"
      ? "max"
      : typeof body.quantity === "number" && Number.isInteger(body.quantity) && body.quantity >= 1
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


/** Addresses a job is restricted to, validated; undefined means "all wallets". */
function parseWalletFilter(body: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(body.wallets)) return undefined;
  const out = (body.wallets as unknown[])
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim().toLowerCase());
  for (const a of out) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`"${a}" is not a 0x address`);
  }
  return out.length > 0 ? out : undefined;
}

// ── Self-update ──────────────────────────────────────────────────────────────
/**
 * Pull the latest code and restart, triggered from the panel.
 *
 * The site and this server ship from the same repo but deploy separately, so
 * the box falls behind every time the site is published — and reaching a
 * terminal is exactly what someone away from their desk cannot do. This runs
 * the same two commands the README gives, over the same authenticated API as
 * everything else. It can only fast-forward the checkout it is already running
 * from: no caller input reaches the command line, and the remote is whatever
 * the box was cloned from.
 */
const run = promisify(execFile);

async function gitHead(dir: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir });
  return stdout.trim();
}

interface UpdateResult {
  before: string;
  after: string;
  changed: boolean;
  detail: string;
  restarting: boolean;
}

async function selfUpdate(): Promise<UpdateResult> {
  const dir = process.cwd();
  let before: string;
  try {
    before = await gitHead(dir);
  } catch {
    throw new Error(
      `${dir} is not a git checkout, so there is nothing to pull — start the server from the cloned repo`,
    );
  }

  let detail: string;
  try {
    const { stdout } = await run("git", ["pull", "--ff-only"], { cwd: dir, timeout: 120_000 });
    detail = stdout.trim().split("\n").slice(-3).join(" · ");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const lines = `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // git's first line is usually "From <remote>"; the reason is further down.
    const said =
      lines.find((l) => /error|fatal|overwritten|conflict|diverged|refus/i.test(l)) ??
      lines[lines.length - 1];
    throw new Error(`git pull failed: ${said || "unknown reason"}`);
  }

  const after = await gitHead(dir);
  if (after === before) {
    return { before, after, changed: false, detail: "already up to date", restarting: false };
  }

  // Dependencies only need reinstalling when the lockfile actually moved.
  const { stdout: touched } = await run("git", ["diff", "--name-only", before, after], { cwd: dir });
  if (touched.split("\n").some((f) => f.trim() === "package-lock.json")) {
    log("update: lockfile changed — installing dependencies");
    await run("npm", ["install", "--silent"], { cwd: dir, timeout: 600_000 });
  }

  // Answer before the restart tears this process down; pm2 brings it back and
  // the tunnel is a separate process, so the URL and token do not change.
  setTimeout(() => {
    log("update: restarting");
    run("pm2", ["restart", "snipe-api"]).catch(() => process.exit(0));
  }, 400);

  return { before, after, changed: true, detail, restarting: true };
}

// ── Read endpoint ────────────────────────────────────────────────────────────
/**
 * Which endpoint state is read from. Broadcasting a mint goes to every endpoint
 * at once, but reading a hundred balances has to pick one — and the public RPC
 * meters requests per minute, so a paid endpoint pasted into the panel belongs
 * here first.
 */
function readRpc(cfg: SnipeConfig, info: NonNullable<ReturnType<typeof getChainInfo>>): string {
  return cfg.extraRpcs[0] ?? info.chain.rpcUrls.default.http[0];
}

/** Host only — the full URL usually carries a provider API key. */
function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/**
 * Persist the endpoints the panel is using, so server-side reads (balances,
 * funding, sweeps) go through the same paid endpoint the browser does instead
 * of the rate-limited public one. Written back to the config file so it
 * survives a restart.
 */
/**
 * Ask an endpoint which chain it serves. A typo or a URL for the wrong network
 * would otherwise be stored and then silently break every balance read, so it
 * is checked before it is written rather than after it causes confusion.
 */
async function probeChainId(url: string): Promise<number> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!body.result) throw new Error(body.error?.message ?? "no chain id in the reply");
    return Number(BigInt(body.result));
  } finally {
    clearTimeout(timer);
  }
}

function saveExtraRpcs(urls: string[]): string[] {
  const clean: string[] = [];
  for (const u of urls) {
    const t = u.trim();
    if (!t) continue;
    let parsed: URL;
    try {
      parsed = new URL(t);
    } catch {
      throw new Error(`"${t.slice(0, 40)}" is not a URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("RPC endpoints must be http(s)");
    }
    if (!clean.includes(t)) clean.push(t);
  }
  if (clean.length > 8) throw new Error("that is more endpoints than is useful — keep it under eight");

  const abs = resolve(CONFIG_PATH);
  const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  raw.extraRpcs = clean;
  writeFileSync(abs, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  // Balances were read through the old endpoint; don't serve them as if they
  // came from the new one.
  balanceCache = null;
  return clean;
}

// ── Wallets ──────────────────────────────────────────────────────────────────
/**
 * Wallet management is deliberately write-only: keys go in, and only addresses
 * come back. Even with the token, this API cannot be used to read out a key
 * that is already on the box.
 */
function writeKeys(entries: KeyEntry[]) {
  const cfg = loadConfig(CONFIG_PATH);
  const abs = keysPath(CONFIG_PATH, cfg.keysFile);
  // 0600: readable only by the user running the server.
  writeFileSync(abs, serialiseKeys(entries), { mode: 0o600 });
}

/**
 * Balances are the expensive part of the wallet list, and two panels poll it
 * every few seconds. Serving a few-second-old number costs nothing and keeps a
 * hundred-wallet set from spending the endpoint's whole rate budget on a view.
 */
const BALANCE_TTL_MS = 10_000;
let balanceCache: { at: number; values: Map<string, string> } | null = null;

/** Addresses, labels and balances — never keys. */
async function walletsView() {
  const cfg = loadConfig(CONFIG_PATH);
  const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
  const info = getChainInfo(cfg.chainId);
  const addresses = entries.map((e) => ({
    address: privateKeyToAccount(e.key).address,
    label: e.label,
  }));

  let balances = new Map<string, string>();
  const fresh = balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS;
  if (fresh && balanceCache) {
    balances = balanceCache.values;
  } else if (info && addresses.length > 0) {
    try {
      const client = createPublicClient({
        chain: info.chain,
        transport: readTransport(readRpc(cfg, info)),
      });
      const got = await mapWithLimit(addresses, (a) => client.getBalance({ address: a.address }));
      balances = new Map(addresses.map((a, i) => [a.address, formatEther(got[i])]));
      balanceCache = { at: Date.now(), values: balances };
    } catch (e) {
      // Balances are a nicety; the list itself must still render. Say why once
      // so a rate limit doesn't look like the wallets have no money.
      log(`balances unavailable: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      balances = balanceCache?.values ?? new Map();
    }
  }

  if (balances.size === 0 && info && addresses.length > 0 && cfg.extraRpcs.length > 0) {
    // The configured endpoint let us down; the chain's own RPC is slower and
    // metered, but it is better than a list of dashes.
    try {
      const client = createPublicClient({
        chain: info.chain,
        transport: readTransport(info.chain.rpcUrls.default.http[0]),
      });
      const got = await mapWithLimit(addresses, (a) => client.getBalance({ address: a.address }));
      balances = new Map(addresses.map((a, i) => [a.address, formatEther(got[i])]));
      balanceCache = { at: Date.now(), values: balances };
    } catch {
      // Nothing more to try.
    }
  }

  return {
    chainId: cfg.chainId,
    chain: info?.label,
    readRpc: info ? rpcHost(readRpc(cfg, info)) : null,
    wallets: addresses.map((a) => ({ ...a, balance: balances.get(a.address) ?? null })),
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
  let keys = loadKeys(CONFIG_PATH, loadConfig(CONFIG_PATH).keysFile);
  if (job.wallets && job.wallets.length > 0) {
    const want = new Set(job.wallets);
    keys = keys.filter((k) => want.has(privateKeyToAccount(k).address.toLowerCase()));
    if (keys.length === 0) {
      job.status = "error";
      job.error = "none of the wallets chosen for this job are on the server any more";
      activeJobId = null;
      return;
    }
  }
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
  await consolidate(job);
  await notify(job);
}

/**
 * Move what this run just minted onto one wallet, when the config asks for it.
 * The token ids come from the receipts the run already decoded, so this needs
 * no holdings lookup and can't pick up anything the run didn't mint.
 */
async function consolidate(job: Job) {
  if (job.request.dryRun) return;
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch {
    return;
  }
  const to = cfg.consolidateTo;
  if (!to) return;

  const outcomes = job.result?.outcomes ?? [];
  const collection = job.request.collection;
  const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
  const keyByAddress = new Map(
    entries.map((e) => [privateKeyToAccount(e.key).address.toLowerCase(), e.key] as const),
  );

  const holdings = outcomes
    .filter((o) => o.status === "mined" && (o.tokenIds?.length ?? 0) > 0)
    // A wallet that is itself the destination has nothing to move.
    .filter((o) => o.address.toLowerCase() !== to.toLowerCase())
    .map((o) => ({
      key: keyByAddress.get(o.address.toLowerCase()),
      items: (o.tokenIds ?? []).map((tokenId) => ({ collection, tokenId })),
    }))
    .filter((h): h is { key: `0x${string}`; items: { collection: `0x${string}`; tokenId: string }[] } =>
      Boolean(h.key),
    );

  if (holdings.length === 0) return;
  try {
    const r = await sweepNfts(
      {
        chainId: job.request.chainId,
        extraRpcs: job.request.extraRpcs,
        gas: { maxFeeGwei: job.request.gas.maxFeeGwei, tipGwei: job.request.gas.tipGwei },
        holdings,
        to,
        dryRun: false,
      },
      (line) => {
        const entry = `[${stamp()}] consolidate: ${line}`;
        job.logs.push(entry);
        console.log(entry);
      },
    );
    job.consolidated = { to, moved: r.moved, total: r.total };
  } catch (e) {
    // A failed sweep must not turn a successful mint into a failed job — the
    // tokens are minted either way and can be swept by hand.
    const msg = e instanceof Error ? e.message : String(e);
    job.logs.push(`[${stamp()}] consolidate failed: ${msg}`);
    log(`consolidate failed for job ${job.id}: ${msg}`);
  }
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
    json(res, 200, { ok: true, service: "launchpad-snipe", apiVersion: API_VERSION });
    return;
  }

  if (!tokenOk(req.headers.authorization)) {
    json(res, 401, { error: "bad or missing token" });
    return;
  }

  try {
    if (url.pathname === "/api/status" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      json(res, 200, {
        apiVersion: API_VERSION,
        running: activeJobId !== null,
        activeJobId,
        armLeadMs: ARM_LEAD_MS,
        // Hosts only — the full URLs carry provider API keys.
        rpcHosts: cfg.extraRpcs.map(rpcHost),
        readRpc: info ? rpcHost(readRpc(cfg, info)) : null,
        jobs: jobs.map(jobView),
      });
      return;
    }

    /**
     * Pull the latest code and restart. Refused while a job is armed or
     * running — a restart mid-mint would lose it.
     */
    if (url.pathname === "/api/update" && req.method === "POST") {
      if (activeJobId) {
        json(res, 409, { error: "a job is running — wait for it or abort first" });
        return;
      }
      if (jobs.some((j) => j.status === "armed")) {
        json(res, 409, { error: "a job is armed and about to fire — update after it runs" });
        return;
      }
      const result = await selfUpdate();
      log(`update: ${result.before} → ${result.after} (${result.detail})`);
      json(res, 200, result);
      return;
    }

    /**
     * Store the endpoints the panel is using. Reads on the server (balances,
     * funding, sweeps) then go through the same paid endpoint instead of the
     * public one, which is what a hundred-wallet set needs to stay inside a
     * rate limit.
     */
    if (url.pathname === "/api/rpcs" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.extraRpcs)) throw new Error("extraRpcs must be a list of URLs");
      const wanted = (body.extraRpcs as unknown[]).filter((x): x is string => typeof x === "string");
      const chainId = loadConfig(CONFIG_PATH).chainId;
      for (const u of wanted) {
        let got: number;
        try {
          got = await probeChainId(u.trim());
        } catch (e) {
          throw new Error(
            `${rpcHost(u)} did not answer: ${e instanceof Error ? e.message : e}`,
          );
        }
        if (got !== chainId) {
          throw new Error(`${rpcHost(u)} serves chain ${got}, not ${chainId}`);
        }
      }
      const saved = saveExtraRpcs(wanted);
      log(`read/blast endpoints set to: ${saved.map(rpcHost).join(", ") || "(none)"}`);
      json(res, 200, { rpcHosts: saved.map(rpcHost) });
      return;
    }

    if (url.pathname === "/api/wallets" && req.method === "GET") {
      json(res, 200, await walletsView());
      return;
    }

    // Add wallets. Keys are accepted, stored, and never handed back.
    if (url.pathname === "/api/wallets" && req.method === "POST") {
      const body = await readBody(req);
      const raw = typeof body.keys === "string" ? body.keys : "";
      if (!raw.trim()) throw new Error("no keys supplied");

      const cfg = loadConfig(CONFIG_PATH);
      const existing = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      const have = new Set(existing.map((e) => e.key));
      const label = typeof body.label === "string" ? body.label.slice(0, 60) : undefined;

      let added = 0;
      const rejected: string[] = [];
      for (const line of raw.split(/[\s,]+/)) {
        const t = line.trim();
        if (!t) continue;
        let key: `0x${string}`;
        try {
          key = normalizePrivateKey(t);
        } catch {
          // Never echo the offending text back — it is a private key.
          rejected.push("not a valid 64-hex private key");
          continue;
        }
        if (have.has(key)) continue;
        have.add(key);
        existing.push({ key, label });
        added += 1;
      }
      if (added > 0) writeKeys(existing);
      log(`wallets: added ${added}${rejected.length ? `, rejected ${rejected.length}` : ""}`);
      json(res, 200, { added, rejected: rejected.length, ...(await walletsView()) });
      return;
    }

    // Removes one wallet (?address=) or a batch (JSON body {addresses:[…]}),
    // so clearing out a set doesn't mean one request per wallet.
    if (url.pathname === "/api/wallets" && req.method === "DELETE") {
      if (activeJobId) {
        json(res, 409, { error: "a job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const requested = Array.isArray(body.addresses)
        ? (body.addresses as unknown[]).filter((a): a is string => typeof a === "string")
        : [url.searchParams.get("address") ?? ""];

      const wanted = new Set<string>();
      for (const a of requested) {
        const lower = a.trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error(`"${a}" is not a 0x address`);
        wanted.add(lower);
      }
      if (wanted.size === 0) throw new Error("no addresses given");

      const cfg = loadConfig(CONFIG_PATH);
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      const kept = entries.filter(
        (e) => !wanted.has(privateKeyToAccount(e.key).address.toLowerCase()),
      );
      const removed = entries.length - kept.length;
      if (removed === 0) {
        json(res, 404, { error: "none of those addresses are on the server" });
        return;
      }
      writeKeys(kept);
      log(`wallets: removed ${removed} of ${wanted.size} requested`);
      json(res, 200, { removed, ...(await walletsView()) });
      return;
    }

    // ── NFTs: see what the wallet set holds, and gather it onto one wallet ──
    if (url.pathname === "/api/nfts" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info?.blockscoutApi) {
        throw new Error(
          `${info?.label ?? "this chain"} has no Blockscout API in the registry, so holdings ` +
            `can't be listed. A sweep straight after a mint still works — it uses the token ids ` +
            `from the receipt.`,
        );
      }
      const only = url.searchParams.get("collection");
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      const found = await Promise.all(
        entries.map((e) =>
          findHoldings(
            info.blockscoutApi!,
            privateKeyToAccount(e.key).address,
            only && /^0x[0-9a-fA-F]{40}$/.test(only) ? (only as `0x${string}`) : undefined,
          ).catch(() => [] as Holding[]),
        ),
      );
      const holdings = found.flat();
      json(res, 200, {
        chain: info.label,
        totalTokens: holdings.reduce((n, h) => n + h.tokenIds.length, 0),
        holdings,
      });
      return;
    }

    if (url.pathname === "/api/sweep-nfts" && req.method === "POST") {
      if (activeJobId) {
        json(res, 409, { error: "a mint job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("to must be a 0x address");
      const only =
        typeof body.collection === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.collection)
          ? (body.collection as `0x${string}`)
          : undefined;

      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info?.blockscoutApi) throw new Error("this chain has no Blockscout API to read holdings from");
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);

      const perWallet = await Promise.all(
        entries.map(async (e) => {
          const address = privateKeyToAccount(e.key).address;
          const held = await findHoldings(info.blockscoutApi!, address, only).catch(() => []);
          return {
            key: e.key,
            items: held.flatMap((h) =>
              // Never move a token to the wallet it already sits on.
              address.toLowerCase() === to.toLowerCase()
                ? []
                : h.tokenIds.map((tokenId) => ({ collection: h.collection, tokenId })),
            ),
          };
        }),
      );

      const result = await sweepNfts(
        {
          chainId: cfg.chainId,
          extraRpcs: cfg.extraRpcs,
          gas: { maxFeeGwei: cfg.gas.maxFeeGwei, tipGwei: cfg.gas.tipGwei },
          holdings: perWallet,
          to: to as `0x${string}`,
          dryRun: body.dryRun !== false,
        },
        (line) => log(`nft-sweep: ${line}`),
      );
      json(res, 200, result);
      return;
    }

    // ── Funding: fan money out to the wallet set, or sweep it back ──────────
    if (url.pathname === "/api/disperse" && req.method === "POST") {
      if (activeJobId) {
        json(res, 409, { error: "a mint job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req);
      const cfg = loadConfig(CONFIG_PATH);
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      if (entries.length === 0) throw new Error("no wallets on the server to fund");

      // The payer is either one of the stored wallets, or a one-off key that
      // is used for this call and never written anywhere.
      let fromKey: `0x${string}`;
      if (typeof body.fromKey === "string" && body.fromKey.trim()) {
        fromKey = normalizePrivateKey(body.fromKey);
      } else if (typeof body.fromAddress === "string") {
        const want = body.fromAddress.toLowerCase();
        const hit = entries.find((e) => privateKeyToAccount(e.key).address.toLowerCase() === want);
        if (!hit) throw new Error("that source wallet isn't on the server");
        fromKey = hit.key;
      } else {
        throw new Error("supply either fromKey (a one-off payer) or fromAddress (a stored wallet)");
      }

      const amount = typeof body.amountEth === "string" ? body.amountEth : "";
      if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error("amountEth must be a plain number");
      const amountWei = parseEther(amount);
      if (amountWei <= 0n) throw new Error("amountEth must be greater than zero");

      const payer = privateKeyToAccount(fromKey).address.toLowerCase();
      const targets = entries
        .map((e) => privateKeyToAccount(e.key).address)
        // Never send a wallet its own money.
        .filter((a) => a.toLowerCase() !== payer);
      if (targets.length === 0) throw new Error("no targets — the only wallet stored is the payer");

      const result = await disperse(
        {
          chainId: cfg.chainId,
          extraRpcs: cfg.extraRpcs,
          gas: { maxFeeGwei: cfg.gas.maxFeeGwei, tipGwei: cfg.gas.tipGwei },
          fromKey,
          targets,
          amountWei,
          skipIfAtLeastWei:
            typeof body.skipIfAtLeastEth === "string" && body.skipIfAtLeastEth
              ? parseEther(body.skipIfAtLeastEth)
              : undefined,
          dryRun: body.dryRun !== false,
        },
        (line) => log(`disperse: ${line}`),
      );
      json(res, 200, result);
      return;
    }

    if (url.pathname === "/api/collect" && req.method === "POST") {
      if (activeJobId) {
        json(res, 409, { error: "a mint job is running — wait for it or abort first" });
        return;
      }
      const body = await readBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("to must be a 0x address");

      const cfg = loadConfig(CONFIG_PATH);
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      if (entries.length === 0) throw new Error("no wallets on the server to sweep");

      const result = await collect(
        {
          chainId: cfg.chainId,
          extraRpcs: cfg.extraRpcs,
          gas: { maxFeeGwei: cfg.gas.maxFeeGwei, tipGwei: cfg.gas.tipGwei },
          keys: entries.map((e) => e.key),
          to: to as `0x${string}`,
          dryRun: body.dryRun !== false,
        },
        (line) => log(`collect: ${line}`),
      );
      json(res, 200, result);
      return;
    }

    // Queue a drop. This is the normal path — add ten of them hours ahead.
    if (url.pathname === "/api/queue" && req.method === "POST") {
      const body = await readBody(req);
      const request = buildRequest(body);
      const wallets = parseWalletFilter(body);
      if (wallets) {
        // Catch a stale selection now, while someone is watching, rather than
        // at fire time hours later when nobody is.
        const cfg = loadConfig(CONFIG_PATH);
        const have = new Set(
          loadKeyEntries(CONFIG_PATH, cfg.keysFile).map((e) =>
            privateKeyToAccount(e.key).address.toLowerCase(),
          ),
        );
        const missing = wallets.filter((a) => !have.has(a));
        if (missing.length === wallets.length) {
          throw new Error("none of the chosen wallets are on this server");
        }
        if (missing.length > 0) {
          log(`queue: ${missing.length} chosen wallet(s) are not on this server — ignoring them`);
        }
      }
      const job: Job = {
        id: randomUUID().slice(0, 8),
        label: typeof body.label === "string" && body.label ? body.label : request.collection.slice(0, 10),
        addedAt: Date.now(),
        status: "queued",
        request,
        wallets,
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
      const wallets = parseWalletFilter(body);
      if (wallets) {
        // Catch a stale selection now, while someone is watching, rather than
        // at fire time hours later when nobody is.
        const cfg = loadConfig(CONFIG_PATH);
        const have = new Set(
          loadKeyEntries(CONFIG_PATH, cfg.keysFile).map((e) =>
            privateKeyToAccount(e.key).address.toLowerCase(),
          ),
        );
        const missing = wallets.filter((a) => !have.has(a));
        if (missing.length === wallets.length) {
          throw new Error("none of the chosen wallets are on this server");
        }
        if (missing.length > 0) {
          log(`queue: ${missing.length} chosen wallet(s) are not on this server — ignoring them`);
        }
      }
      const job: Job = {
        id: randomUUID().slice(0, 8),
        label: typeof body.label === "string" && body.label ? body.label : request.collection.slice(0, 10),
        addedAt: Date.now(),
        status: "queued",
        request,
        wallets: parseWalletFilter(body),
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
