/**
 * Moving ETH around the wallet set: fan money out before a mint, sweep it back
 * after.
 *
 * Both directions are the same shape as a snipe — sign everything first, then
 * blast every transaction at the sequencer at once — so a hundred transfers
 * take about as long as one round-trip rather than a hundred of them.
 *
 * The nonce rules differ between the two, and that difference is the whole
 * design:
 *   - disperse sends N transactions from ONE wallet, so nonces must run
 *     n, n+1, … n+N-1. They are still signed and fired together; the sequencer
 *     orders them and they all land.
 *   - collect sends one transaction from each of N wallets, so every nonce is
 *     independent and nothing has to be sequenced at all.
 */
import {
  createPublicClient,
  formatEther,
  http,
  parseGwei,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getChainInfo } from "../chains";
import {
  blastToAll,
  isAlreadyKnown,
  parseRpcEndpoints,
  prepareBlast,
  warmEndpoints,
  type RpcEndpoint,
} from "../lib/rpcBlast";

/** A plain ETH transfer costs 21000; the margin covers chain-specific extras. */
export const TRANSFER_GAS = 30_000n;

export interface TransferOutcome {
  address: `0x${string}`;
  txHash?: string;
  amountWei?: string;
  status: "sent" | "rejected" | "skipped";
  detail?: string;
}

export interface FundingGas {
  maxFeeGwei: string;
  tipGwei: string;
}

