/**
 * The signer daemon: the one process that holds the keys.
 *
 *   npm run signerd -- <config path>            (usually via pm2)
 *
 * It loads the wallet file (decrypting it with SNIPE_KEYSTORE_PASSPHRASE),
 * builds an in-process signer with the full signing policy, and serves it on a
 * unix socket. Nothing it does reaches past that socket — it opens no server
 * to the internet, makes no RPC calls, has no reason for outbound network at
 * all — so a machine that isolates it (a firewall rule, a restricted user)
 * gets a process that can sign what the policy allows and can do nothing else,
 * even fully compromised.
 *
 * The API process is then started WITHOUT the passphrase and with
 * SNIPE_SIGNER_SOCKET pointing here. It cannot decrypt a key if it tries; it
 * asks this daemon for signatures and gets back only what the policy permits.
 *
 * Run them as two pm2 processes. The passphrase belongs only to this one:
 *
 *   SNIPE_KEYSTORE_PASSPHRASE=…  (signerd only — the API must NOT have it)
 *   SNIPE_SIGNER_SOCKET=/home/ubuntu/launchsoft/snipe.signer.sock  (both)
 */
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, loadKeyEntries, keysPath } from "./config";
import { keystorePassphrase, isEncrypted, PASSPHRASE_ENV } from "./keystore";
import { getChainInfo } from "../chains";
import { maturedAddresses } from "./withdrawRegistry";
import { makeInProcessSigner, serveSigner } from "./signer";
import type { PolicyContext } from "./signPolicy";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function fail(msg: string): never {
  console.error(`signerd: ${msg}`);
  process.exit(1);
}

const configPath = process.argv[2] ?? "snipe.config.json";
const socketPath = process.env.SNIPE_SIGNER_SOCKET?.trim();
if (!socketPath) fail(`set SNIPE_SIGNER_SOCKET to the socket path both processes share`);

const cfg = loadConfig(configPath);

// Refuse to start on a plain key file. The daemon's entire reason to exist is
// to be the sole holder of decrypted keys; if the file is in the clear, that
// promise is already broken and starting quietly would hide it.
const abs = keysPath(configPath, cfg.keysFile);
if (existsSync(abs) && !isEncrypted(readFileSync(abs, "utf8"))) {
  fail(`the key file is not encrypted — seal it first (set ${PASSPHRASE_ENV} and start the API once, or run keys:rekey)`);
}
if (!keystorePassphrase()) {
  fail(`${PASSPHRASE_ENV} is not set — the daemon cannot open the wallet file without it`);
}

// Prove the passphrase opens the file now, at startup, rather than at 17:30:00
// when the first job arms and discovers it cannot sign.
let count: number;
try {
  count = loadKeyEntries(configPath, cfg.keysFile).length;
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
if (count === 0) fail(`no wallets in the key file at ${abs}`);

const info = getChainInfo(cfg.chainId);

/**
 * The policy, rebuilt per decision so a matured withdrawal address and a
 * newly added wallet are both seen at once. Same shape the API used, moved to
 * where the keys are.
 */
function policy(): PolicyContext {
  const withdrawTo = maturedAddresses(configPath, Date.now());
  if (cfg.consolidateTo) withdrawTo.add(cfg.consolidateTo.toLowerCase());
  for (const a of (process.env.SNIPE_WITHDRAW_TO ?? "").split(",")) {
    const t = a.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(t)) withdrawTo.add(t);
  }
  return {
    ownWallets: new Set(
      loadKeyEntries(configPath, cfg.keysFile).map((e) =>
        // Lazy import avoided: privateKeyToAccount is already pulled in by the
        // signer, but resolving the address here keeps the set self-contained.
        addressOf(e.key),
      ),
    ),
    withdrawTo,
    mintContract: (info?.seaDrop ?? "").toLowerCase(),
    maxMintWei: parseEther(process.env.SNIPE_POLICY_MAX_MINT_ETH?.trim() || "0.05"),
  };
}

function addressOf(key: `0x${string}`): string {
  return privateKeyToAccount(key).address.toLowerCase();
}

const signer = makeInProcessSigner({
  loadKeys: () => loadKeyEntries(configPath, cfg.keysFile),
  policy,
});

// A stale socket file from a crash refuses to bind; the daemon owns this path,
// so clearing it on start is safe and is the difference between a clean
// restart and a daemon that will not come back up.
if (existsSync(socketPath)) unlinkSync(socketPath);
const server = serveSigner(signer, socketPath);

server.on("listening", () => {
  console.log(
    `signerd    holding ${count} wallet(s), serving on ${socketPath} — ` +
      `no network, keys never leave this process`,
  );
});
server.on("error", (e) => fail(`could not open the socket: ${e.message}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    try {
      server.close();
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } finally {
      process.exit(0);
    }
  });
}
