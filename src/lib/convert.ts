import { formatEther, parseEther } from "viem";

/** Field bounds from SeaDrop's PublicDrop struct (packed sizes). */
export const UINT80_MAX = (1n << 80n) - 1n;
export const UINT48_MAX = 2 ** 48 - 1;
export const UINT16_MAX = 2 ** 16 - 1;

/**
 * Parse a user-typed ETH amount ("0.02", "0", ".5") into wei.
 * Throws with a readable message on anything else — there are no $ prices
 * on-chain, ETH only.
 */
export function ethToWei(input: string): bigint {
  const trimmed = input.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error(`"${input}" is not a valid ETH amount`);
  }
  const wei = parseEther(trimmed);
  if (wei < 0n) throw new Error("Price cannot be negative");
  if (wei > UINT80_MAX) {
    throw new Error("Price exceeds uint80 (SeaDrop's PublicDrop.mintPrice)");
  }
  return wei;
}

export function weiToEth(wei: bigint): string {
  return formatEther(wei);
}

/**
 * A datetime-local input value ("2026-08-20T21:00") is wall-clock time in the
 * user's timezone; Date parses it exactly that way.
 */
export function datetimeLocalToUnix(value: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`"${value}" is not a valid date/time`);
  const unix = Math.floor(ms / 1000);
  if (unix <= 0 || unix > UINT48_MAX) {
    throw new Error("Timestamp out of range for uint48");
  }
  return unix;
}

/** Render a unix timestamp in both the user's timezone and UTC — no confusion. */
export function unixToLocalAndUtc(unix: number): { local: string; utc: string } {
  const d = new Date(unix * 1000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const utc = d.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  return { local: `${local} (${tz})`, utc: `${utc} UTC` };
}

/** Now + N minutes as a datetime-local input value (local wall-clock). */
export function nowPlusMinutesLocalInput(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Compact "just now / 5m / 3h / 2d" from a unix-seconds timestamp. */
export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const secs = Math.floor(now / 1000) - unixSeconds;
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return "live now";
  const days = Math.floor(secondsLeft / 86_400);
  const hours = Math.floor((secondsLeft % 86_400) / 3_600);
  const mins = Math.floor((secondsLeft % 3_600) / 60);
  const secs = secondsLeft % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

/** 32-byte hex (provenance hash), with or without 0x prefix. */
export function normalizeProvenanceHash(input: string): `0x${string}` | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      "Provenance hash must be 32 bytes of hex (64 hex chars, e.g. a SHA-256)",
    );
  }
  return `0x${hex}`;
}

export function isAddress(input: string): input is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(input.trim());
}

/**
 * Normalize a pasted private key to 0x + 64 lowercase hex. Throws on anything
 * else. Used only by the in-memory local signer — the key is never persisted
 * or transmitted.
 */
export function normalizePrivateKey(raw: string): `0x${string}` {
  let s = raw.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error("Private key must be 64 hex characters (32 bytes), with or without 0x");
  }
  return `0x${s.toLowerCase()}` as `0x${string}`;
}

/**
 * Pull a contract address out of whatever the user pastes: a bare address, an
 * OpenSea collection/item URL, or a Blockscout address URL.
 */
export function parseCollectionInput(input: string): `0x${string}` | null {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return trimmed as `0x${string}`;
  const patterns = [
    // opensea.io/assets/robinhood/0x…[/tokenId], opensea.io/item/robinhood/0x…/1
    /opensea\.io\/(?:assets|item)\/[a-z0-9_-]+\/(0x[0-9a-fA-F]{40})/,
    // blockscout /address/0x… or /token/0x…
    /\/(?:address|token)\/(0x[0-9a-fA-F]{40})/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1] as `0x${string}`;
  }
  return null;
}
