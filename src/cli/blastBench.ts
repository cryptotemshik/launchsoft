/**
 * Measure the fire moment on the box that will actually fire it.
 *
 * `rpc:bench` measures the network — how far your VPS is from the sequencer.
 * This measures everything on your side of that wire: how long the runner
 * takes to get N signed transactions out of the process, and how much each
 * extra wallet costs the wallet that is actually racing.
 *
 * That cost is real and it is the reason wave dispatch exists. Node has one
 * thread, so a single synchronous pass queues every request and the write for
 * the first wallet does not reach the kernel until the pass is over — every
 * wallet loaded for volume delays the one loaded to win.
 *
 * Nothing here touches the chain, a wallet, or your config: the keys are
 * random, the endpoints are throwaway HTTP servers on 127.0.0.1, and the
 * transactions are signed but never broadcast anywhere real. What it does use
 * is CPU and one socket per wallet per endpoint — so run it while nothing is
 * armed, and read the descriptor line it prints.
 *
 *   npm run blast:bench
 *   npm run blast:bench -- --sizes 30,50,100,300 --runs 7 --wave 100
 *   npm run blast:bench -- --live https://sequencer.mainnet.chain.robinhood.com --wallets 100
 *
 * The far end runs in its own process on purpose. Sharing an event loop with
 * the sender makes the sender's own scheduling look like network time, which
 * is exactly the thing being measured.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  blastToAll,
  planWaves,
  parseRpcEndpoints,
  prepareBlast,
  settleOrTimeout,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { quantile } from "../lib/latency";
import { fileDescriptorLimit, nodeSender } from "./nodeSender";

const ECHO_FLAG = "--echo-server";

// ── The far end ─────────────────────────────────────────────────────────────

/**
 * A stand-in for the sequencer: accepts the JSON-RPC body and answers with a
 * hash. It answers immediately, so every millisecond the table reports is
 * spent on this side — which is the point.
 */
async function runEchoServer(count: number): Promise<void> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"11".repeat(32)}` }));
        });
      });
      server.maxConnections = 100_000;
      server.listen(0, "127.0.0.1", () => {
        ports.push((server.address() as { port: number }).port);
        resolve();
      });
    });
  }
  process.stdout.write(`${JSON.stringify(ports)}\n`);
}

// ── One measurement ─────────────────────────────────────────────────────────

interface Sample {
  /** When the first racing transaction was away. */
  first: number;
  median: number;
  /** When the last racing transaction was away. */
  last: number;
  /** When every endpoint had every transaction, insurance included. */
  everything: number;
  requests: number;
  accepted: number;
}

async function measure(
  wallets: number,
  headSize: number,
  endpoints: RpcEndpoint[],
  submit: RpcEndpoint[],
): Promise<Sample> {
  // Fresh keys each run: signing is part of the arm, not part of the fire, but
  // reusing one key would let a nonce cache flatter the numbers.
  const accounts = Array.from({ length: wallets }, () =>
    privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`),
  );
  const prepared = await Promise.all(
    accounts.map(async (a, i) => ({
      blast: prepareBlast(
        await a.signTransaction({
          chainId: 4663,
          to: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
          value: 0n,
          nonce: i,
          maxFeePerGas: parseGwei("0.3"),
          maxPriorityFeePerGas: parseGwei("0.05"),
          gas: 500_000n,
          type: "eip1559",
        }),
      ),
    })),
  );

  await nodeSender.warm(endpoints, wallets);
  // Let the pool settle, so the table measures dispatch and not the tail of
  // the warm-up it was handed.
  await new Promise((r) => setTimeout(r, 200));

  const plan = planWaves(prepared.length, endpoints, submit, { headSize, maxGapMs: 40 });
  const t0 = performance.now();
  const raced: number[] = [];
  const at = <T,>(p: Promise<T>): Promise<T> =>
    p.then((r) => {
      raced.push(performance.now() - t0);
      return r;
    });

  const head = prepared.slice(0, plan.head);
  const tail = prepared.slice(plan.head);
  const headFired = head.map(({ blast }) => ({
    blast,
    first: at(blastToAll(blast, plan.headEndpoints, nodeSender).results),
  }));
  if (tail.length > 0 || plan.catchUpEndpoints.length > 0) {
    await settleOrTimeout(
      headFired.map((h) => h.first),
      plan.maxGapMs,
    );
  }
  const tailFired = tail.map(({ blast }) => at(blastToAll(blast, plan.tailEndpoints, nodeSender).results));
  const everything = await Promise.all([
    ...headFired.map(({ blast, first }) =>
      plan.catchUpEndpoints.length === 0
        ? first
        : Promise.all([first, blastToAll(blast, plan.catchUpEndpoints, nodeSender).results]).then(
            ([a, b]) => [...a, ...b],
          ),
    ),
    ...tailFired,
  ]);
  const totalMs = performance.now() - t0;

  raced.sort((a, b) => a - b);
  const flat = everything.flat();
  return {
    first: raced[0],
    median: quantile(raced, 0.5),
    last: raced[raced.length - 1],
    everything: totalMs,
    requests: flat.length,
    accepted: flat.filter((r) => r.txHash !== null).length,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** Sub-millisecond differences matter here, so don't round them away. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

function numbers(flag: string, fallback: number[]): number[] {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  const out = process.argv[i + 1]
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return out.length > 0 ? out : fallback;
}

function number(flag: string, fallback: number): number {
  const raw = numbers(flag, [fallback]);
  return raw[0];
}

/**
 * How many requests a real endpoint takes at once.
 *
 * This is the measurement that was missing, and its absence cost a drop.
 * `blast:bench` fires a hundred concurrent requests at a local server that
 * accepts them all instantly, and `rpc:bench` measures a real endpoint one
 * request at a time. Neither asks the question that decides a contested mint:
 * when a hundred transactions leave this box together, how spread out are they
 * by the time the far end has taken them?
 *
 * On-chain evidence says the answer is "very": a hundred transactions that
 * left in 78ms came back out of the sequencer over nine blocks and 1.5
 * seconds. The sequencer admits roughly 350 transactions per block and rotates
 * between client connections, so a burst does not stay a burst.
 *
 * The probe sends `eth_chainId` — the same body the warmer uses. This chain's
 * sequencer refuses that method, which is fine and even useful: the refusal is
 * a full round trip, it costs the endpoint almost nothing, and it never
 * touches a wallet or a transaction.
 */
async function probeLive(url: string, count: number): Promise<void> {
  const ep = parseRpcEndpoints([url]);
  if (ep.length === 0) throw new Error("--live needs an endpoint URL");
  console.log(`live probe — ${count} concurrent request(s) to ${ep[0].label}`);

  const warm = await nodeSender.warm(ep, count);
  console.log(`warmed ${warm.opened}/${warm.wanted} connection(s)`);
  await new Promise((r) => setTimeout(r, 300));

  const body = JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 });
  const t0 = performance.now();
  const done: number[] = [];
  let failed = 0;
  await Promise.all(
    Array.from({ length: count }, async () => {
      try {
        await nodeSender.post(ep[0].url, body);
      } catch {
        failed++;
      }
      done.push(performance.now() - t0);
    }),
  );
  done.sort((a, b) => a - b);
  const at = (q: number) => fmt(done[Math.min(done.length - 1, Math.floor((done.length - 1) * q))]);
  console.log(
    `first ${fmt(done[0])}ms · p50 ${at(0.5)}ms · p90 ${at(0.9)}ms · last ${fmt(done[done.length - 1])}ms` +
      `${failed ? ` · ${failed} failed` : ""}`,
  );
  console.log(
    `\nspread between first and last: ${fmt(done[done.length - 1] - done[0])}ms.\n` +
      `A block on this chain is 100-200ms, so anything above that means one burst\n` +
      `cannot land in one block however well it is timed — which is the case for\n` +
      `firing a stream across the boundary rather than a single volley at it.`,
  );
}

