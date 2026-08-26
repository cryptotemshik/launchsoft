/**
 * The header's heartbeat: gas price and block height, refreshed on a timer.
 *
 * Read-only and cosmetic — nothing downstream consumes these numbers. They are
 * there for the same reason a terminal shows a clock: a figure that visibly
 * moves is proof the connection is alive, and a figure that stops moving is
 * the earliest warning that it isn't.
 */
import { useEffect, useState } from "react";
import { formatGwei } from "viem";
import { makeReadClient } from "../lib/readClient";
import { useCustomRpcs } from "../lib/customRpc";
import { useActiveChain } from "../signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "../chains";

/** Chain blocks tick sub-second; polling faster than this buys nothing visible. */
const EVERY_MS = 12_000;

export default function GasBlock() {
  const info = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;
  const { urls } = useCustomRpcs();
  const [gas, setGas] = useState<bigint | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);

  useEffect(() => {
    let live = true;
    const client = makeReadClient(info.chain, urls);
    const read = async () => {
      try {
        const [g, b] = await Promise.all([client.getGasPrice(), client.getBlockNumber()]);
        if (!live) return;
        setGas(g);
        setBlock(b);
      } catch {
        // A blink is fine — the stale figure stays up and the next tick retries.
      }
    };
    void read();
    const t = setInterval(read, EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
    // urls is re-read via the hook when the user edits their endpoints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.id, urls.join(",")]);

  /** Gwei with just enough places for a chain whose base fee is ~0.01. */
  const gwei = gas === null ? "—" : Number(formatGwei(gas)).toPrecision(2).replace(/\.?0+$/, "");

  return (
    <span className="gas-block" title={`${info.label} — gas price · block height`}>
      <span className="gb-label">GAS</span>{" "}
      <b>{gwei}</b>
      <span className="gb-sep"> · </span>
      <span className="gb-label">BLOCK</span>{" "}
      <b>{block === null ? "—" : block.toLocaleString("en-US")}</b>
    </span>
  );
}
