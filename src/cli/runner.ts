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
import { readMintedCount } from "../lib/collectionData";
import { checkEligibility, type Eligibility } from "../lib/allowlist";
import { fetchAllowListSource, gateKind } from "../lib/allowlistSource";
import {
  blastToAll,
  isAlreadyKnown,
  parseRpcEndpoints,
  planWaves,
  prepareBlast,
  settleOrTimeout,
  waitForReceiptOrNull,
  warmEndpoints,
  type WarmReport,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { fileDescriptorLimit, nodeSender, pooledSockets } from "./nodeSender";
import { mapWithLimit, readTransport } from "../lib/rpcRead";
import { waitUntil } from "../lib/snipeTimer";
import { envNumber } from "../lib/envNumber";

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
/**
 * What to say when the warm-up did not get what it asked for.
 *
 * Silence here is the expensive kind: a blast whose connections were never
 * opened looks exactly like one whose were, right up until every unwarmed
 * wallet pays for a TLS handshake in the microseconds the whole design exists
 * to protect. Each of these names the cause and the fix, because the fix is
 * never in this program — it is a ulimit or an environment variable.
 */
export function warmWarnings(
  warm: WarmReport,
  wallets: number,
  endpointCount: number,
  /** Injected by tests; read from the running process otherwise. */
  descriptorLimit: number | null = fileDescriptorLimit(),
): string[] {
  const out: string[] = [];
  if (warm.capped) {
    out.push(
      `only ${warm.wanted} connection(s) per endpoint were opened for ${wallets} wallet(s) — ` +
        `the rest will negotiate TLS as they fire. Raise SNIPE_MAX_SOCKETS.`,
    );
  }
  const needed = wallets * endpointCount;
  const limit = descriptorLimit;
  // Descriptors are spent on more than these sockets, so the warning fires
  // before the limit is reached rather than once it already bites.
  if (limit !== null && Number.isFinite(limit) && needed > limit * 0.8) {
    out.push(
      `${wallets} wallet(s) × ${endpointCount} endpoint(s) wants ${needed} sockets, ` +
        `and this process may open ${limit} files. Raise it with "ulimit -n" ` +
        `before starting the runner, or the connections will not open.`,
    );
  }
  if (warm.short.length > 0) {
    const worst = warm.short
      .slice(0, 3)
      .map((e) => `${e.label} (${e.opened}/${warm.wanted})`)
      .join(", ");
    out.push(`some endpoints answered fewer warm-ups than asked: ${worst}`);
  }
  return out;
}

/**
 * How many wallets go in the first wave, and how long the rest will wait for
 * it. 100 is the measured knee: below it the head clears in single-digit
 * milliseconds, above it the head starts queueing behind itself. The gap is a
 * ceiling, not a delay — the tail leaves as soon as the head has answered.
 */
export function waveSize(): number {
  return envNumber(process.env.SNIPE_WAVE_SIZE, 100);
}
export function waveGapMs(): number {
  return envNumber(process.env.SNIPE_WAVE_GAP_MS, 40);
}

/** How often the public stage is re-read while a run holds for it to open. */
const RECHECK_MS = 5_000;
/** How long the fire moment will wait for a re-sign that is still in flight. */
const RESIGN_GRACE_MS = 1_500;

/** The part of a public stage that can move under a run that has already armed. */
export interface StageTerms {
  price: bigint;
  perWallet: number;
  startTime: number;
  endTime: number;
}

/** Read just those terms — one call, cheap enough to repeat every few seconds. */
export async function readPublicDrop(
  client: PublicClient,
  info: ChainInfo,
  collection: `0x${string}`,
): Promise<StageTerms> {
  const d = await client.readContract({
    address: info.seaDrop,
    abi: seaDropAbi,
    functionName: "getPublicDrop",
    args: [collection],
  });
  return {
    price: d.mintPrice,
    perWallet: Number(d.maxTotalMintableByWallet),
    startTime: Number(d.startTime),
    endTime: Number(d.endTime),
  };
}

/**
 * What a re-read of the stage means for a run that already signed against it.
 *
 * `resign` is the expensive answer and the important one: a price the wallets
 * no longer send, or a cap that changes how many NFTs the call asks for, makes
 * every signature on hand invalid. `retime` only moves the alarm clock.
 */
export function stageMove(
  armed: StageTerms,
  fresh: StageTerms,
  want: number | "max",
  nowSec: number,
): { retime: boolean; closed: boolean; resign: boolean; quantity: number } {
  return {
    retime: fresh.startTime !== armed.startTime,
    // endTime 0 is SeaDrop's "no end", not a stage that closed in 1970.
    closed: fresh.endTime !== 0 && nowSec > fresh.endTime,
    resign: fresh.price !== armed.price || fresh.perWallet !== armed.perWallet,
    quantity: want === "max" ? fresh.perWallet : Math.min(want, fresh.perWallet || want),
  };
}

/**
 * One signal that fires when either does — the caller's cancel, or our own
 * "the stage moved, restart the wait". Node's AbortSignal.any would do this,
 * but this keeps the file free of a runtime-version assumption.
 */
function eitherSignal(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const c = new AbortController();
  if (a.aborted || b.aborted) {
    c.abort();
    return c.signal;
  }
  const stop = () => c.abort();
  a.addEventListener("abort", stop, { once: true });
  b.addEventListener("abort", stop, { once: true });
  return c.signal;
}

export async function readDrop(
  client: PublicClient,
  info: ChainInfo,
  collection: `0x${string}`,
): Promise<DropState> {
  const read = <T,>(functionName: string): Promise<T> =>
    client.readContract({ address: collection, abi: tokenAbi, functionName } as never) as Promise<T>;
  const [name, totalSupply, maxSupply] = await Promise.all([
    read<string>("name"),
    readMintedCount(client, collection),
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
  // On a first-come-first-served chain the sequencer is the only endpoint that
  // decides ordering, so the first wave is aimed at it alone.
  const submitEndpoints = parseRpcEndpoints([...(info.submitRpcs ?? [])]);

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
  /**
   * Sign every wallet's transaction against a given price and quantity.
   *
   * A function rather than a one-off because the stage can move while we hold.
   * Signing a hundred wallets costs well under a tenth of a second, so doing
   * it again during an idle wait is free; doing it at fire time would not be,
   * which is why this is called before the hold and only repeated if the drop
   * actually changed.
   */
  const signAll = async (atPrice: bigint, atQuantity: number) =>
    Promise.all(
      firing.map(async (a, i) => {
        let data: Hex;
        let value: bigint;
        if (opts.stage === "allowlist") {
          const el = elig.get(a.address.toLowerCase())!;
          const qty = Math.min(atQuantity, Number(el.params!.maxTotalMintableByWallet) || atQuantity);
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
            args: [opts.collection, feeRecipient, zeroAddress, BigInt(atQuantity)],
          });
          value = atPrice * BigInt(atQuantity);
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

  let prepared = await signAll(price, quantity);
  log(`signed     ${prepared.length} transaction(s) — nothing left to compute at fire time`);

  // A cold HTTPS request spends most of its time on DNS+TCP+TLS; that cost has
  // no business being on the critical path.
  // One socket per wallet, not one per endpoint: HTTP/1.1 cannot share a
  // connection between two requests in flight, so anything less leaves most of
  // the blast negotiating TLS at T-0.
  const warm = await warmEndpoints(endpoints, prepared.length, nodeSender);
  log(
    `warmed     ${pooledSockets()} socket(s) open · ${warm.opened}/${warm.wanted * endpoints.length}` +
      ` connection(s) for ${prepared.length} wallet(s)`,
  );
  for (const line of warmWarnings(warm, prepared.length, endpoints.length)) log(`WARNING    ${line}`);

  // ── Hold — and keep reading the stage while we hold ─────────────────────
  // We arm minutes ahead, so the drop we signed against is not necessarily
  // the drop that opens. A creator who edits the stage during the hold —
  // raising a free mint to 0.0002 ETH is the case that actually cost us one —
  // leaves every pre-signed transaction carrying a value the contract no
  // longer accepts, and all of them revert on arrival having spent gas. So
  // re-read the stage while we wait, and re-sign whenever it moves.
  if (opts.timing === "wait" && startTime * 1000 > Date.now()) {
    log("waiting    holding until the stage opens…");
    let watching = true;
    let stopReason: string | null = null;
    // Rechecks are chained rather than run in parallel: two overlapping
    // re-signs could land out of order and leave `prepared` on the older
    // stage. Assignment itself is atomic, so a fire that races a recheck
    // sends a whole consistent set either way — never a half-updated one.
    let rechecks: Promise<void> = Promise.resolve();
    let retimed = new AbortController();

    const recheck = async (): Promise<void> => {
      if (!watching) return;
      let fresh: Awaited<ReturnType<typeof readPublicDrop>>;
      try {
        fresh = await readPublicDrop(client, info, opts.collection);
      } catch (e) {
        log(`recheck    couldn't re-read the stage (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — holding what we signed`);
        return;
      }
      if (!watching) return;
      const move = stageMove(
        { price, perWallet, startTime, endTime },
        fresh,
        opts.quantity,
        Math.floor(Date.now() / 1000),
      );
      if (move.retime) {
        log(
          `STAGE      start moved ${new Date(startTime * 1000).toISOString()} → ` +
            `${new Date(fresh.startTime * 1000).toISOString()} — re-timing the hold`,
        );
        startTime = fresh.startTime;
        plan.startTime = fresh.startTime;
        retimed.abort();
      }
      endTime = fresh.endTime;
      plan.endTime = fresh.endTime;
      if (move.closed) {
        stopReason = "the stage closed while we were holding";
        retimed.abort();
        return;
      }
      if (!move.resign) return;
      log(
        `STAGE      changed while holding — price ${formatEther(price)} → ${formatEther(fresh.price)} ETH, ` +
          `per wallet ${perWallet} → ${fresh.perWallet}`,
      );
      if (move.quantity < 1) {
        stopReason = "the stage now allows nothing per wallet";
        retimed.abort();
        return;
      }
      // The old signatures are worthless now, so an unaffordable new price is
      // worth saying out loud rather than discovering as N reverts.
      const costNow = gasLimit * maxFeePerGas + fresh.price * BigInt(move.quantity);
      const covered = firing.filter((a) => (balances.get(a.address.toLowerCase()) ?? 0n) >= costNow).length;
      if (covered === 0) {
        stopReason = `no loaded wallet can cover ${formatEther(costNow)} ETH at the new price`;
        retimed.abort();
        return;
      }
      if (covered < firing.length) {
        log(
          `WARNING    only ${covered}/${firing.length} wallet(s) can cover ${formatEther(costNow)} ETH ` +
            `at the new price — the rest will be rejected`,
        );
      }
      price = fresh.price;
      perWallet = fresh.perWallet;
      quantity = move.quantity;
      plan.priceWei = price.toString();
      plan.perWallet = perWallet;
      plan.quantity = quantity;
      prepared = await signAll(price, quantity);
      log(`re-signed  ${prepared.length} transaction(s) against the new stage`);
    };

    // An allow-list stage's terms come from the list document, not from the
    // public drop, so there is nothing here to re-read for it.
    const queueRecheck = () => {
      if (opts.stage !== "public") return;
      rechecks = rechecks.then(recheck).catch((e: unknown) => {
        log(`recheck    failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — holding what we signed`);
      });
    };

    let cancelled = false;
    while (true) {
      if (hooks.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (stopReason) break;
      const target = startTime * 1000;
      if (target <= Date.now()) break;
      retimed = new AbortController();
      const ticker = setInterval(queueRecheck, RECHECK_MS);
      const outcome = await waitUntil(target, {
        signal: eitherSignal(hooks.signal, retimed.signal),
        onApproach: () => {
          void warmEndpoints(endpoints, prepared.length, nodeSender);
          log("warming    re-opened connections (3s out)");
          queueRecheck();
        },
      });
      clearInterval(ticker);
      if (outcome === "aborted" && !retimed.signal.aborted) {
        cancelled = true;
        break;
      }
      // Otherwise the stage was re-timed under us: loop against the new target.
    }
    watching = false;
    // Never fire mid-resign, and never let a hung read hold the drop hostage:
    // `prepared` is always a complete set, so the worst a timeout costs is
    // firing the set we already had.
    await Promise.race([rechecks, new Promise<void>((r) => setTimeout(r, RESIGN_GRACE_MS))]);

    if (stopReason) {
      log(`ABORTED    ${stopReason} — nothing was broadcast`);
      return { plan, outcomes: [] };
    }
    if (cancelled) {
      log("ABORTED    cancelled before firing — nothing was broadcast");
      return { plan, outcomes: [] };
    }
  }

  // ── Fire ────────────────────────────────────────────────────────────────
  const wave = planWaves(prepared.length, endpoints, submitEndpoints, {
    headSize: waveSize(),
    maxGapMs: waveGapMs(),
  });
  if (wave.head > 0 && (wave.head < prepared.length || wave.catchUpEndpoints.length > 0)) {
    log(
      `waves      first ${wave.head} wallet(s) → ${wave.headEndpoints.map((e) => e.label).join(", ")}` +
        (wave.head < prepared.length ? `, then ${prepared.length - wave.head} more → all` : "") +
        ` (SNIPE_WAVE_SIZE / SNIPE_WAVE_GAP_MS)`,
    );
  }

  const t0 = Date.now();
  const head = prepared.slice(0, wave.head);
  const tail = prepared.slice(wave.head);

  // Wave one: the wallets that are actually racing, on the shortest path in,
  // with nothing else queued ahead of them.
  const headFired = head.map(({ address, blast }) => ({
    address,
    blast,
    first: blastToAll(blast, wave.headEndpoints, nodeSender).results,
  }));
  const headMs = Date.now() - t0;

  if (tail.length > 0 || wave.catchUpEndpoints.length > 0) {
    await settleOrTimeout(
      headFired.map((h) => h.first),
      wave.maxGapMs,
    );
  }

  const tailFired = tail.map(({ address, blast }) => ({
    address,
    txHash: blast.txHash,
    results: blastToAll(blast, wave.tailEndpoints, nodeSender).results,
  }));

  // The head still has to reach the endpoints it skipped — insurance against a
  // sequencer that refused it, at no cost to the race that is already over.
  const fired = [
    ...headFired.map(({ address, blast, first }) => ({
      address,
      txHash: blast.txHash,
      results:
        wave.catchUpEndpoints.length === 0
          ? first
          : Promise.all([first, blastToAll(blast, wave.catchUpEndpoints, nodeSender).results]).then(
              ([a, b]) => [...a, ...b],
            ),
    })),
    ...tailFired,
  ];
  log(
    `FIRED      ${fired.length} transaction(s) dispatched in ${Date.now() - t0}ms` +
      (head.length > 0 && tail.length > 0 ? ` (first ${head.length} away in ${headMs}ms)` : ""),
  );
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