async function main(): Promise<void> {
  const liveAt = process.argv.indexOf("--live");
  if (liveAt !== -1) {
    await probeLive(process.argv[liveAt + 1] ?? "", number("--wallets", 100));
    return;
  }
  const sizes = numbers("--sizes", [22, 30, 50, 75, 100, 150]);
  const runs = number("--runs", 5);
  const endpointCount = number("--endpoints", 3);
  const headSize = number("--wave", 100);
  const biggest = Math.max(...sizes);

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ECHO_FLAG, String(endpointCount)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ports: number[] = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      if (buf.includes("\n")) resolve(JSON.parse(buf.trim()) as number[]);
    });
    child.on("exit", (code) => reject(new Error(`the local endpoints exited with ${code}`)));
  });
  const endpoints = parseRpcEndpoints(ports.map((p) => `http://127.0.0.1:${p}`));
  // The first one stands in for the sequencer — the endpoint the head wave
  // aims at, and on this chain the only one that decides ordering.
  const submit = [endpoints[0]];

  const limit = fileDescriptorLimit();
  const needed = biggest * endpointCount;
  console.log(`blast bench — ${endpointCount} local endpoint(s), ${runs} run(s) per row, medians`);
  console.log(
    `descriptors: this process may open ${limit ?? "an unknown number of"} file(s); ` +
      `the largest row wants ${needed}` +
      (limit !== null && needed > limit * 0.8
        ? "  ← too close. Raise it with \"ulimit -n\" or the numbers below are meaningless."
        : ""),
  );
  console.log(
    "\nfirst/median/last = when a racing transaction was away. " +
      "all = when every endpoint had everything, insurance included.",
  );

  for (const mode of [0, headSize]) {
    console.log(
      mode === 0
        ? `\n=== one pass, every endpoint at once (SNIPE_WAVE_SIZE=0) ===`
        : `\n=== waves, head of ${mode} at the sequencer alone (SNIPE_WAVE_SIZE=${mode}) ===`,
    );
    console.log("wallets\tfirst\tmedian\tlast\tall\tsent");
    for (const size of sizes) {
      const samples: Sample[] = [];
      for (let i = 0; i < runs; i++) samples.push(await measure(size, mode, endpoints, submit));
      const med = (pick: (s: Sample) => number) =>
        quantile(samples.map(pick).sort((a, b) => a - b), 0.5);
      const accepted = med((s) => s.accepted);
      console.log(
        [
          size,
          fmt(med((s) => s.first)),
          fmt(med((s) => s.median)),
          fmt(med((s) => s.last)),
          fmt(med((s) => s.everything)),
          `${accepted}/${size * endpointCount}`,
        ].join("\t"),
      );
    }
  }

  child.kill();
}

const echoAt = process.argv.indexOf(ECHO_FLAG);
if (echoAt !== -1) {
  await runEchoServer(Number(process.argv[echoAt + 1] ?? 3));
} else {
  await main();
  process.exit(0);
}
