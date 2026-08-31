import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGwei, parseEther, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  connectSigner,
  makeInProcessSigner,
  serveSigner,
  type Signer,
  type UnsignedTx,
} from "./signer";
import type { PolicyContext } from "./signPolicy";
import { SEADROP } from "../chains";
import type { KeyEntry } from "./config";

const KEY_A = `0x${"11".repeat(32)}` as `0x${string}`;
const KEY_B = `0x${"22".repeat(32)}` as `0x${string}`;
const ADDR_A = privateKeyToAccount(KEY_A).address;
const ADDR_B = privateKeyToAccount(KEY_B).address;
const STRANGER = `0x${"dd".repeat(20)}` as `0x${string}`;

const KEYS: KeyEntry[] = [
  { key: KEY_A, label: "a" },
  { key: KEY_B, label: "b" },
];

const policy = (): PolicyContext => ({
  ownWallets: new Set([ADDR_A.toLowerCase(), ADDR_B.toLowerCase()]),
  withdrawTo: new Set(),
  mintContract: SEADROP.toLowerCase(),
  maxMintWei: parseEther("0.05"),
});

const inProc = () => makeInProcessSigner({ loadKeys: () => KEYS, policy });

/** A plain transfer between our own wallets — always allowed by the policy. */
const ownTransfer = (from: `0x${string}`, to: `0x${string}`): UnsignedTx => ({
  from,
  chainId: 4663,
  to,
  value: parseEther("0.1").toString(),
  nonce: 0,
  maxFeePerGas: parseGwei("1").toString(),
  maxPriorityFeePerGas: parseGwei("0.05").toString(),
  gas: "21000",
});

async function expectSignedBy(raw: `0x${string}`, address: `0x${string}`): Promise<void> {
  const recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  expect(recovered.toLowerCase()).toBe(address.toLowerCase());
}

describe("signing in-process", () => {
  it("lists its addresses and never the keys", async () => {
    expect(await inProc().addresses()).toEqual([ADDR_A, ADDR_B]);
  });

  it("produces a transaction that recovers to the signing wallet", async () => {
    const [raw] = await inProc().sign([ownTransfer(ADDR_A, ADDR_B)]);
    await expectSignedBy(raw, ADDR_A);
  });

  it("signs a batch, each by its own wallet", async () => {
    const [ra, rb] = await inProc().sign([
      ownTransfer(ADDR_A, ADDR_B),
      ownTransfer(ADDR_B, ADDR_A),
    ]);
    await expectSignedBy(ra, ADDR_A);
    await expectSignedBy(rb, ADDR_B);
  });

  it("refuses a wallet it does not hold", async () => {
    await expect(inProc().sign([ownTransfer(STRANGER, ADDR_A)])).rejects.toThrow(/no key for/);
  });

  it("enforces the policy at the key, not just at the route", async () => {
    // A transfer to a stranger is what a compromised API would ask for; the
    // signer refuses it even though the caller reached this far.
    await expect(inProc().sign([ownTransfer(ADDR_A, STRANGER)])).rejects.toThrow(/policy refused/);
  });

  it("returns signatures in the order it was given them", async () => {
    // The runner flattens wallet × shot into one batch and slices the result
    // back out by position. If order were not preserved, wallet A's shots
    // would be signed by wallet B — a silent, catastrophic mix-up. So this is
    // the invariant the mint path leans on, guarded directly.
    const txs = [
      ownTransfer(ADDR_B, ADDR_A),
      ownTransfer(ADDR_A, ADDR_B),
      ownTransfer(ADDR_B, ADDR_A),
      ownTransfer(ADDR_A, ADDR_B),
    ];
    const raw = await inProc().sign(txs);
    for (let i = 0; i < txs.length; i++) await expectSignedBy(raw[i], txs[i].from);
  });

  it("signs nothing when one in the batch is refused", async () => {
    // All-or-nothing: the good transfer must not come back signed while the
    // bad one is rejected.
    await expect(
      inProc().sign([ownTransfer(ADDR_A, ADDR_B), ownTransfer(ADDR_B, STRANGER)]),
    ).rejects.toThrow(/policy refused transaction 1/);
  });
});

describe("signing over a socket", () => {
  let path: string;
  let server: ReturnType<typeof serveSigner> | null = null;

  const serve = (signer: Signer): Signer => {
    path = join(mkdtempSync(join(tmpdir(), "signer-")), "sock");
    server = serveSigner(signer, path);
    return connectSigner(path);
  };

  afterEach(() => {
    server?.close();
    server = null;
    try {
      rmSync(path);
    } catch {
      /* already gone */
    }
  });

  it("round-trips a real signature across the wire", async () => {
    // The point of the whole module: the keys are on the server side, the
    // client holds none, and what comes back still recovers to the wallet.
    const client = serve(inProc());
    const [raw] = await client.sign([ownTransfer(ADDR_A, ADDR_B)]);
    await expectSignedBy(raw, ADDR_A);
  });

  it("carries the address list across without the keys", async () => {
    const client = serve(inProc());
    expect(await client.addresses()).toEqual([ADDR_A, ADDR_B]);
  });

  it("carries a policy refusal back as an error, not a signature", async () => {
    const client = serve(inProc());
    await expect(client.sign([ownTransfer(ADDR_A, STRANGER)])).rejects.toThrow(/policy refused/);
  });

  it("carries an unknown-wallet refusal back too", async () => {
    const client = serve(inProc());
    await expect(client.sign([ownTransfer(STRANGER, ADDR_A)])).rejects.toThrow(/no key for/);
  });

  it("handles several signatures over one server", async () => {
    const client = serve(inProc());
    const [ra] = await client.sign([ownTransfer(ADDR_A, ADDR_B)]);
    const [rb] = await client.sign([ownTransfer(ADDR_B, ADDR_A)]);
    await expectSignedBy(ra, ADDR_A);
    await expectSignedBy(rb, ADDR_B);
  });
});
