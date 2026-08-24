/**
 * SeaDrop allow-list eligibility, worked out client-side.
 *
 * SeaDrop stores only a merkle root on-chain; the list itself lives at the
 * `allowListURI` announced in the `AllowListUpdated` event. A wallet proves
 * membership by passing its `MintParams` plus a merkle proof to
 * `mintAllowList`.
 *
 * Leaf encoding and proof shape were verified against a live drop:
 *   leaf = keccak256(abi.encode(minter, mintParams))
 *   proof verifies with sorted-pair hashing (OpenZeppelin MerkleProof)
 * reproducing the published leaf and on-chain root exactly.
 */
import { concat, encodeAbiParameters, keccak256, parseAbiItem } from "viem";

/** SeaDrop's MintParams — field order matters, it is what gets hashed. */
export interface MintParams {
  mintPrice: bigint;
  maxTotalMintableByWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  dropStageIndex: bigint;
  maxTokenSupplyForStage: bigint;
  feeBps: bigint;
  restrictFeeRecipients: boolean;
}

export const allowListUpdatedEvent = parseAbiItem(
  "event AllowListUpdated(address indexed nftContract, bytes32 indexed previousMerkleRoot, bytes32 indexed newMerkleRoot, string[] publicKeyURI, string allowListURI)",
);

const MINT_PARAMS_TUPLE = {
  type: "tuple",
  components: [
    { type: "uint256" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "bool" },
  ],
} as const;

export function mintParamsTuple(
  p: MintParams,
): readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean] {
  return [
    p.mintPrice,
    p.maxTotalMintableByWallet,
    p.startTime,
    p.endTime,
    p.dropStageIndex,
    p.maxTokenSupplyForStage,
    p.feeBps,
    p.restrictFeeRecipients,
  ];
}

/** keccak256(abi.encode(minter, mintParams)) — SeaDrop's allow-list leaf. */
export function mintParamsLeaf(minter: string, p: MintParams): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, MINT_PARAMS_TUPLE],
      [minter as `0x${string}`, mintParamsTuple(p)],
    ),
  );
}

/** OpenZeppelin-style verification: pairs hashed in sorted order. */
export function verifyProof(
  leaf: `0x${string}`,
  proof: readonly `0x${string}`[],
  root: `0x${string}`,
): boolean {
  let hash = leaf;
  for (const sibling of proof) {
    hash =
      BigInt(hash) < BigInt(sibling)
        ? keccak256(concat([hash, sibling]))
        : keccak256(concat([sibling, hash]));
  }
  return hash.toLowerCase() === root.toLowerCase();
}

function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  return BigInt(a) < BigInt(b)
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

/** Merkle root over sorted-pair hashing, for lists that ship no proofs. */
export function buildRoot(leaves: `0x${string}`[]): `0x${string}` | null {
  if (leaves.length === 0) return null;
  let level = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  while (level.length > 1) {
    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** The proof for one leaf in the same tree `buildRoot` constructs. */
export function buildProof(
  leaves: `0x${string}`[],
  target: `0x${string}`,
): `0x${string}`[] {
  let level = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  let index = level.findIndex((l) => l.toLowerCase() === target.toLowerCase());
  if (index === -1) return [];
  const proof: `0x${string}`[] = [];
  while (level.length > 1) {
    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : undefined;
      if (right === undefined) {
        next.push(left);
        if (i === index) index = next.length - 1;
      } else {
        if (i === index) {
          proof.push(right);
          index = next.length;
        } else if (i + 1 === index) {
          proof.push(left);
          index = next.length;
        }
        next.push(hashPair(left, right));
      }
    }
    level = next;
  }
  return proof;
}

// ── Allow-list document parsing ──────────────────────────────────────────────

export interface AllowListEntry {
  address: string;
  params: MintParams;
  /** Proof shipped with the document, when it has one. */
  proof?: `0x${string}`[];
  leaf?: `0x${string}`;
}

export interface ParsedAllowList {
  entries: AllowListEntry[];
  /** Root declared by the document, if any (the chain's root still wins). */
  declaredRoot?: `0x${string}`;
}

const big = (v: unknown, fallback = 0n): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.trim() !== "") {
    try {
      return BigInt(v);
    } catch {
      return fallback;
    }
  }
  return fallback;
};

