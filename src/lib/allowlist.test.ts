import { describe, expect, it } from "vitest";
import {
  buildProof,
  buildRoot,
  checkEligibility,
  mintParamsLeaf,
  parseAllowList,
  verifyProof,
  type MintParams,
} from "./allowlist";

/**
 * Fixture captured from a live Shape drop (contract
 * 0xd0283C1e37D9ddE977188dB917b0CF7020132243). The leaf, proof and root below
 * are the real published values, so these tests pin the encoding to what
 * SeaDrop actually accepts on-chain.
 */
const REAL = {
  address: "0x9C54A9C609212D2FD034B55cF3b42ba99AF52880",
  leaf: "0xa95cc21c4a1cba96bf087a48d4fb75213eef364afadcdeee48060eeea790d826" as const,
  root: "0x827df7efeebd03e22e48148a6e69acfb3a6150ebe27e49770b736ec5b94a977b" as const,
  proof: [
    "0x14add74825f57b28ebd7fca8fb46f95ec996b346e616aeb5e256d8ce133d4a1e",
    "0xc2a6e285058973caf7e0f99a311f3b5e240bf9cacbe15a048b5a6c5990a0c65c",
    "0x7a77f05d446e44d55626a167c5bdd34b0af60a0e2bc64177912bda2af78f6a78",
  ] as `0x${string}`[],
  params: {
    mintPrice: 5_000_000_000n,
    maxTotalMintableByWallet: 2n,
    startTime: 1_784_323_800n,
    endTime: 1_784_410_200n,
    dropStageIndex: 1n,
    maxTokenSupplyForStage: 14n,
    feeBps: 1000n,
    restrictFeeRecipients: true,
  } satisfies MintParams,
};

describe("mintParamsLeaf", () => {
  it("reproduces a real published leaf", () => {
    expect(mintParamsLeaf(REAL.address, REAL.params)).toBe(REAL.leaf);
  });

  it("changes when any field changes", () => {
    const bumped = { ...REAL.params, maxTotalMintableByWallet: 3n };
    expect(mintParamsLeaf(REAL.address, bumped)).not.toBe(REAL.leaf);
  });

  it("is address-specific", () => {
    const other = "0x000000000000000000000000000000000000dEaD";
    expect(mintParamsLeaf(other, REAL.params)).not.toBe(REAL.leaf);
  });
});

describe("verifyProof", () => {
  it("verifies a real proof against the on-chain root", () => {
    expect(verifyProof(REAL.leaf, REAL.proof, REAL.root)).toBe(true);
  });

  it("rejects a tampered proof", () => {
    const bad = [...REAL.proof];
    bad[0] = ("0x" + "11".repeat(32)) as `0x${string}`;
    expect(verifyProof(REAL.leaf, bad, REAL.root)).toBe(false);
  });

  it("rejects a different leaf", () => {
    const other = mintParamsLeaf(
      "0x000000000000000000000000000000000000dEaD",
      REAL.params,
    );
    expect(verifyProof(other, REAL.proof, REAL.root)).toBe(false);
  });
});

describe("buildRoot / buildProof round-trip", () => {
  const wallets = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
  ];
  const leaves = wallets.map((w) => mintParamsLeaf(w, REAL.params));

  it("every leaf proves against the built root (odd count included)", () => {
    const root = buildRoot(leaves)!;
    for (const leaf of leaves) {
      expect(verifyProof(leaf, buildProof(leaves, leaf), root)).toBe(true);
    }
  });

  it("a leaf outside the tree does not verify", () => {
    const root = buildRoot(leaves)!;
    const outsider = mintParamsLeaf(
      "0x9999999999999999999999999999999999999999",
      REAL.params,
    );
    expect(verifyProof(outsider, buildProof(leaves, outsider), root)).toBe(false);
  });

  it("handles a single-entry list", () => {
    const one = [leaves[0]];
    expect(buildRoot(one)).toBe(leaves[0]);
    expect(verifyProof(leaves[0], buildProof(one, leaves[0]), leaves[0])).toBe(true);
  });

  it("returns null for an empty list", () => {
    expect(buildRoot([])).toBeNull();
  });
});

