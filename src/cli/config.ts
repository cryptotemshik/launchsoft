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
  /**
   * When set, freshly minted tokens are moved to this address as soon as a run
   * finishes — so a twenty-wallet mint ends up listable from one wallet.
   */
  consolidateTo?: `0x${string}`;
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

  const consolidateTo = process.env.CONSOLIDATE_TO ?? c.consolidateTo;
  if (consolidateTo && !/^0x[0-9a-fA-F]{40}$/.test(consolidateTo)) {
    fail("consolidateTo must be a 0x address");
  }

  return {
    telegram,
    consolidateTo: consolidateTo as `0x${string}` | undefined,
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

/** Absolute path of the keys file named by a config. */
export function keysPath(configPath: string, keysFile: string): string {
  return resolve(resolve(configPath), "..", keysFile);
}

export interface KeyEntry {
  key: `0x${string}`;
  /** Free-text label from the trailing `# comment`, if any. */
  label?: string;
}

/**
 * Parse the keys file: one key per line, an optional `# label` after it.
 * Blank lines and comment-only lines are skipped, so a wallet can be labelled
 * or temporarily commented out without deleting it. Duplicates are dropped —
 * the same wallet twice would just nonce-clash with itself.
 */
export function parseKeysFile(text: string, where = "keys"): KeyEntry[] {
  const out: KeyEntry[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    const hash = line.indexOf("#");
    const keyPart = (hash === -1 ? line : line.slice(0, hash)).trim();
    const label = hash === -1 ? undefined : line.slice(hash + 1).trim() || undefined;
    if (!keyPart) return;
    let key: `0x${string}`;
    try {
      key = normalizePrivateKey(keyPart);
    } catch (e) {
      fail(`${where}:${i + 1} — ${e instanceof Error ? e.message : e}`);
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, label });
  });
  return out;
}

/** Serialise entries back to the file format, labels preserved. */
export function serialiseKeys(entries: KeyEntry[]): string {
  const header =
    "# Private keys, one per line, optional `# label` after each.\n" +
    "# Managed by the Wallets tab; hand edits are preserved.\n";
  return `${header}${entries.map((e) => (e.label ? `${e.key}  # ${e.label}` : e.key)).join("\n")}\n`;
}

export function loadKeyEntries(configPath: string, keysFile: string): KeyEntry[] {
  const abs = keysPath(configPath, keysFile);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    // A missing file just means "no wallets yet" — the Wallets tab creates it.
    return [];
  }
  return parseKeysFile(text, abs);
}

export function loadKeys(configPath: string, keysFile: string): `0x${string}`[] {
  const entries = loadKeyEntries(configPath, keysFile);
  if (entries.length === 0) {
    fail(`no keys found in ${keysPath(configPath, keysFile)} — add wallets first`);
  }
  return entries.map((e) => e.key);
}
