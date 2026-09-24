/**
 * What an ordinary transfer — fanning ETH out, sweeping it back, moving NFTs —
 * offers to pay for gas.
 *
 * These used to reuse the mint's gas settings, which are set high on purpose:
 * a mint races everyone else for the first block. A transfer races nobody, and
 * the node checks a wallet's balance against the whole gas limit times the
 * max fee before it will take the transaction. At a 5 gwei mint cap, an NFT
 * transfer needed 0.00075 ETH sitting in the wallet to be accepted while
 * actually costing a few thousandths of that — and a sweep reserved that much
 * in every wallet it emptied.
 *
 * So a transfer pays what the chain charges now, with headroom for the base
 * fee to climb before it lands, and never more than the configured cap. The
 * unused part of a max fee is never charged; the headroom only has to be
 * covered by the balance, not spent.
 */
import { formatGwei, parseGwei, type PublicClient } from "viem";

/** Added on top of twice the base fee, so a near-zero base fee still has room. */
export const TRANSFER_FEE_FLOOR_WEI = parseGwei("0.02");

export interface TransferFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * The fee caps for a transfer, given the current base fee and the node's
 * suggested tip. Pure, so the arithmetic is tested without a chain.
 *
 * `capGwei` and `tipCapGwei` are the configured ceilings (the mint settings):
 * a transfer never offers more than those, only — usually far — less.
 */
export function transferFeeCaps(
  baseFee: bigint,
  suggestedTip: bigint,
  capGwei: string,
  tipCapGwei: string,
): TransferFees {
  const cap = parseGwei(capGwei);
  const tipCap = parseGwei(tipCapGwei);
  if (cap < baseFee) {
    throw new Error(
      `max fee (${capGwei} gwei) is below the current base fee (${formatGwei(baseFee)} gwei) — every node would reject it`,
    );
  }
  const tip = suggestedTip < tipCap ? suggestedTip : tipCap;
  const want = baseFee * 2n + tip + TRANSFER_FEE_FLOOR_WEI;
  const maxFeePerGas = want < cap ? want : cap;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas,
  };
}

/** Read the base fee and the node's tip, and cap them as above. */
export async function transferFees(
  client: PublicClient,
  capGwei: string,
  tipCapGwei: string,
): Promise<TransferFees> {
  const block = await client.getBlock();
  // Chains without a tip market (Arbitrum Orbit answers 0) and nodes without
  // the method both fall through to no tip, which such chains ignore anyway.
  const tip = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
  return transferFeeCaps(block.baseFeePerGas ?? 0n, tip, capGwei, tipCapGwei);
}
