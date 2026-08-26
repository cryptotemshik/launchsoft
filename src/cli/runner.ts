/**
 * The snipe run itself, with no opinion about where it was started from.
 *
 * Both entry points share this: the CLI (`npm run snipe`) and the control
 * server (`npm run snipe:server`), so a run behaves identically whether it was
 * typed over SSH or triggered from the browser panel. Nothing here reads argv,
 * touches the filesystem, or prints — callers pass keys in and receive log
 * lines through `onLog`.
 *
 * Timing note: once `start()` returns and the run is holding for a stage, the
 * fire moment is decided by this machine's own clock. Whoever started the run
 * is not in the path — which is why a browser-triggered run is exactly as fast
 * as an SSH-triggered one.
 */
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  parseGwei,
  zeroAddress,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getChainInfo, type ChainInfo } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { pickFeeRecipient } from "../lib/collectionData";
import { checkEligibility, type Eligibility } from "../lib/allowlist";
import { fetchAllowListSource, gateKind } from "../lib/allowlistSource";
import {
  blastToAll,
  isAlreadyKnown,
  parseRpcEndpoints,
  prepareBlast,
  waitForReceiptOrNull,
  warmEndpoints,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { nodeSender, pooledSockets } from "./nodeSender";
import { mapWithLimit, readTransport } from "../lib/rpcRead";
import { waitUntil } from "../lib/snipeTimer";

export interface RunOptions {
  chainId: number;
  collection: `0x${string}`;
  stage: "public" | "allowlist";
  /**
   * NFTs per wallet, or "max" to take whatever the stage allows. "max" is the
   * useful setting for a queue, where each drop has its own per-wallet cap.
   */
  quantity: number | "max";
  keys: `0x${string}`[];
  extraRpcs: string[];
  gas: { maxFeeGwei: string; tipGwei: string; limit: number };
  timing: "now" | "wait";
  /** Read and plan, but broadcast nothing. */
  dryRun: boolean;
}

export interface WalletPlan {
  address: `0x${string}`;
  balanceWei: string;
  /** False in allowlist mode when the wallet isn't on the list. */
  firing: boolean;
  note?: string;
}

export interface RunPlan {
  chain: string;
  chainId: number;
  /** OpenSea slug, so callers can build item/profile links without the registry. */
  openSeaSlug: string;
  explorerUrl: string;
  collection: `0x${string}`;
  name: string;
  totalSupply: string;
  maxSupply: string;
  stage: "public" | "allowlist";
  priceWei: string;
  perWallet: number;
  quantity: number;
  startTime: number;
  endTime: number;
  endpoints: string[];
  wallets: WalletPlan[];
  baseFeeGwei: string;
}

export interface WalletOutcome {
  address: `0x${string}`;
  txHash?: string;
  status: "mined" | "reverted" | "rejected" | "timeout" | "skipped";
  detail?: string;
  /** Token ids this wallet actually received, decoded from the receipt. */
  tokenIds?: string[];
  /** What the transaction cost, so profit can be worked out later. */
  gasWei?: string;
  /** Mint price paid, in wei. Zero on a free drop. */
  valueWei?: string;
  blockNumber?: string;
}

/** ERC-721 Transfer(address,address,uint256). */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Ids minted to `to` in this receipt — mints are Transfers out of the zero address. */
function mintedIds(
  logs: readonly { address: string; topics: readonly string[] }[],
  collection: string,
  to: string,
): string[] {
  const toTopic = `0x${to.slice(2).toLowerCase().padStart(64, "0")}`;
  return logs
    .filter(
      (l) =>
        l.address.toLowerCase() === collection.toLowerCase() &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics[1] === ZERO_TOPIC &&
        l.topics[2]?.toLowerCase() === toTopic &&
        l.topics[3] !== undefined,
    )
    .map((l) => BigInt(l.topics[3]!).toString());
}

export interface RunResult {
  plan: RunPlan;
  /** Absent on a dry run. */
  outcomes?: WalletOutcome[];
}

export interface RunHooks {
  onLog: (line: string) => void;
  /** Aborts a run that is holding for a stage. */
  signal?: AbortSignal;
}

export interface DropState {
  name: string;
  totalSupply: bigint;
  maxSupply: bigint;
  price: bigint;
  startTime: number;
  endTime: number;
  perWallet: number;
  restrictFeeRecipients: boolean;
  allowedFeeRecipients: readonly string[];
}

/**
 * Everything the contract says about the drop.
 *
 * Exported because the queue wants it too: knowing the price, the supply and
 * when the stage opens *before* the job runs is what lets the panel show a
 * queue in the order it will actually fire, rather than the order someone
 * happened to add things in.
 */
export async function readDrop(
  client: PublicClient,
  info: ChainInfo,
  collection: `0x${string}`,
): Promise<DropState> {
  const read = <T,>(functionName: string): Promise<T> =>
    client.readContract({ address: collection, abi: tokenAbi, functionName } as never) as Promise<T>;
  const [name, totalSupply, maxSupply] = await Promise.all([
    read<string>("name"),
    read<bigint>("totalSupply"),
    read<bigint>("maxSupply"),
  ]);
  const [publicDrop, allowedFeeRecipients] = await Promise.all([
    client.readContract({
      address: info.seaDrop,
      abi: seaDropAbi,
      functionName: "getPublicDrop",
      args: [collection],
    }),
    client.readContract({
      address: info.seaDrop,
      abi: seaDropAbi,
      functionName: "getAllowedFeeRecipients",
      args: [collection],
    }),
  ]);
  return {
    name,
    totalSupply,
    maxSupply,
    price: publicDrop.mintPrice,
    startTime: Number(publicDrop.startTime),
    endTime: Number(publicDrop.endTime),
    perWallet: Number(publicDrop.maxTotalMintableByWallet),
    restrictFeeRecipients: publicDrop.restrictFeeRecipients,
    allowedFeeRecipients,
  };
}

export async function runSnipe(opts: RunOptions, hooks: RunHooks): Promise<RunResult> {
  const log = hooks.onLog;
  const accounts: PrivateKeyAccount[] = opts.keys.map((k) => privateKeyToAccount(k));
  if (accounts.length === 0) throw new Error("no wallets loaded");

  const info = getChainInfo(opts.chainId);
  if (!info) throw new Error(`chain ${opts.chainId} isn't in the registry (see src/chains.ts)`);

  // Reads go to a real RPC — never to a sequencer, which is send-only.
  const readUrl = opts.extraRpcs[0] ?? info.chain.rpcUrls.default.http[0];
  // Batched and 429-aware: arming a hundred wallets is a hundred balance reads
  // and a hundred nonce reads, and a provider's free tier meters per second.
  // An unthrottled burst here fails the arm, which loses the drop — two minutes
  // before it opens, with nobody watching.
  const client = createPublicClient({
    chain: info.chain,
    transport: readTransport(readUrl),
  }) as PublicClient;

  // Broadcast targets: sequencer first (shortest path into the ordering
  // queue), then the public RPC, then anything the caller added.
  const endpoints: RpcEndpoint[] = parseRpcEndpoints([
    ...(info.submitRpcs ?? []),
    ...info.chain.rpcUrls.default.http,
    ...opts.extraRpcs,
  ]);

  log(`chain      ${info.label} (${info.id})`);
  log(`wallets    ${accounts.length}`);
  log(`endpoints  ${endpoints.map((e) => e.label).join(", ")}`);

  const drop = await readDrop(client, info, opts.collection);
  log(`collection ${drop.name} — minted ${drop.totalSupply}/${drop.maxSupply}`);

  const feeRecipient = pickFeeRecipient(info, drop.allowedFeeRecipients, drop.restrictFeeRecipients);
  if (!feeRecipient) throw new Error("this drop restricts fee recipients and allows none — cannot mint");

  // ── Stage selection ─────────────────────────────────────────────────────
  let firing = accounts;
  const elig = new Map<string, Eligibility>();
  let price = drop.price;
  let perWallet = drop.perWallet;
  let startTime = drop.startTime;
  let endTime = drop.endTime;

  if (opts.stage === "allowlist") {
    const source = await fetchAllowListSource(client, info, opts.collection);
    const kind = gateKind(source);
    if (kind !== "merkle") {
      throw new Error(
        `this drop's restricted stage is "${kind}", which can't be built from on-chain data — ` +
          `only merkle allow-lists work here; mint that stage on opensea.io`,
      );
    }
    if (!source.list) throw new Error(source.problem ?? "allow-list document couldn't be read");
    for (const a of accounts) {
      elig.set(a.address.toLowerCase(), checkEligibility(source.list, a.address, source.root));
    }
    firing = accounts.filter((a) => elig.get(a.address.toLowerCase())?.eligible);
    if (firing.length === 0) throw new Error("none of the loaded wallets are on this drop's allow-list");
    const params = elig.get(firing[0].address.toLowerCase())!.params!;
    price = params.mintPrice;
    perWallet = Number(params.maxTotalMintableByWallet);
    startTime = Number(params.startTime);
    endTime = Number(params.endTime);
    log(`stage      allow-list — ${firing.length}/${accounts.length} wallets eligible`);
  } else {
    log("stage      public");
  }

  // The cap comes from the stage itself, so "max" needs no guessing — and a
  // number is clamped to it rather than sent to revert.
  let quantity: number;
  if (opts.quantity === "max") {
    if (!perWallet) throw new Error("this stage declares no per-wallet limit, so 'max' has no value to use");
    quantity = perWallet;
    log(`quantity   max allowed by the stage: ${quantity}`);
  } else {
    quantity = Math.min(opts.quantity, perWallet || opts.quantity);
    if (quantity < opts.quantity) {
      log(`note       quantity clamped to the stage's per-wallet cap (${perWallet})`);
    }
  }

  // ── Gas rails — the same ones the browser applies ───────────────────────
  const maxFeePerGas = parseGwei(opts.gas.maxFeeGwei);
  const maxPriorityFeePerGas = parseGwei(opts.gas.tipGwei);
  const gasLimit = BigInt(opts.gas.limit);
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error("tip cannot exceed max fee (EIP-1559)");
  const block = await client.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  if (maxFeePerGas < baseFee) {
    throw new Error(
      `max fee (${opts.gas.maxFeeGwei} gwei) is below the current base fee ` +
        `(${formatGwei(baseFee)} gwei) — every node would reject it`,
    );
  }
  log(`gas        max ${opts.gas.maxFeeGwei} / tip ${opts.gas.tipGwei} gwei · limit ${opts.gas.limit} · base now ${formatGwei(baseFee)}`);

  // ── Balances ────────────────────────────────────────────────────────────
  const needed = gasLimit * maxFeePerGas + price * BigInt(quantity);
  const balances = new Map<string, bigint>();
  const read = await mapWithLimit(accounts, (a) => client.getBalance({ address: a.address }), {
    onRetry: (ms) => log(`endpoint is rate-limiting reads — waiting ${ms}ms`),
  });
  accounts.forEach((a, i) => balances.set(a.address.toLowerCase(), read[i]));

  const wallets: WalletPlan[] = accounts.map((a) => {
    const isFiring = firing.some((f) => f.address === a.address);
    const bal = balances.get(a.address.toLowerCase()) ?? 0n;
    let note: string | undefined;
    if (!isFiring) note = "not on this drop's allow-list";
    else if (bal < needed) note = `can't cover ${formatEther(needed)} ETH — will be rejected`;
    if (isFiring && bal < needed) log(`WARN       ${a.address} ${note}`);
    return { address: a.address, balanceWei: bal.toString(), firing: isFiring, note };
  });

  const now = Math.floor(Date.now() / 1000);
  const plan: RunPlan = {
    chain: info.label,
    chainId: info.id,
    openSeaSlug: info.openSeaSlug,
    explorerUrl: info.explorerUrl,
    collection: opts.collection,
    name: drop.name,
    totalSupply: drop.totalSupply.toString(),
    maxSupply: drop.maxSupply.toString(),
    stage: opts.stage,
    priceWei: price.toString(),
    perWallet,
    quantity,
    startTime,
    endTime,
    endpoints: endpoints.map((e) => e.label),
    wallets,
    baseFeeGwei: formatGwei(baseFee),
  };

  log(
    `window     ${new Date(startTime * 1000).toISOString()} → ${new Date(endTime * 1000).toISOString()}` +
      (startTime > now ? ` (opens in ${startTime - now}s)` : now > endTime ? " (CLOSED)" : " (LIVE)"),
  );
  log(
    `plan       ${firing.length} wallet(s) × ${quantity} = ${firing.length * quantity} NFTs, ` +
      `${price === 0n ? "free" : `${formatEther(price * BigInt(quantity) * BigInt(firing.length))} ETH total`}`,
  );

  if (opts.dryRun) {
    log("DRY RUN — nothing was broadcast.");
    return { plan };
  }
  if (now > endTime) throw new Error("this stage has already closed");

  // ── Pre-sign, so the fire moment is pure network ────────────────────────
  const nonces = await mapWithLimit(
    firing,
    (a) => client.getTransactionCount({ address: a.address, blockTag: "pending" }),
    { onRetry: (ms) => log(`endpoint is rate-limiting nonce reads — waiting ${ms}ms`) },
  );
  const prepared = await Promise.all(
    firing.map(async (a, i) => {
      let data: Hex;
      let value: bigint;
      if (opts.stage === "allowlist") {
        const el = elig.get(a.address.toLowerCase())!;
        const qty = Math.min(quantity, Number(el.params!.maxTotalMintableByWallet) || quantity);
        data = encodeFunctionData({
          abi: seaDropAbi,
          functionName: "mintAllowList",
          args: [opts.collection, feeRecipient, zeroAddress, BigInt(qty), el.params!, el.proof!],
        });
        value = el.params!.mintPrice * BigInt(qty);
      } else {
        data = encodeFunctionData({
          abi: seaDropAbi,
          functionName: "mintPublic",
          args: [opts.collection, feeRecipient, zeroAddress, BigInt(quantity)],
        });
        value = drop.price * BigInt(quantity);
      }
      const rawTx = await a.signTransaction({
        chainId: info.id,
        to: info.seaDrop,
        data,
        value,
        nonce: nonces[i],
        maxFeePerGas,
        maxPriorityFeePerGas,
        gas: gasLimit,
        type: "eip1559",
      });
      return { address: a.address, blast: prepareBlast(rawTx) };
    }),
  );
  log(`signed     ${prepared.length} transaction(s) — nothing left to compute at fire time`);

  // A cold HTTPS request spends most of its time on DNS+TCP+TLS; that cost has
  // no business being on the critical path.
  // One socket per wallet, not one per endpoint: HTTP/1.1 cannot share a
  // connection between two requests in flight, so anything less leaves most of
  // the blast negotiating TLS at T-0.
  await warmEndpoints(endpoints, prepared.length, nodeSender);
  log(`warmed     ${pooledSockets()} connection(s) open for ${prepared.length} wallet(s)`);

  if (opts.timing === "wait" && startTime * 1000 > Date.now()) {
    log("waiting    holding until the stage opens…");
    const outcome = await waitUntil(startTime * 1000, {
      signal: hooks.signal,
      onApproach: () => {
        void warmEndpoints(endpoints, prepared.length, nodeSender);
        log("warming    re-opened connections (3s out)");
      },
    });
    if (outcome === "aborted") {
      log("ABORTED    cancelled before firing — nothing was broadcast");
      return { plan, outcomes: [] };
    }
  }

  // ── Fire ────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const fired = prepared.map(({ address, blast }) => ({
    address,
    txHash: blast.txHash,
    results: blastToAll(blast, endpoints, nodeSender).results,
  }));
  log(`FIRED      ${fired.length} transaction(s) dispatched in ${Date.now() - t0}ms`);
  for (const f of fired) log(`  ${f.address} → ${f.txHash}`);

  const outcomes: WalletOutcome[] = accounts
    .filter((a) => !firing.some((f) => f.address === a.address))
    .map((a) => ({ address: a.address, status: "skipped" as const, detail: "not on allow-list" }));

  await Promise.all(
    fired.map(async ({ address, txHash, results }) => {
      const settled = await results;
      const accepted = settled.some((r) => r.txHash !== null || isAlreadyKnown(r.error));
      if (!accepted) {
        const reasons = [...new Set(settled.map((r) => r.error).filter(Boolean))].join("; ");
        log(`REJECTED   ${address} — no endpoint took it: ${reasons}`);
        outcomes.push({ address, txHash, status: "rejected", detail: reasons });
        return;
      }
      const winner = settled.find((r) => r.txHash !== null);
      log(`accepted   ${address}${winner ? ` (first: ${winner.label})` : ""}`);
      const receipt = await waitForReceiptOrNull(client, txHash, 90_000);
      if (!receipt) {
        log(`TIMEOUT    ${address} — no receipt in 90s, check ${info.explorerUrl}/tx/${txHash}`);
        outcomes.push({ address, txHash, status: "timeout" });
        return;
      }
      const ok = receipt.status === "success";
      const ids = ok ? mintedIds(receipt.logs, opts.collection, address) : [];
      // Gas is charged whether the mint succeeded or reverted, so it counts
      // towards the cost either way — a run that reverted on twenty wallets
      // still spent twenty wallets' worth of gas.
      const gasWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas);
      log(
        `${ok ? "MINED     " : "REVERTED  "} ${address} — block ${receipt.blockNumber}, gas ${receipt.gasUsed}` +
          (ids.length ? ` — tokens ${ids.join(", ")}` : ""),
      );
      outcomes.push({
        address,
        txHash,
        status: ok ? "mined" : "reverted",
        tokenIds: ids,
        gasWei: gasWei.toString(),
        valueWei: ok ? (price * BigInt(quantity)).toString() : "0",
        blockNumber: receipt.blockNumber.toString(),
      });
    }),
  );

  log("done");
  return { plan, outcomes };
}
