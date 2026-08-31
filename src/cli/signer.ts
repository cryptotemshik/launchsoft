/**
 * The one place private keys are used, isolated so it can become the one place
 * they live.
 *
 * Today signing happens wherever a transaction is built — in the runner, in
 * the fund movers — and each of those places holds raw keys. That means the
 * same process that talks to the internet also holds every wallet, so any hole
 * in it is worth all of them. This module is the seam that ends that: a Signer
 * takes an unsigned transaction and gives back a raw signed one, and the code
 * that builds transactions never touches a key again.
 *
 * Two implementations behind one interface:
 *
 *   - in-process (`makeInProcessSigner`): keys in this process, exactly as
 *     today. The default, so a single-box deployment is unchanged and every
 *     existing test still exercises the real signing path.
 *   - over a socket (`connectSigner` ↔ `serveSigner`): keys in a separate
 *     process with no outbound network, reached over a unix socket. The API
 *     process then never holds a key, and a break-in there can ask for
 *     signatures but cannot read wallets or carry them off.
 *
 * The interface is the same either way, which is the whole point: the runner
 * calls `signer.sign(...)` and does not know or care which side of a socket
 * the keys are on. And because the runner signs at arm time, not at fire time,
 * a socket hop costs milliseconds on the arm and nothing at all on the shot.
 *
 * Every signature passes the policy first (signPolicy.ts). Enforcing it here,
 * at the key, rather than only at the API routes, means it holds no matter who
 * or what asks — a compromised API included.
 */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import type { KeyEntry } from "./config";
import { judgeTransaction, type PolicyContext } from "./signPolicy";

/**
 * An unsigned EIP-1559 transaction, in the shape that crosses a socket: wei
 * and gas as strings, because JSON has no bigint and a key file must never be
 * the thing that decides whether a number survived serialisation.
 */
export interface UnsignedTx {
  /** Which wallet signs it, by address. The key never leaves the signer. */
  from: `0x${string}`;
  chainId: number;
  /** Absent only for contract creation, which the policy refuses anyway. */
  to?: `0x${string}`;
  data?: `0x${string}`;
  value: string;
  nonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gas: string;
}

export interface Signer {
  /** The wallet addresses this signer can sign for. Never the keys. */
  addresses(): Promise<`0x${string}`[]>;
  /**
   * Sign a batch, all or nothing.
   *
   * All-or-nothing because a half-signed sweep is not half-done, it is a
   * confusing incident: either every transfer in this batch is going where the
   * policy allows or none of it is signed. The reason for a refusal is carried
   * in the thrown error so it can be audited.
   */
  sign(txs: readonly UnsignedTx[]): Promise<`0x${string}`[]>;
}

export interface InProcessSignerOptions {
  /** The wallets, loaded fresh so a wallet added mid-run can sign. */
  loadKeys: () => KeyEntry[];
  /** The rules, built fresh so a matured withdrawal address is seen at once. */
  policy: () => PolicyContext;
}

async function signOne(
  entry: KeyEntry,
  tx: UnsignedTx,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(entry.key);
  return account.signTransaction({
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    gas: BigInt(tx.gas),
    type: "eip1559",
  });
}

export function makeInProcessSigner(opts: InProcessSignerOptions): Signer {
  return {
    async addresses() {
      return opts.loadKeys().map((e) => privateKeyToAccount(e.key).address);
    },
    async sign(txs) {
      const ctx = opts.policy();
      // Judge the whole batch before signing any of it, so a refused one does
      // not leave earlier ones already signed.
      for (let i = 0; i < txs.length; i++) {
        const verdict = judgeTransaction(
          { to: txs[i].to, value: BigInt(txs[i].value), data: txs[i].data },
          ctx,
        );
        if (!verdict.ok) {
          throw new Error(`policy refused transaction ${i} (${txs[i].from}): ${verdict.reason}`);
        }
      }
      // Resolve keys once. A wallet asked for that the signer does not hold is
      // an error, never a silently skipped signature — a run short a wallet it
      // thought it had loses exactly the drop it was armed for.
      const byAddress = new Map(
        opts.loadKeys().map((e) => [privateKeyToAccount(e.key).address.toLowerCase(), e]),
      );
      const out: `0x${string}`[] = [];
      for (const tx of txs) {
        const entry = byAddress.get(tx.from.toLowerCase());
        if (!entry) throw new Error(`no key for ${tx.from} on this signer`);
        out.push(await signOne(entry, tx));
      }
      return out;
    },
  };
}

// ── The socket wire ─────────────────────────────────────────────────────────
//
// Newline-delimited JSON, one request per line, one response per line. A tiny
// protocol on a local unix socket does not need framing cleverness; it needs
// to be obviously correct and to never leak a key into an error string.

interface Request {
  id: number;
  method: "addresses" | "sign";
  txs?: UnsignedTx[];
}
interface Response {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Serve a signer on a unix socket.
 *
 * The process that runs this is the one that holds the keys, and it is meant
 * to be started with no outbound network access at all — nothing it does
 * reaches past this socket, so nothing that compromises it can carry a key
 * out. Returns the server so a caller can close it; callers should unlink the
 * socket path first, since a stale file from a crash refuses to bind.
 */
export function serveSigner(signer: Signer, socketPath: string): Server {
  const server = createServer((sock: Socket) => {
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void handle(line, sock, signer);
      }
    });
  });
  server.listen(socketPath);
  return server;
}

async function handle(line: string, sock: Socket, signer: Signer): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    sock.write(`${JSON.stringify({ id: 0, ok: false, error: "unparseable request" })}\n`);
    return;
  }
  const reply = (r: Omit<Response, "id">) => sock.write(`${JSON.stringify({ id: req.id, ...r })}\n`);
  try {
    if (req.method === "addresses") {
      reply({ ok: true, result: await signer.addresses() });
    } else if (req.method === "sign") {
      reply({ ok: true, result: await signer.sign(req.txs ?? []) });
    } else {
      reply({ ok: false, error: `unknown method ${String(req.method)}` });
    }
  } catch (e) {
    // The message is the policy's reason or a "no key for" — neither carries a
    // secret, and signOne's viem errors do not include the key. Still, only
    // the message crosses back, never the stack, which can.
    reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * A signer that lives on the other end of a socket.
 *
 * One short-lived connection per call rather than a held one: signing happens
 * a handful of times per run, seconds apart, and a connection that is opened
 * and closed each time cannot rot between a stage moving and the shot. The
 * cost is a local connect, microseconds, and never on the fire path.
 */
export function connectSigner(socketPath: string): Signer {
  const call = <T,>(method: "addresses" | "sign", txs?: UnsignedTx[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const sock = createConnection(socketPath);
      let buffer = "";
      const id = Math.floor(Math.random() * 1e9);
      sock.on("connect", () => sock.write(`${JSON.stringify({ id, method, txs })}\n`));
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        sock.end();
        let r: Response;
        try {
          r = JSON.parse(buffer.slice(0, nl)) as Response;
        } catch {
          reject(new Error("unparseable response from signer"));
          return;
        }
        if (r.ok) resolve(r.result as T);
        else reject(new Error(r.error ?? "signer refused without a reason"));
      });
      sock.on("error", reject);
    });
  return {
    addresses: () => call<`0x${string}`[]>("addresses"),
    sign: (txs) => call<`0x${string}`[]>("sign", [...txs]),
  };
}
