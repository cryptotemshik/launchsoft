import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { maxUint256 } from "viem";
import { useSigner } from "../signer";
import { erc20Abi } from "../contracts/seadrop";
import { formatEthShort } from "../lib/profit";
import { AddrLink, TxLink } from "./Bits";

/**
 * Secondary-market currency helper.
 *
 * Which token a sale settles in is chosen per listing on OpenSea, and which
 * tokens OpenSea offers is its own per-chain configuration — no field on the
 * NFT contract controls it, so nothing here can "set" the default. What the
 * seller CAN do up front is approve WETH to Seaport: every OpenSea *offer* is
 * paid in WETH, and accepting one otherwise costs an extra approval tx at the
 * worst moment. Doing it now makes accepting a WETH offer a single signature.
 */
export default function SecondaryMarketPanel() {
  const { address, txAccount, isConnected, walletClient, chainInfo } = useSigner();
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weth = chainInfo?.weth;

  async function refresh() {
    if (!publicClient || !weth || !address || !chainInfo) return;
    try {
      const [a, b] = await Promise.all([
        publicClient.readContract({
          address: weth,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, chainInfo.seaport],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: weth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>,
      ]);
      setAllowance(a);
      setBalance(b);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }

  useEffect(() => {
    setAllowance(null);
    setBalance(null);
    setTxHash(null);
    setError(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, weth, address, chainInfo?.id]);

  async function approve() {
    if (!walletClient || !publicClient || !weth || !txAccount || !chainInfo) return;
    setBusy(true);
    setError(null);
    setTxHash(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: weth,
        abi: erc20Abi,
        functionName: "approve",
        args: [chainInfo.seaport, maxUint256],
        account: txAccount,
      });
      const hash = await walletClient.writeContract(request);
      setTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`Approval reverted (${hash})`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n").slice(0, 2).join(" ") : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!chainInfo) return null;

  const approved = allowance !== null && allowance > 0n;

  return (
    <div className="panel">
      <h2>Secondary market — trading currency</h2>

      <p className="dim" style={{ marginTop: 0 }}>
        <b>Mints are always native ETH</b> — SeaDrop takes payment as{" "}
        <code>msg.value</code>, so no stablecoin can ever be the mint currency.
        On the secondary market the currency is picked <b>per listing</b> on
        OpenSea, and <b>every offer/bid is paid in WETH</b>.
      </p>

      {weth ? (
        <>
          <dl className="kv">
            <dt>WETH on {chainInfo.label}</dt>
            <dd>
              <AddrLink address={weth} />
            </dd>
            <dt>your WETH balance</dt>
            <dd>
              {balance === null
                ? isConnected
                  ? "…"
                  : "connect a wallet to check"
                : `${formatEthShort(balance)} WETH`}
            </dd>
            <dt>Seaport approval</dt>
            <dd>
              {allowance === null ? (
                isConnected ? (
                  "…"
                ) : (
                  <span className="dim">connect a wallet to check</span>
                )
              ) : approved ? (
                <span className="ok">
                  ● approved — WETH offers can be accepted in one signature
                </span>
              ) : (
                <span className="warn">
                  not approved — accepting a WETH offer will cost an extra tx
                </span>
              )}
            </dd>
          </dl>

          <button
            className="primary"
            disabled={!isConnected || busy || approved}
            onClick={approve}
          >
            {busy
              ? "approving…"
              : approved
                ? "WETH already approved for Seaport"
                : !isConnected
                  ? "CONNECT WALLET"
                  : "APPROVE WETH FOR SEAPORT"}
          </button>

          {txHash ? (
            <p className="dim" style={{ marginBottom: 0 }}>
              approval tx: <TxLink hash={txHash} />
            </p>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
        </>
      ) : (
        <p className="warn">
          LaunchPad doesn&apos;t have a verified WETH address for{" "}
          {chainInfo.label}, so the approval helper is hidden here rather than
          risk pointing at a lookalike token. Approve WETH from OpenSea when it
          asks.
        </p>
      )}

      <p className="hint dim" style={{ marginBottom: 0 }}>
        Honest limit: the currency your collection <i>defaults to</i> in
        OpenSea&apos;s UI (USDG on some chains) is OpenSea&apos;s own per-chain
        setting — no contract field controls it, so nothing here can change it.
        List in ETH/WETH by picking that currency in the listing form, and set
        the collection&apos;s accepted tokens under OpenSea → your collection →
        Edit, if that chain exposes the option.
      </p>
    </div>
  );
}
