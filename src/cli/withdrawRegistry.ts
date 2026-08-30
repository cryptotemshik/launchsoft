/**
 * Where money is allowed to leave to.
 *
 * The policy (signPolicy.ts) refuses any transfer whose destination is not on
 * this list, so this list is the thing an attacker has to change before
 * stealing anything — which is exactly why changing it is slow and loud.
 *
 * A new address does not count until it has sat here for an hour. An attacker
 * with a stolen session can register their address, but the registration
 * fires a notification immediately and the money cannot follow for an hour —
 * the theft is visible before it is possible. The owner's own flow barely
 * notices: you register your cold wallet once, and from then on withdrawals
 * to it are instant.
 *
 * Two kinds of entry end up in the allowed set:
 *
 *   - instant ones, from the box's own configuration (`consolidateTo`, the
 *     SNIPE_WITHDRAW_TO env). Nothing that can be changed over the API is
 *     instant, which is the entire distinction. When accounts land, the
 *     address a person signs in with joins this tier — a session thief
 *     provably does not control that key.
 *   - registered ones, added over the API, that have outlived the delay.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RegisteredAddress {
  /** Lower-case 0x address. */
  address: string;
  label?: string;
  /** Unix ms when it was registered. The clock the delay runs on. */
  addedAt: number;
}

/** How long a freshly registered address waits before money may follow it. */
export const MATURE_MS = 60 * 60 * 1000;

export function registryPath(configPath: string): string {
  return `${resolve(configPath)}.withdraw.json`;
}

export function loadRegistry(configPath: string): RegisteredAddress[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath(configPath), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is RegisteredAddress =>
        !!v &&
        typeof v === "object" &&
        typeof (v as RegisteredAddress).address === "string" &&
        /^0x[0-9a-f]{40}$/.test((v as RegisteredAddress).address) &&
        typeof (v as RegisteredAddress).addedAt === "number",
    );
  } catch {
    return [];
  }
}

function save(configPath: string, list: RegisteredAddress[]): void {
  const target = registryPath(configPath);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** Register an address. Re-registering does not reset its clock. */
export function registerAddress(
  configPath: string,
  address: string,
  label: string | undefined,
  nowMs: number,
): { added: boolean; list: RegisteredAddress[] } {
  const lower = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error(`"${address}" is not a 0x address`);
  const list = loadRegistry(configPath);
  if (list.some((r) => r.address === lower)) return { added: false, list };
  const next = [...list, { address: lower, label: label?.slice(0, 60), addedAt: nowMs }];
  save(configPath, next);
  return { added: true, list: next };
}

export function removeAddress(
  configPath: string,
  address: string,
): { removed: boolean; list: RegisteredAddress[] } {
  const lower = address.toLowerCase();
  const list = loadRegistry(configPath);
  const next = list.filter((r) => r.address !== lower);
  if (next.length === list.length) return { removed: false, list };
  save(configPath, next);
  return { removed: true, list: next };
}

/** The registered addresses that have outlived the delay, lower-case. */
export function maturedAddresses(configPath: string, nowMs: number): Set<string> {
  return new Set(
    loadRegistry(configPath)
      .filter((r) => nowMs - r.addedAt >= MATURE_MS)
      .map((r) => r.address),
  );
}

/** How each entry stands right now, for the panel that lists them. */
export function registryView(
  configPath: string,
  nowMs: number,
): (RegisteredAddress & { matured: boolean; readyInMs: number })[] {
  return loadRegistry(configPath).map((r) => ({
    ...r,
    matured: nowMs - r.addedAt >= MATURE_MS,
    readyInMs: Math.max(0, MATURE_MS - (nowMs - r.addedAt)),
  }));
}
