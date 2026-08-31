/**
 * Headless snipe runner — the Snipe tab's logic without a browser.
 *
 * Why this exists: the drop's ordering is decided by when bytes reach the
 * chain's sequencer, so the winning move is to run from a machine next to it
 * (AWS us-east-2 for Robinhood Chain) rather than from a laptop. A browser tab
 * can't be parked on a VPS; this can, under pm2, with no terminal attached.
 *
 * The run itself lives in runner.ts, shared with the control server, so a run
 * behaves identically however it was started.
 *
 *   npm run snipe -- --config snipe.config.json          # dry run: plan only
 *   npm run snipe -- --config snipe.config.json --yes    # actually fire
 */
import { loadConfig, loadKeyEntries, type SnipeConfig } from "./config";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther } from "viem";
import { getChainInfo } from "../chains";
import { makeInProcessSigner } from "./signer";
import { runSnipe } from "./runner";

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

async function main() {
  const { config: configPath, yes } = parseArgs(process.argv.slice(2));
  const cfg: SnipeConfig = loadConfig(configPath);
  // The standalone CLI holds its own keys, so it signs in-process. Same seam
  // as the server, just without a socket — the runner does not know the
  // difference.
  const entries = loadKeyEntries(configPath, cfg.keysFile);
  if (entries.length === 0) fail("no wallets in the key file — add one first");
  const wallets = entries.map((e) => privateKeyToAccount(e.key).address);
  const info = getChainInfo(cfg.chainId);
  const signer = makeInProcessSigner({
    loadKeys: () => entries,
    policy: () => ({
      ownWallets: new Set(wallets.map((a) => a.toLowerCase())),
      withdrawTo: new Set(),
      mintContract: (info?.seaDrop ?? "").toLowerCase(),
      maxMintWei: parseEther(process.env.SNIPE_POLICY_MAX_MINT_ETH?.trim() || "0.05"),
    }),
  });

  // Ctrl-C during the hold cancels cleanly instead of killing mid-broadcast.
  const abort = new AbortController();
  process.on("SIGINT", () => {
    log("interrupt — cancelling the hold");
    abort.abort();
  });

  await runSnipe(
    {
      chainId: cfg.chainId,
      collection: cfg.collection,
      stage: cfg.stage,
      quantity: cfg.quantity,
      wallets,
      signer,
      extraRpcs: cfg.extraRpcs,
      gas: cfg.gas,
      timing: cfg.timing,
      dryRun: !yes,
    },
    { onLog: log, signal: abort.signal },
  );

  if (!yes) log("Re-run with --yes to fire.");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
