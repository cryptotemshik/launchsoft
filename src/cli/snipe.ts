/**
 * Headless snipe runner — the Snipe tab's logic without a browser.
 *
 * Why this exists: the drop's ordering is decided by when bytes reach the
 * chain's sequencer, so the winning move is to run from a machine next to it
 * (AWS us-east-2 for Robinhood Chain) rather than from a laptop. A browser tab
 * can't be parked on a VPS; this can, under pm2, with no terminal attached.
 *
 * It shares every piece of logic with the web app — same RPC blast, same
 * timer, same allow-list proof derivation, same SeaDrop ABI — so the two can't
 * drift apart.
 *
 *   npm run snipe -- --config snipe.config.json          # dry run: plan only
 *   npm run snipe -- --config snipe.config.json --yes    # actually fire
 */
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  http,
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
import { fetchAllowListSource, gateKind, hasAllowList } from "../lib/allowlistSource";
import {
  blastToAll,
  isAlreadyKnown,
  parseRpcEndpoints,
  prepareBlast,
  waitForReceiptOrNull,
  warmEndpoints,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { waitUntil } from "../lib/snipeTimer";
import { loadConfig, loadKeys, type SnipeConfig } from "./config";

// ── tiny logging helpers (no dependency, works in a pm2 log) ───────────────
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);
function fail(msg: string): never {
  console.error(`[${stamp()}] ERROR ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let config = "snipe.config.json";
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) config = argv[++i];
    else if (argv[i] === "--yes" || argv[i] === "-y") yes = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        [
          "Headless SeaDrop snipe runner",
          "",
          "  --config <path>   config file (default: snipe.config.json)",
          "  --yes, -y         actually broadcast; without it this is a dry run",
          "",
          "Keys live in the file named by `keysFile`, one per line.",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return { config, yes };
}

interface DropState {
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

async function readDrop(
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

async function main() {
  const { config: configPath, yes } = parseArgs(process.argv.slice(2));
  const cfg: SnipeConfig = loadConfig(configPath);
  const keys = loadKeys(configPath, cfg.keysFile);
  const accounts: PrivateKeyAccount[] = keys.map((k) => privateKeyToAccount(k));

  const info = getChainInfo(cfg.chainId);
  if (!info) fail(`chain ${cfg.chainId} isn't in the registry (see src/chains.ts)`);

  // Reads go to a real RPC — never to a sequencer, which is send-only.
  const readUrl = cfg.extraRpcs[0] ?? info.chain.rpcUrls.default.http[0];
  const client = createPublicClient({ chain: info.chain, transport: http(readUrl) }) as PublicClient;

  // Broadcast targets: the chain's sequencer first (shortest path into the
  // ordering queue), then its public RPC, then anything the user added.
  const endpoints: RpcEndpoint[] = parseRpcEndpoints([
    ...(info.submitRpcs ?? []),
    ...info.chain.rpcUrls.default.http,
    ...cfg.extraRpcs,
  ]);

  log(`chain      ${info.label} (${info.id})`);
  log(`wallets    ${accounts.length}`);
  log(`endpoints  ${endpoints.map((e) => e.label).join(", ")}`);
  log(`reads via  ${readUrl}`);

  const drop = await readDrop(client, info, cfg.collection);
  log(`collection ${drop.name} — minted ${drop.totalSupply}/${drop.maxSupply}`);

  const feeRecipient = pickFeeRecipient(info, drop.allowedFeeRecipients, drop.restrictFeeRecipients);
  if (!feeRecipient) fail("this drop restricts fee recipients and allows none — cannot mint");

  // ── Stage selection ─────────────────────────────────────────────────────
  let firing = accounts;
  const elig = new Map<string, Eligibility>();
  let price = drop.price;
  let perWallet = drop.perWallet;
  let startTime = drop.startTime;
  let endTime = drop.endTime;

  if (cfg.stage === "allowlist") {
    const source = await fetchAllowListSource(client, info, cfg.collection);
    const kind = gateKind(source);
    if (kind !== "merkle") {
      fail(
        `this drop's restricted stage is "${kind}", which can't be built from on-chain data. ` +
          `Only merkle allow-lists work here — mint that stage on opensea.io.`,
      );
    }
    if (!source.list) fail(source.problem ?? "allow-list document couldn't be read");
    for (const a of accounts) {
      elig.set(a.address.toLowerCase(), checkEligibility(source.list, a.address, source.root));
    }
    firing = accounts.filter((a) => elig.get(a.address.toLowerCase())?.eligible);
    if (firing.length === 0) fail("none of the loaded wallets are on this drop's allow-list");
    const params = elig.get(firing[0].address.toLowerCase())!.params!;
    price = params.mintPrice;
    perWallet = Number(params.maxTotalMintableByWallet);
    startTime = Number(params.startTime);
    endTime = Number(params.endTime);
    log(`stage      allow-list — ${firing.length}/${accounts.length} wallets eligible`);
    if (!hasAllowList(source.root)) fail("contract holds a zero merkle root — nothing to prove against");
  } else {
    log(`stage      public`);
  }

  const quantity = Math.min(cfg.quantity, perWallet || cfg.quantity);
  if (quantity < cfg.quantity) {
    log(`note       quantity clamped to the stage's per-wallet cap (${perWallet})`);
  }

  // ── Gas validation — the same rails the browser applies ─────────────────
  const maxFeePerGas = parseGwei(cfg.gas.maxFeeGwei);
  const maxPriorityFeePerGas = parseGwei(cfg.gas.tipGwei);
  const gasLimit = BigInt(cfg.gas.limit);
  if (maxPriorityFeePerGas > maxFeePerGas) fail("gas.tipGwei cannot exceed gas.maxFeeGwei (EIP-1559)");
  const block = await client.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  if (maxFeePerGas < baseFee) {
    fail(
      `gas.maxFeeGwei (${cfg.gas.maxFeeGwei}) is below the current base fee ` +
        `(${formatGwei(baseFee)} gwei) — every node would reject it`,
    );
  }
  log(`gas        max ${cfg.gas.maxFeeGwei} / tip ${cfg.gas.tipGwei} gwei · limit ${cfg.gas.limit} · base now ${formatGwei(baseFee)}`);

  // ── Balance check ───────────────────────────────────────────────────────
  const needed = gasLimit * maxFeePerGas + price * BigInt(quantity);
  const balances = await Promise.all(firing.map((a) => client.getBalance({ address: a.address })));
  const broke = firing.filter((_, i) => balances[i] < needed);
  for (const a of broke) log(`WARN       ${a.address} can't cover ${formatEther(needed)} ETH — it will be rejected`);

  const now = Math.floor(Date.now() / 1000);
  const opensIn = startTime - now;
  log(
    `window     ${new Date(startTime * 1000).toISOString()} → ${new Date(endTime * 1000).toISOString()}` +
      (opensIn > 0 ? ` (opens in ${opensIn}s)` : now > endTime ? " (CLOSED)" : " (LIVE)"),
  );
  log(
    `plan       ${firing.length} wallet(s) × ${quantity} = ${firing.length * quantity} NFTs, ` +
      `${price === 0n ? "free" : `${formatEther(price * BigInt(quantity) * BigInt(firing.length))} ETH total`}`,
  );

  if (!yes) {
    log("DRY RUN — nothing was broadcast. Re-run with --yes to fire.");
    return;
  }
  if (now > endTime) fail("this stage has already closed");

  // ── Pre-sign, so the fire moment is pure network ────────────────────────
  const nonces = await Promise.all(
    firing.map((a) => client.getTransactionCount({ address: a.address, blockTag: "pending" })),
  );
  const prepared = await Promise.all(
    firing.map(async (a, i) => {
      let data: Hex;
      let value: bigint;
      if (cfg.stage === "allowlist") {
        const el = elig.get(a.address.toLowerCase())!;
        const qty = Math.min(quantity, Number(el.params!.maxTotalMintableByWallet) || quantity);
        data = encodeFunctionData({
          abi: seaDropAbi,
          functionName: "mintAllowList",
          args: [cfg.collection, feeRecipient, zeroAddress, BigInt(qty), el.params!, el.proof!],
        });
        value = el.params!.mintPrice * BigInt(qty);
      } else {
        data = encodeFunctionData({
          abi: seaDropAbi,
          functionName: "mintPublic",
          args: [cfg.collection, feeRecipient, zeroAddress, BigInt(quantity)],
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

  // Open every connection now: a cold HTTPS request spends most of its time on
  // DNS+TCP+TLS, and that cost has no business being on the critical path.
  await warmEndpoints(endpoints);
  log("warmed     connections open");

  if (cfg.timing === "wait" && startTime * 1000 > Date.now()) {
    log(`waiting    holding until the stage opens…`);
    await waitUntil(startTime * 1000, {
      onApproach: () => {
        void warmEndpoints(endpoints);
        log("warming    re-opened connections (3s out)");
      },
    });
  }

  // ── Fire ────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const fired = prepared.map(({ address, blast }) => ({
    address,
    txHash: blast.txHash,
    results: blastToAll(blast, endpoints).results,
  }));
  log(`FIRED      ${fired.length} transaction(s) dispatched in ${Date.now() - t0}ms`);
  for (const f of fired) log(`  ${f.address} → ${f.txHash}`);

  await Promise.all(
    fired.map(async ({ address, txHash, results }) => {
      const settled = await results;
      const accepted = settled.some((r) => r.txHash !== null || isAlreadyKnown(r.error));
      if (!accepted) {
        const reasons = [...new Set(settled.map((r) => r.error).filter(Boolean))].join("; ");
        log(`REJECTED   ${address} — no endpoint took it: ${reasons}`);
        return;
      }
      const winner = settled.find((r) => r.txHash !== null);
      log(`accepted   ${address}${winner ? ` (first: ${winner.label})` : ""}`);
      const receipt = await waitForReceiptOrNull(client, txHash, 90_000);
      if (!receipt) {
        log(`TIMEOUT    ${address} — no receipt in 90s, check ${info.explorerUrl}/tx/${txHash}`);
        return;
      }
      log(
        `${receipt.status === "success" ? "MINED     " : "REVERTED  "} ${address} — ` +
          `block ${receipt.blockNumber}, gas ${receipt.gasUsed}`,
      );
    }),
  );
  log("done");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