describe("parseAllowList", () => {
  it("parses the claims-map shape with shipped proofs", () => {
    const doc = {
      merkleRoot: REAL.root,
      mintParams: {
        mintPrice: "5000000000",
        maxTotalMintableByWallet: "2",
        startTime: "1784323800",
        endTime: "1784410200",
        dropStageIndex: "1",
        maxTokenSupplyForStage: "14",
        feeBps: "1000",
        restrictFeeRecipients: true,
      },
      claims: {
        [REAL.address]: { leaf: REAL.leaf, proof: REAL.proof },
      },
    };
    const parsed = parseAllowList(doc);
    expect(parsed.declaredRoot).toBe(REAL.root);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].params).toEqual(REAL.params);
    expect(parsed.entries[0].proof).toEqual(REAL.proof);
  });

  it("parses the flat-array shape and coerces numeric fields", () => {
    const doc = [
      {
        address: "0x179F11e5ee9593bB736c37524183B9f5C73c426A",
        mintPrice: 0,
        maxTotalMintableByWallet: 10,
        startTime: 1787130000,
        endTime: 1787140000,
        dropStageIndex: 1,
        maxTokenSupplyForStage: 100,
        feeBps: 1000,
        restrictFeeRecipients: true,
      },
    ];
    const parsed = parseAllowList(doc);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].params.maxTotalMintableByWallet).toBe(10n);
    expect(parsed.entries[0].params.mintPrice).toBe(0n);
  });

  it("skips malformed rows and unknown shapes", () => {
    expect(parseAllowList([{ address: "nope" }, null, 5]).entries).toEqual([]);
    expect(parseAllowList("PGP-encrypted blob").entries).toEqual([]);
    expect(parseAllowList(null).entries).toEqual([]);
  });
});

describe("checkEligibility", () => {
  const wallets = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const flat = wallets.map((address) => ({
    address,
    mintPrice: "0",
    maxTotalMintableByWallet: "2",
    startTime: "1000",
    endTime: "2000",
    dropStageIndex: "1",
    maxTokenSupplyForStage: "10",
    feeBps: "1000",
    restrictFeeRecipients: true,
  }));
  const parsed = parseAllowList(flat);
  const root = buildRoot(
    parsed.entries.map((e) => mintParamsLeaf(e.address, e.params)),
  )!;

  it("accepts a listed wallet and derives a working proof", () => {
    const r = checkEligibility(parsed, wallets[1], root);
    expect(r.eligible).toBe(true);
    expect(r.params?.maxTotalMintableByWallet).toBe(2n);
    expect(
      verifyProof(mintParamsLeaf(wallets[1], r.params!), r.proof!, root),
    ).toBe(true);
  });

  it("is case-insensitive about the wallet", () => {
    expect(checkEligibility(parsed, wallets[0].toUpperCase(), root).eligible).toBe(
      true,
    );
  });

  it("rejects a wallet that isn't listed", () => {
    const r = checkEligibility(parsed, "0x9999999999999999999999999999999999999999", root);
    expect(r.eligible).toBe(false);
    expect(r.proofMismatch).toBeUndefined();
  });

  it("flags a listed wallet whose list doesn't match the on-chain root", () => {
    const wrongRoot = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const r = checkEligibility(parsed, wallets[0], wrongRoot);
    expect(r.eligible).toBe(false);
    expect(r.proofMismatch).toBe(true);
  });

  it("prefers a shipped proof when it verifies", () => {
    const doc = {
      merkleRoot: REAL.root,
      claims: {
        [REAL.address]: {
          mintParams: {
            mintPrice: "5000000000",
            maxTotalMintableByWallet: "2",
            startTime: "1784323800",
            endTime: "1784410200",
            dropStageIndex: "1",
            maxTokenSupplyForStage: "14",
            feeBps: "1000",
            restrictFeeRecipients: true,
          },
          proof: REAL.proof,
        },
      },
    };
    const r = checkEligibility(parseAllowList(doc), REAL.address, REAL.root);
    expect(r.eligible).toBe(true);
    expect(r.proof).toEqual(REAL.proof);
  });
});