interface Ctx {
  client: PublicClient;
  endpoints: RpcEndpoint[];
  chainId: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

async function context(chainId: number, extraRpcs: string[], gas: FundingGas): Promise<Ctx> {
  const info = getChainInfo(chainId);
  if (!info) throw new Error(`chain ${chainId} isn't in the registry`);
  const readUrl = extraRpcs[0] ?? info.chain.rpcUrls.default.http[0];
  const client = createPublicClient({ chain: info.chain, transport: http(readUrl) }) as PublicClient;
  const endpoints = parseRpcEndpoints([
    ...(info.submitRpcs ?? []),
    ...info.chain.rpcUrls.default.http,
    ...extraRpcs,
  ]);
  const maxFeePerGas = parseGwei(gas.maxFeeGwei);
  const maxPriorityFeePerGas = parseGwei(gas.tipGwei);
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error("tip cannot exceed max fee");
  const block = await client.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  if (maxFeePerGas < baseFee) {
    throw new Error(
      `max fee (${gas.maxFeeGwei} gwei) is below the current base fee — every node would reject it`,
    );
  }
  return { client, endpoints, chainId, maxFeePerGas, maxPriorityFeePerGas };
}

/** Sign, blast, and report — shared by both directions. */
async function fire(
  ctx: Ctx,
  txs: { from: PrivateKeyAccount; to: `0x${string}`; value: bigint; nonce: number; tag: `0x${string}` }[],
  onLog: (s: string) => void,
): Promise<TransferOutcome[]> {
  const prepared = await Promise.all(
    txs.map(async (t) => {
      const raw = await t.from.signTransaction({
        chainId: ctx.chainId,
        to: t.to,
        value: t.value,
        nonce: t.nonce,
        gas: TRANSFER_GAS,
        maxFeePerGas: ctx.maxFeePerGas,
        maxPriorityFeePerGas: ctx.maxPriorityFeePerGas,
        type: "eip1559",
      });
      return { tag: t.tag, value: t.value, blast: prepareBlast(raw) };
    }),
  );
  onLog(`signed ${prepared.length} transfer(s)`);

  await warmEndpoints(ctx.endpoints);
  const t0 = Date.now();
  const fired = prepared.map((p) => ({ ...p, results: blastToAll(p.blast, ctx.endpoints).results }));
  onLog(`dispatched ${fired.length} transfer(s) in ${Date.now() - t0}ms`);

  return Promise.all(
    fired.map(async (f): Promise<TransferOutcome> => {
      const settled = await f.results;
      const ok = settled.some((r) => r.txHash !== null || isAlreadyKnown(r.error));
      if (!ok) {
        const reasons = [...new Set(settled.map((r) => r.error).filter(Boolean))].join("; ");
        return { address: f.tag, status: "rejected", detail: reasons, amountWei: f.value.toString() };
      }
      return {
        address: f.tag,
        txHash: f.blast.txHash,
        amountWei: f.value.toString(),
        status: "sent",
      };
    }),
  );
}

export interface DisperseOptions {
  chainId: number;
  extraRpcs: string[];
  gas: FundingGas;
  /** The wallet paying out. */
  fromKey: `0x${string}`;
  /** Wallets to top up. */
  targets: `0x${string}`[];
  /** Amount each target receives, in wei. */
  amountWei: bigint;
  /** Skip targets that already hold at least this much. */
  skipIfAtLeastWei?: bigint;
  dryRun: boolean;
}

export interface DisperseResult {
  from: `0x${string}`;
  fromBalanceWei: string;
  requiredWei: string;
  funded: number;
  skipped: number;
  outcomes: TransferOutcome[];
}

export async function disperse(
  opts: DisperseOptions,
  onLog: (s: string) => void,
): Promise<DisperseResult> {
  const ctx = await context(opts.chainId, opts.extraRpcs, opts.gas);
  const from = privateKeyToAccount(opts.fromKey);

  // Balances decide who actually needs money, so an aborted run can be
  // repeated without double-funding anyone.
  const balances = new Map<string, bigint>();
  await Promise.all(
    opts.targets.map(async (t) =>
      balances.set(t.toLowerCase(), await ctx.client.getBalance({ address: t })),
    ),
  );
  const threshold = opts.skipIfAtLeastWei ?? 0n;
  const needy = opts.targets.filter(
    (t) => (balances.get(t.toLowerCase()) ?? 0n) < threshold || threshold === 0n,
  );
  const skipped = opts.targets.length - needy.length;

  const perTxGas = TRANSFER_GAS * ctx.maxFeePerGas;
  const required = BigInt(needy.length) * (opts.amountWei + perTxGas);
  const fromBalance = await ctx.client.getBalance({ address: from.address });

  onLog(`from ${from.address} — holds ${formatEther(fromBalance)} ETH`);
  onLog(
    `targets ${needy.length}${skipped ? ` (${skipped} already funded, skipped)` : ""} × ` +
      `${formatEther(opts.amountWei)} ETH — needs ${formatEther(required)} ETH incl. gas`,
  );
  if (fromBalance < required) {
    throw new Error(
      `source wallet holds ${formatEther(fromBalance)} ETH but needs ${formatEther(required)} ETH`,
    );
  }
  if (needy.length === 0) {
    return {
      from: from.address,
      fromBalanceWei: fromBalance.toString(),
      requiredWei: required.toString(),
      funded: 0,
      skipped,
      outcomes: [],
    };
  }
  if (opts.dryRun) {
    onLog("DRY RUN — nothing was broadcast.");
    return {
      from: from.address,
      fromBalanceWei: fromBalance.toString(),
      requiredWei: required.toString(),
      funded: 0,
      skipped,
      outcomes: needy.map((t) => ({ address: t, status: "skipped", detail: "dry run" })),
    };
  }

  // One sender → sequential nonces, signed together and fired together.
  const startNonce = await ctx.client.getTransactionCount({
    address: from.address,
    blockTag: "pending",
  });
  const outcomes = await fire(
    ctx,
    needy.map((to, i) => ({
      from,
      to,
      value: opts.amountWei,
      nonce: startNonce + i,
      tag: to,
    })),
    onLog,
  );
  return {
    from: from.address,
    fromBalanceWei: fromBalance.toString(),
    requiredWei: required.toString(),
    funded: outcomes.filter((o) => o.status === "sent").length,
    skipped,
    outcomes,
  };
}

export interface CollectOptions {
  chainId: number;
  extraRpcs: string[];
  gas: FundingGas;
  /** Wallets to empty. */
  keys: `0x${string}`[];
  /** Where everything goes. */
  to: `0x${string}`;
  /** Don't bother with wallets holding less than this (dust). */
  minWei?: bigint;
  dryRun: boolean;
}

export interface CollectResult {
  to: `0x${string}`;
  swept: number;
  skipped: number;
  totalWei: string;
  outcomes: TransferOutcome[];
}

export async function collect(
  opts: CollectOptions,
  onLog: (s: string) => void,
): Promise<CollectResult> {
  const ctx = await context(opts.chainId, opts.extraRpcs, opts.gas);
  const accounts = opts.keys.map((k) => privateKeyToAccount(k));
  const reserve = TRANSFER_GAS * ctx.maxFeePerGas;
  const min = opts.minWei ?? reserve * 2n;

  const balances = await Promise.all(
    accounts.map(async (a) => ({ a, bal: await ctx.client.getBalance({ address: a.address }) })),
  );

  const outcomes: TransferOutcome[] = [];
  const sendable: { from: PrivateKeyAccount; value: bigint }[] = [];
  for (const { a, bal } of balances) {
    // A wallet can only send what's left after the fee it must reserve.
    const value = bal - reserve;
    if (bal < min || value <= 0n) {
      outcomes.push({
        address: a.address,
        status: "skipped",
        detail: bal === 0n ? "empty" : `only ${formatEther(bal)} ETH — below the dust floor`,
        amountWei: bal.toString(),
      });
      continue;
    }
    sendable.push({ from: a, value });
  }

  const total = sendable.reduce((n, s) => n + s.value, 0n);
  onLog(
    `sweeping ${sendable.length}/${accounts.length} wallet(s) → ${opts.to} — ${formatEther(total)} ETH`,
  );
  if (sendable.length === 0) return { to: opts.to, swept: 0, skipped: outcomes.length, totalWei: "0", outcomes };

  if (opts.dryRun) {
    onLog("DRY RUN — nothing was broadcast.");
    return {
      to: opts.to,
      swept: 0,
      skipped: outcomes.length,
      totalWei: total.toString(),
      outcomes: [
        ...outcomes,
        ...sendable.map((s) => ({
          address: s.from.address,
          status: "skipped" as const,
          detail: "dry run",
          amountWei: s.value.toString(),
        })),
      ],
    };
  }

  // Independent senders → independent nonces, nothing to sequence.
  const nonces = await Promise.all(
    sendable.map((s) =>
      ctx.client.getTransactionCount({ address: s.from.address, blockTag: "pending" }),
    ),
  );
  const sent = await fire(
    ctx,
    sendable.map((s, i) => ({
      from: s.from,
      to: opts.to,
      value: s.value,
      nonce: nonces[i],
      tag: s.from.address,
    })),
    onLog,
  );

  return {
    to: opts.to,
    swept: sent.filter((o) => o.status === "sent").length,
    skipped: outcomes.length,
    totalWei: total.toString(),
    outcomes: [...outcomes, ...sent],
  };
}
