/**
 * Config loading for the headless snipe runner.
 *
 * Everything the browser tab asks for interactively lives in a JSON file here,
 * so the runner can sit on a VPS under pm2 with no terminal attached. Keys are
 * deliberately NOT part of that file: they live in their own file (gitignored),
 * one per line, so the config can be edited, copied or pasted into a support
 * thread without leaking a wallet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePrivateKey } from "../lib/convert";

export interface SnipeConfig {
  /** Chain id from the registry (4663 = Robinhood Chain). */
  chainId: number;
  /** Collection contract to mint. */
  collection: `0x${string}`;
  /** Which stage to mint. */
  stage: "public" | "allowlist";
  /** NFTs per wallet. */
  quantity: number;
  /** Path to the private-key file, relative to the config file. */
  keysFile: string;
  /** Extra RPC endpoints to blast alongside the chain's own. */
  extraRpcs: string[];
  gas: {
    maxFeeGwei: string;
    tipGwei: string;
    limit: number;
  };
  /** "wait" holds until the stage opens; "now" fires immediately. */
  timing: "now" | "wait";
  /** Optional Telegram bot for run summaries. Server-side only. */
  telegram?: { botToken: string; chatId: string };
}

const DEFAULTS = {
  stage: "public" as const,
  quantity: 1,
  extraRpcs: [] as string[],
  gas: { maxFeeGwei: "2", tipGwei: "0.05", limit: 250_000 },
  timing: "wait" as const,
};

function fail(msg: string): never {
  throw new Error(`config: ${msg}`);
}

export function loadConfig(path: string): SnipeConfig {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    fail(
      `couldn't read ${abs} (${e instanceof Error ? e.message : e}). ` +
        `Copy snipe.config.example.json to snipe.config.json and edit it.`,
    );
  }
  const c = raw as Partial<SnipeConfig> & Record<string, unknown>;

  if (typeof c.chainId !== "number") fail("chainId is required (4663 = Robinhood Chain)");
  if (typeof c.collection !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.collection)) {
    fail("collection must be a 0x contract address");
  }
  if (typeof c.keysFile !== "string" || !c.keysFile) fail("keysFile is required");

  const stage = c.stage ?? DEFAULTS.stage;
  if (stage !== "public" && stage !== "allowlist") fail('stage must be "public" or "allowlist"');

  const timing = c.timing ?? DEFAULTS.timing;
  if (timing !== "now" && timing !== "wait") fail('timing must be "now" or "wait"');

  const quantity = c.quantity ?? DEFAULTS.quantity;
  if (!Number.isInteger(quantity) || quantity < 1) fail("quantity must be a whole number ≥ 1");

  const gas = { ...DEFAULTS.gas, ...(c.gas ?? {}) };
  if (!Number.isInteger(gas.limit) || gas.limit <= 0) fail("gas.limit must be a positive integer");

  // Env wins over the file, so the bot token can stay out of the config
  // entirely on a shared box.
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? c.telegram?.botToken;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? c.telegram?.chatId;
  const telegram = botToken && chatId ? { botToken, chatId } : undefined;

  return {
    telegram,
    chainId: c.chainId,
    collection: c.collection as `0x${string}`,
    stage,
    quantity,
    keysFile: c.keysFile,
    extraRpcs: Array.isArray(c.extraRpcs) ? c.extraRpcs.filter((x) => typeof x === "string") : DEFAULTS.extraRpcs,
    gas,
    timing,
  };
}

/**
 * Read private keys, one per line. Blank lines and `#` comments are ignored so
 * wallets can be labelled and temporarily disabled without deleting them.
 * Duplicates are dropped — the same wallet twice would just nonce-clash.
 */
export function loadKeys(configPath: string, keysFile: string): `0x${string}`[] {
  const abs = resolve(resolve(configPath), "..", keysFile);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    fail(`couldn't read keys file ${abs} (${e instanceof Error ? e.message : e})`);
  }
  const out: `0x${string}`[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    const trimmed = line.split("#")[0].trim();
    if (!trimmed) return;
    let key: `0x${string}`;
    try {
      key = normalizePrivateKey(trimmed);
    } catch (e) {
      fail(`${abs}:${i + 1} — ${e instanceof Error ? e.message : e}`);
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  });
  if (out.length === 0) fail(`no keys found in ${abs}`);
  return out;
}
