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
import * as os from "node:os";
import { promisify } from "node:util";
import { createPublicClient, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { collect, disperse } from "./funding";
import { scanChain } from "./holdings";
import { costByCollection, loadMints, recordMint } from "./ledger";
import { priceTransfers, summarise } from "./profit";
import { loadCollections, rememberCollection } from "./collections";
import { sweepNfts, type Holding } from "./nftSweep";
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
import { currentTunnelUrl } from "./tunnelUrl";

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
/** Set to 0 to stop the server pulling its own updates. */
const AUTO_UPDATE = process.env.SNIPE_AUTO_UPDATE !== "0";
const AUTO_UPDATE_MS = Number(process.env.SNIPE_AUTO_UPDATE_MS ?? 3_600_000);
/**
 * How close to a queued drop is too close to restart. A job arms ARM_LEAD_MS
 * before its stage; leaving only that would mean updating seconds before the
 * pre-signing starts, which is the one moment worth protecting.
 */
const UPDATE_BLACKOUT_MS = ARM_LEAD_MS + 600_000;

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

/** Where the box is reachable, once the tunnel log has been read. */
let tunnelUrl: string | null = null;

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

/** Heap ceiling for the update's typecheck, so it cannot starve the box. */
const TSC_HEAP_MB = Number(process.env.SNIPE_TSC_HEAP_MB ?? 320);
/**
 * Headroom the typecheck needs beyond its own heap, for node itself.
 *
 * This used to be an absolute floor of 420MB of free RAM, which was a guess —
 * and on a 1GB instance the real figure sits around 380MB, so the guard
 * refused every update for eight hours running while reporting it as a memory
 * problem. The question is not "is there a lot of memory free" but "can a
 * capped typecheck run without the kernel having to kill something", and swap
 * counts towards that: it makes tsc slower, never fatal.
 */
const TSC_OVERHEAD_MB = Number(process.env.SNIPE_TSC_OVERHEAD_MB ?? 80);

/**
 * Memory a new process could actually use, in MB — free RAM plus free swap.
 *
 * `freemem()` reads far too low on Linux, where the page cache counts as used;
 * `availableMemory()` is what the kernel itself reports as usable. Swap is read
 * from /proc, since node exposes no API for it.
 */
function usableMemoryMb(): number {
  const ram =
    typeof (os as { availableMemory?: () => number }).availableMemory === "function"
      ? (os as unknown as { availableMemory: () => number }).availableMemory()
      : os.freemem();
  let swapFreeKb = 0;
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    swapFreeKb = Number(/SwapFree:\s+(\d+)/.exec(meminfo)?.[1] ?? 0);
  } catch {
    // Not Linux, or /proc unavailable: RAM alone then.
  }
  return Math.round(ram / 1024 / 1024 + swapFreeKb / 1024);
}

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

  const usable = usableMemoryMb();
  const needed = TSC_HEAP_MB + TSC_OVERHEAD_MB;
  if (usable < needed) {
    await run("git", ["reset", "--hard", before], { cwd: dir }).catch(() => {});
    throw new Error(
      `${usable}MB of memory usable but the check needs ${needed}MB, so ${after} was rolled ` +
        `back to ${before}. Add swap (setup-vps.sh does), or lower SNIPE_TSC_HEAP_MB.`,
    );
  }

  // Dependencies only need reinstalling when the lockfile actually moved.
  const { stdout: touched } = await run("git", ["diff", "--name-only", before, after], { cwd: dir });
  if (touched.split("\n").some((f) => f.trim() === "package-lock.json")) {
    log("update: lockfile changed — installing dependencies");
    await run("npm", ["install", "--silent"], { cwd: dir, timeout: 600_000 });
  }

  // Restarting into code that doesn't compile leaves pm2 in a crash loop with
  // nothing serving, which on an unattended box means the next drop is simply
  // missed. Check first, and put the checkout back if it fails.
  //
  // The check is capped and guarded because it is not free: tsc wants a few
  // hundred MB, and on a 1GB box the kernel's OOM killer resolves that by
  // killing something — which once took the Cloudflare tunnel with it and left
  // the machine unreachable. A verification step must never be able to cost
  // more than the thing it verifies.
  try {
    await run("npx", ["tsc", "--noEmit"], {
      cwd: dir,
      timeout: 300_000,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${TSC_HEAP_MB}`.trim() },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const first = `${err.stdout ?? ""}${err.stderr ?? ""}`.split("\n").find((l) => l.includes("error"));
    await run("git", ["reset", "--hard", before], { cwd: dir }).catch(() => {});
    throw new Error(
      `${after} does not compile, so it was rolled back to ${before} and nothing restarted` +
        (first ? ` — ${first.trim()}` : ""),
    );
  }

  // Answer before the restart tears this process down; pm2 brings it back and
  // the tunnel is a separate process, so the URL and token do not change.
  setTimeout(() => {
    log("update: restarting");
    run("pm2", ["restart", "snipe-api"]).catch(() => process.exit(0));
  }, 400);

  return { before, after, changed: true, detail, restarting: true };
}

/**
 * Why an update must not happen right now, or null if it may.
 *
 * A restart costs a few seconds of downtime, which is nothing except in the
 * window around a drop — so the rule is simply "only when the box has nothing
 * to do and nothing coming up soon".
 */
function updateBlockedBecause(): string | null {
  if (activeJobId) return "a job is running";
  if (jobs.some((j) => j.status === "armed")) return "a job is armed and about to fire";
  const soon = jobs.find(
    (j) =>
      j.status === "queued" &&
      j.startTime !== undefined &&
      j.startTime * 1000 - Date.now() <= UPDATE_BLACKOUT_MS,
  );
  if (soon) return `job ${soon.id} (${soon.label}) opens too soon`;
  return null;
}

/**
 * Pull updates on a timer so the box keeps in step with the published site
 * without anyone opening a terminal — the panel's button does the same thing,
 * but only while someone is looking at it.
 */
function startAutoUpdate() {
  if (!AUTO_UPDATE) {
    log("auto-update off (SNIPE_AUTO_UPDATE=0)");
    return;
  }
  const every =
    AUTO_UPDATE_MS >= 60_000
      ? `${Math.round(AUTO_UPDATE_MS / 60_000)} min`
      : `${Math.round(AUTO_UPDATE_MS / 1000)}s`;
  log(`auto-update every ${every} when idle`);
  const timer = setInterval(() => {
    const blocked = updateBlockedBecause();
    if (blocked) {
      log(`auto-update skipped — ${blocked}`);
      return;
    }
    void selfUpdate()
      .then((r) => {
        if (r.changed) log(`auto-update: ${r.before} → ${r.after} (${r.detail})`);
      })
      .catch((e) => log(`auto-update failed: ${e instanceof Error ? e.message : e}`));
  }, AUTO_UPDATE_MS);
  // Never hold the process open for this alone.
  timer.unref?.();
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
  const parts = formatMintReport({
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

  // In order, and one at a time: Telegram shows them in the order they arrive,
  // and the overview is only useful if it arrives first.
  let sent = 0;
  for (const part of parts) {
    const r = await sendTelegram(cfg.telegram, part);
    if (r.ok) sent += 1;
    else log(`telegram failed: ${r.error}`);
  }
  log(`telegram: ${sent}/${parts.length} message(s) sent for job ${job.id}`);
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
    // Remember what was minted, so a later "what do my wallets hold" needs no
    // index: reading Transfer logs is fast but has to be told which contract.
    if (!job.request.dryRun) {
      rememberCollection(CONFIG_PATH, {
        address: job.request.collection,
        name: result.plan.name,
      });
      // Gas spent is only in a receipt nobody will fetch again; write it down
      // now or the profit figure can never be worked out.
      recordMint(CONFIG_PATH, {
        at: Date.now(),
        collection: job.request.collection,
        collectionName: result.plan.name,
        chainId: result.plan.chainId,
        stage: result.plan.stage,
        wallets: (result.outcomes ?? []).map((o) => ({
          address: o.address,
          tokenIds: o.tokenIds ?? [],
          gasWei: o.gasWei ?? "0",
          valueWei: o.valueWei ?? "0",
          status: o.status,
        })),
      });
    }
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

/**
 * Find the address this box is reachable at and, if it has changed, say so in
 * Telegram.
 *
 * A quick tunnel gets a new random hostname every time cloudflared starts, and
 * prints it once. Without this, a tunnel restart silently cuts the panel off
 * and the new address is recoverable only from a terminal on the box — which
 * is exactly what someone with only a phone does not have. The last announced
 * URL is kept next to the config so a plain server restart stays quiet.
 */
const TUNNEL_STATE = () => `${resolve(CONFIG_PATH)}.tunnel`;

async function announceTunnel(): Promise<void> {
  const url = await currentTunnelUrl();
  tunnelUrl = url;
  if (!url) {
    log("tunnel URL unknown (no pm2 'tunnel' process, or it hasn't printed one)");
    return;
  }
  log(`tunnel     ${url}`);

  let previous: string | null = null;
  try {
    previous = readFileSync(TUNNEL_STATE(), "utf8").trim() || null;
  } catch {
    // First run — there is nothing to compare against, so announce it.
  }
  if (previous === url) return;

  try {
    writeFileSync(TUNNEL_STATE(), `${url}\n`, { mode: 0o600 });
  } catch {
    // Not being able to remember it only means we announce again next time.
  }

  const cfg = (() => {
    try {
      return loadConfig(CONFIG_PATH);
    } catch {
      return null;
    }
  })();
  if (!cfg?.telegram) return;
  const what = previous ? "changed" : "is";
  await sendTelegram(
    cfg.telegram,
    `<b>Server address ${what}</b>\n<code>${url}</code>\n\nPaste it into the panel's <b>server URL</b> field. Your token has not changed.`,
  ).catch(() => undefined);
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
        autoUpdate: AUTO_UPDATE ? AUTO_UPDATE_MS : null,
        // Hosts only — the full URLs carry provider API keys.
        tunnelUrl,
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
      const blocked = updateBlockedBecause();
      if (blocked) {
        json(res, 409, { error: `${blocked} — a restart now could cost you the mint` });
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
    /**
     * What each drop cost and what it has made, from the chain alone.
     *
     * Cost comes from the ledger the runner writes as it mints; revenue from
     * pairing every departure of a token with the seller's balance rise in
     * that block. No marketplace API, so nothing to key or to break.
     */
    if (url.pathname === "/api/profit" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);

      const started = Date.now();
      const addresses = loadKeyEntries(CONFIG_PATH, cfg.keysFile).map(
        (e) => privateKeyToAccount(e.key).address,
      );
      const costs = costByCollection(loadMints(CONFIG_PATH));
      const known = loadCollections(CONFIG_PATH);

      const client = createPublicClient({
        chain: info.chain,
        transport: readTransport(readRpc(cfg, info)),
      });

      // One scan covers every collection these wallets have ever touched, so
      // a drop shows up here whether or not it was minted through this server
      // — the ledger only supplies what it cost.
      const scan = await scanChain(client as never, addresses);
      const sales = await priceTransfers(client as never, scan.sent, addresses);
      const salesByCollection = new Map<string, typeof sales>();
      for (const sale of sales) {
        const key = sale.collection.toLowerCase();
        salesByCollection.set(key, [...(salesByCollection.get(key) ?? []), sale]);
      }

      const seen = new Set<string>([
        ...scan.collections.map((c) => c.collection.toLowerCase()),
        ...costs.keys(),
        ...known.map((k) => k.address.toLowerCase()),
      ]);

      const reports = [...seen].map((key) => {
        const held = scan.collections.find((c) => c.collection.toLowerCase() === key);
        const cost = costs.get(key);
        const address = (held?.collection ??
          cost?.collection ??
          known.find((k) => k.address.toLowerCase() === key)!.address) as `0x${string}`;
        const mine = salesByCollection.get(key) ?? [];
        const report = summarise(
          address,
          {
            gasWei: cost?.gasWei ?? 0n,
            priceWei: cost?.priceWei ?? 0n,
            tokens: cost?.tokens ?? 0,
            wallets: cost?.wallets ?? 0,
          },
          mine,
          held?.totalTokens ?? 0,
          held?.name ?? cost?.collectionName,
        );
        return {
          ...report,
          cost: {
            gasWei: report.cost.gasWei.toString(),
            priceWei: report.cost.priceWei.toString(),
            tokens: report.cost.tokens,
            wallets: report.cost.wallets,
          },
          revenueWei: report.revenueWei.toString(),
          netWei: report.netWei.toString(),
          sales: report.sales.map((x) => ({
            ...x,
            blockNumber: x.blockNumber.toString(),
            proceedsWei: x.proceedsWei.toString(),
          })),
          unpricedSales: report.unpricedSales,
          runs: cost?.runs ?? 0,
          lastAt: cost?.lastAt,
        };
      });
      // Biggest position first — that is the one worth reading.
      reports.sort((a, b) => b.heldTokens + b.soldTokens - (a.heldTokens + a.soldTokens));

      json(res, 200, {
        chain: info.label,
        explorerUrl: info.explorerUrl,
        openSeaSlug: info.openSeaSlug,
        wallets: addresses.length,
        collections: reports,
        tookMs: Date.now() - started,
      });
      return;
    }

    if (url.pathname === "/api/nfts" && req.method === "GET") {
      const cfg = loadConfig(CONFIG_PATH);
      const info = getChainInfo(cfg.chainId);
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);

      const onlyRaw = url.searchParams.get("collection");
      const only =
        onlyRaw && /^0x[0-9a-fA-F]{40}$/.test(onlyRaw) ? (onlyRaw as `0x${string}`) : undefined;

      const addresses = loadKeyEntries(CONFIG_PATH, cfg.keysFile).map(
        (e) => privateKeyToAccount(e.key).address,
      );
      const started = Date.now();
      const client = createPublicClient({
        chain: info.chain,
        transport: readTransport(readRpc(cfg, info)),
      });

      // Two queries cover every wallet and every collection, so there is
      // nothing to discover first and nothing that can be missed.
      const scan = await scanChain(client as never, addresses, { collection: only });
      const tookMs = Date.now() - started;
      log(
        `nft scan: ${addresses.length} wallets → ${scan.totalTokens} tokens across ` +
          `${scan.collections.length} collection(s) in ${tookMs}ms`,
      );

      json(res, 200, {
        chain: info.label,
        explorerUrl: info.explorerUrl,
        openSeaSlug: info.openSeaSlug,
        checked: addresses.length,
        withTokens: scan.walletsWithTokens,
        totalTokens: scan.totalTokens,
        collections: scan.collections.map((c) => ({
          collection: c.collection,
          name: c.name,
          totalTokens: c.totalTokens,
          wallets: c.wallets,
        })),
        // Flat shape too, so the sweep panel keeps working unchanged.
        holdings: scan.collections.flatMap((c) =>
          c.wallets.map((w) => ({
            wallet: w.wallet,
            collection: c.collection,
            collectionName: c.name,
            tokenIds: w.tokenIds,
          })),
        ),
        tookMs,
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
      if (!info) throw new Error(`chain ${cfg.chainId} isn't in the registry`);
      const entries = loadKeyEntries(CONFIG_PATH, cfg.keysFile);
      const addresses = entries.map((e) => privateKeyToAccount(e.key).address);

      // One scan for every wallet and every collection, so a sweep can't move
      // what it happened to see and silently leave the rest.
      const client = createPublicClient({
        chain: info.chain,
        transport: readTransport(readRpc(cfg, info)),
      });
      const scan = await scanChain(client as never, addresses, { collection: only });

      const byWallet = new Map<string, Holding[]>();
      for (const c of scan.collections) {
        for (const w of c.wallets) {
          const list = byWallet.get(w.wallet.toLowerCase()) ?? [];
          list.push({
            wallet: w.wallet,
            collection: c.collection,
            collectionName: c.name,
            tokenIds: w.tokenIds,
          });
          byWallet.set(w.wallet.toLowerCase(), list);
        }
      }

      const perWallet = entries.map((e) => {
        const address = privateKeyToAccount(e.key).address;
        const held = byWallet.get(address.toLowerCase()) ?? [];
        return {
          key: e.key,
          items: held.flatMap((h) =>
            // Never move a token to the wallet it already sits on.
            address.toLowerCase() === to.toLowerCase()
              ? []
              : h.tokenIds.map((tokenId) => ({ collection: h.collection, tokenId })),
          ),
        };
      });
      log(
        `sweep: ${perWallet.reduce((n, p) => n + p.items.length, 0)} token(s) to move ` +
          `from ${perWallet.filter((p) => p.items.length > 0).length} wallet(s)`,
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
  startAutoUpdate();
  void announceTunnel();
});
