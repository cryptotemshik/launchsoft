import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXPORT_TTL_MS, issueExport, redeemExport } from "./keyExport";

const owner = privateKeyToAccount(generatePrivateKey());
const thief = privateKeyToAccount(generatePrivateKey());
const cfgPath = "/tmp/world/snipe.config.json";

describe("key export approval", () => {
  it("releases for the owner's signature over the server's message", async () => {
    const ch = issueExport({ cfgPath, signers: [owner.address], wallets: 3 });
    expect(ch.message).toMatch(/EXPORT PRIVATE KEYS/);
    expect(ch.message).toMatch(/all 3 wallet/);
    const signature = await owner.signMessage({ message: ch.message });
    await expect(redeemExport({ nonce: ch.nonce, signature, cfgPath })).resolves.toEqual({
      signer: owner.address.toLowerCase(),
    });
  });

  it("is single use", async () => {
    const ch = issueExport({ cfgPath, signers: [owner.address], wallets: 1 });
    const signature = await owner.signMessage({ message: ch.message });
    await redeemExport({ nonce: ch.nonce, signature, cfgPath });
    await expect(redeemExport({ nonce: ch.nonce, signature, cfgPath })).rejects.toThrow(/expired or was already used/);
  });

  it("refuses any other wallet, and spends the nonce doing so", async () => {
    const ch = issueExport({ cfgPath, signers: [owner.address], wallets: 1 });
    const bad = await thief.signMessage({ message: ch.message });
    await expect(redeemExport({ nonce: ch.nonce, signature: bad, cfgPath })).rejects.toThrow(/does not own/);
    const good = await owner.signMessage({ message: ch.message });
    await expect(redeemExport({ nonce: ch.nonce, signature: good, cfgPath })).rejects.toThrow(/already used/);
  });

  it("refuses a signature over a different message", async () => {
    const ch = issueExport({ cfgPath, signers: [owner.address], wallets: 1 });
    const signature = await owner.signMessage({ message: "Sign in to Orvex" });
    await expect(redeemExport({ nonce: ch.nonce, signature, cfgPath })).rejects.toThrow(/does not own/);
  });

  it("expires", async () => {
    const now = Date.now();
    const ch = issueExport({ cfgPath, signers: [owner.address], wallets: 1, nowMs: now });
    const signature = await owner.signMessage({ message: ch.message });
    await expect(
      redeemExport({ nonce: ch.nonce, signature, cfgPath, nowMs: now + EXPORT_TTL_MS + 1 }),
    ).rejects.toThrow(/expired/);
  });

  it("only exports the world it was started for", async () => {
    const ch = issueExport({ cfgPath, signers: [owner.address], wallets: 1 });
    const signature = await owner.signMessage({ message: ch.message });
    await expect(
      redeemExport({ nonce: ch.nonce, signature, cfgPath: "/tmp/other/snipe.config.json" }),
    ).rejects.toThrow(/different account/);
  });

  it("cannot be started with nobody to approve it", () => {
    expect(() => issueExport({ cfgPath, signers: [], wallets: 1 })).toThrow(/SNIPE_ADMIN_ADDRESS/);
  });
});
