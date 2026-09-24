import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  base58,
  expectedSolTries,
  freshKeys,
  matches,
  normalizeSolPattern,
  verifySolWallet,
  walletFromSeed,
} from "./solVanity";

describe("solana wallets", () => {
  it("encodes base58 like everyone else", () => {
    expect(base58(new Uint8Array(32))).toBe("11111111111111111111111111111111"); // the system program
    expect(base58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe("112");
  });

  it("a known seed gives the known address and a 64-byte secret", () => {
    // RFC 8032 test vector 1.
    const seed = Uint8Array.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60".match(/../g)!.map((h) => parseInt(h, 16)),
    );
    const w = walletFromSeed(seed);
    expect(w.address).toBe(base58(ed25519.getPublicKey(seed)));
    expect(verifySolWallet(w)).toBe(true);
    expect(verifySolWallet({ ...w, address: w.address.slice(0, -1) + (w.address.endsWith("1") ? "2" : "1") })).toBe(false);
  });

  it("keys from the platform import as the wallet they claim to be", async () => {
    for (const k of await freshKeys(8)) expect(verifySolWallet(walletFromSeed(k.seed, k.pub))).toBe(true);
  });

  it("validates patterns and prices them", () => {
    expect(() => normalizeSolPattern("0x", false)).toThrow(/no 0, O, I or l/);
    expect(() => normalizeSolPattern("l", false)).toThrow();
    expect(normalizeSolPattern("l", true)).toBe("l"); // "L" exists
    expect(expectedSolTries("ab", "", false)).toBe(58 * 58);
    expect(expectedSolTries("a", "", true)).toBe(29);
    expect(expectedSolTries("1", "", true)).toBe(58);
    expect(matches("ABCxyz", "abc", "", true)).toBe(true);
    expect(matches("ABCxyz", "abc", "", false)).toBe(false);
  });
});