function toParams(raw: Record<string, unknown>): MintParams {
  return {
    mintPrice: big(raw.mintPrice),
    maxTotalMintableByWallet: big(raw.maxTotalMintableByWallet),
    startTime: big(raw.startTime),
    endTime: big(raw.endTime),
    dropStageIndex: big(raw.dropStageIndex),
    maxTokenSupplyForStage: big(raw.maxTokenSupplyForStage),
    feeBps: big(raw.feeBps),
    restrictFeeRecipients: raw.restrictFeeRecipients !== false,
  };
}

/**
 * Handles the two shapes seen in the wild: a `claims` map carrying ready-made
 * proofs, and a flat array of entries whose tree has to be rebuilt locally.
 */
export function parseAllowList(doc: unknown): ParsedAllowList {
  // Shape 1: { merkleRoot, mintParams, claims: { "0x…": { leaf, mintParams, proof } } }
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const d = doc as Record<string, unknown>;
    const claims = d.claims;
    if (claims && typeof claims === "object") {
      const shared = d.mintParams as Record<string, unknown> | undefined;
      const entries: AllowListEntry[] = Object.entries(
        claims as Record<string, unknown>,
      ).map(([address, value]) => {
        const v = (value ?? {}) as Record<string, unknown>;
        const raw = (v.mintParams as Record<string, unknown>) ?? shared ?? {};
        return {
          address,
          params: toParams(raw),
          proof: Array.isArray(v.proof) ? (v.proof as `0x${string}`[]) : undefined,
          leaf: typeof v.leaf === "string" ? (v.leaf as `0x${string}`) : undefined,
        };
      });
      return {
        entries,
        declaredRoot:
          typeof d.merkleRoot === "string" ? (d.merkleRoot as `0x${string}`) : undefined,
      };
    }
  }

  // Shape 2: [ { address, mintPrice, maxTotalMintableByWallet, … } ]
  const arr = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as Record<string, unknown>).allowList)
      ? ((doc as Record<string, unknown>).allowList as unknown[])
      : null;
  if (arr) {
    const entries: AllowListEntry[] = arr
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((raw) => ({
        address: String(raw.address ?? raw.minter ?? ""),
        params: toParams(raw),
        proof: Array.isArray(raw.proof) ? (raw.proof as `0x${string}`[]) : undefined,
      }))
      .filter((e) => /^0x[0-9a-fA-F]{40}$/.test(e.address));
    return { entries };
  }

  return { entries: [] };
}

export interface Eligibility {
  eligible: boolean;
  params?: MintParams;
  proof?: `0x${string}`[];
  /** Set when the list has the wallet but the proof doesn't match the chain. */
  proofMismatch?: boolean;
}

/**
 * Is `wallet` on this list, and what proof does it need? Any proof shipped with
 * the document is checked against the on-chain root; if it doesn't verify (or
 * isn't there), the tree is rebuilt from the entries and a fresh proof derived.
 */
export function checkEligibility(
  list: ParsedAllowList,
  wallet: string,
  onChainRoot: `0x${string}`,
): Eligibility {
  const w = wallet.toLowerCase();
  const entry = list.entries.find((e) => e.address.toLowerCase() === w);
  if (!entry) return { eligible: false };

  const leaf = mintParamsLeaf(entry.address, entry.params);

  if (entry.proof && verifyProof(leaf, entry.proof, onChainRoot)) {
    return { eligible: true, params: entry.params, proof: entry.proof };
  }

  // Rebuild the tree ourselves — covers plain lists and stale shipped proofs.
  const leaves = list.entries.map((e) => mintParamsLeaf(e.address, e.params));
  const proof = buildProof(leaves, leaf);
  if (verifyProof(leaf, proof, onChainRoot)) {
    return { eligible: true, params: entry.params, proof };
  }

  return { eligible: false, params: entry.params, proofMismatch: true };
}
