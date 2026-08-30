/**
 * The rules a transaction must pass before a wallet signs it.
 *
 * This is the layer that decides what a break-in is worth. The API faces the
 * internet through a tunnel; the wallets sign whatever they are handed. If
 * those two facts stay directly connected, any bug in the API is worth every
 * wallet on the box. With this in between, owning the API is worth exactly
 * what the policy allows — minting NFTs and moving funds between our own
 * wallets — because everything an attacker actually wants to do is refused.
 *
 * The whole surface is three shapes of transaction, which is what makes a
 * closed policy possible at all:
 *
 *   - a mint: a call to the chain's SeaDrop, one of three mint functions
 *   - a transfer: ETH out, no calldata — funding wallets, or withdrawing
 *   - an NFT move: transferFrom on some collection, recipient in calldata
 *
 * Everything else is refused, including anything this codebase never sends.
 * A policy that lists what is forbidden loses the first time an attacker
 * thinks of something the list's author did not; one that lists what is
 * allowed cannot.
 *
 * Deliberately pure — a function from a transaction and a context to a
 * verdict — so it is testable to destruction here, and moves into the signer
 * process unchanged when the process split lands. Until then it is enforced
 * at the API routes where user input becomes a destination.
 */
import { toFunctionSelector } from "viem";

/** The three functions a wallet is allowed to call on SeaDrop, by selector. */
export const MINT_SELECTORS: ReadonlySet<string> = new Set(
  [
    "function mintPublic(address,address,address,uint256)",
    "function mintAllowList(address,address,address,uint256,(uint80,uint48,uint48,uint16,uint16,bool),bytes32[])",
    "function mintSigned(address,address,address,uint256,(uint80,uint48,uint48,uint16,uint16,bool),uint256,bytes)",
  ].map((sig) => toFunctionSelector(sig)),
);

/** transferFrom / safeTransferFrom (both overloads) — the NFT-moving calls. */
const NFT_TRANSFER_SELECTORS: ReadonlySet<string> = new Set(
  [
    "function transferFrom(address,address,uint256)",
    "function safeTransferFrom(address,address,uint256)",
    "function safeTransferFrom(address,address,uint256,bytes)",
  ].map((sig) => toFunctionSelector(sig)),
);

export interface PolicyContext {
  /**
   * Our own wallet addresses, lower-case. Money moving between them never
   * leaves the box, so it is always allowed — funding before a drop is the
   * one thing that must keep working while a job is armed.
   */
  ownWallets: ReadonlySet<string>;
  /**
   * Where funds may leave to, lower-case. For now this comes from the config;
   * once accounts exist it is the address the person signed in with, which is
   * the one address a session thief provably does not control.
   */
  withdrawTo: ReadonlySet<string>;
  /** The chain's SeaDrop — the one contract mint calls are allowed to hit. */
  mintContract: string;
  /**
   * The most ETH one mint call may carry.
   *
   * This exists because a mint is the one hole in a destination whitelist: an
   * attacker who can queue jobs could deploy a "drop" priced at 10 ETH whose
   * creator payout is their own address, and drain wallets through a
   * perfectly legitimate mint. A cap turns that from a drain into a nuisance.
   * Zero means "free mints only".
   */
  maxMintWei: bigint;
}

export interface TxToJudge {
  /** Missing `to` is contract creation, which nothing here ever does. */
  to?: string;
  value: bigint;
  data?: string;
}

export type Verdict =
  | { ok: true; kind: "mint" | "transfer-own" | "withdraw" | "nft-move" }
  | { ok: false; reason: string };

const lc = (s: string | undefined) => (s ?? "").toLowerCase();
const hasData = (d: string | undefined) => d !== undefined && d !== "" && d !== "0x";

/** The recipient of a transferFrom-shaped call: the second address argument. */
function nftRecipient(data: string): string | null {
  // selector (4 bytes) + from (32) + to (32) + …; addresses are the last 20
  // bytes of their word. Char offsets: 2 + 8 + 64 = word 2 starts at 74.
  if (data.length < 2 + 8 + 64 * 3) return null;
  const word = data.slice(2 + 8 + 64, 2 + 8 + 64 * 2);
  // An address is 12 zero bytes then 20 real ones; anything else in the high
  // bytes means this is not the call shape we think it is.
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return null;
  return `0x${word.slice(24)}`.toLowerCase();
}

/**
 * Judge one transaction. Refusals name their reason, because the reason ends
 * up in the audit log and in the error the caller sees — a bare "no" teaches
 * an operator nothing and an attacker just as little.
 */
export function judgeTransaction(tx: TxToJudge, ctx: PolicyContext): Verdict {
  const to = lc(tx.to);
  if (!to) return { ok: false, reason: "contract creation is never signed" };

  // ── A call to SeaDrop: a mint, if it is one of the three mint functions ──
  if (to === lc(ctx.mintContract)) {
    const selector = hasData(tx.data) ? tx.data!.slice(0, 10).toLowerCase() : "";
    if (!MINT_SELECTORS.has(selector)) {
      return { ok: false, reason: `not a mint function (selector ${selector || "none"})` };
    }
    if (tx.value > ctx.maxMintWei) {
      return {
        ok: false,
        reason:
          `mint value ${tx.value} wei exceeds the policy cap ${ctx.maxMintWei} — ` +
          `raise SNIPE_POLICY_MAX_MINT_ETH if this drop really costs that`,
      };
    }
    return { ok: true, kind: "mint" };
  }

  // ── No calldata: plain ETH. Only between our wallets, or out the one door ──
  if (!hasData(tx.data)) {
    if (ctx.ownWallets.has(to)) return { ok: true, kind: "transfer-own" };
    if (ctx.withdrawTo.has(to)) return { ok: true, kind: "withdraw" };
    return {
      ok: false,
      reason: `plain transfer to ${to} refused — not one of our wallets and not a registered withdrawal address`,
    };
  }

  // ── transferFrom on some contract: an NFT move, judged by its recipient ──
  const selector = tx.data!.slice(0, 10).toLowerCase();
  if (NFT_TRANSFER_SELECTORS.has(selector)) {
    if (tx.value !== 0n) {
      return { ok: false, reason: "an NFT transfer carrying ETH is not a shape we ever send" };
    }
    const recipient = nftRecipient(tx.data!);
    if (!recipient) return { ok: false, reason: "transferFrom calldata is malformed" };
    if (ctx.ownWallets.has(recipient) || ctx.withdrawTo.has(recipient)) {
      return { ok: true, kind: "nft-move" };
    }
    return {
      ok: false,
      reason: `NFT transfer to ${recipient} refused — not one of our wallets and not a registered withdrawal address`,
    };
  }

  return {
    ok: false,
    reason: `call to ${to} with selector ${selector} is nothing this server ever sends`,
  };
}

/**
 * Judge a batch and refuse it whole on the first failure.
 *
 * All-or-nothing on purpose: a sweep where half the transfers went to the
 * right place is not half-safe, it is a confusing incident. The index is
 * named so the caller can say which transaction sank it.
 */
export function judgeAll(
  txs: readonly TxToJudge[],
  ctx: PolicyContext,
): { ok: true } | { ok: false; index: number; reason: string } {
  for (let i = 0; i < txs.length; i++) {
    const v = judgeTransaction(txs[i], ctx);
    if (!v.ok) return { ok: false, index: i, reason: v.reason };
  }
  return { ok: true };
}
