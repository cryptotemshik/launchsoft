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
import { loadConfig, loadKeys, type SnipeConfig } from "./config";
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
  const keys = loadKeys(configPath, cfg.keysFile);

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
      keys,
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
