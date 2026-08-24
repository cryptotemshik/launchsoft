import { useMemo, useState, type ReactNode } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress } from "viem";
import { useSigner } from "../signer";
import { tokenAbi } from "../contracts/seadrop";
import {
  fetchCollectionStatus,
  fetchProfitData,
  type CollectionStatus,
} from "../lib/collectionData";
import {
  datetimeLocalToUnix,
  ethToWei,
  isAddress,
  UINT16_MAX,
  weiToEth,
} from "../lib/convert";
import { loadLaunchState } from "../lib/launchState";
import { upsertProject } from "../lib/projects";
import { CollectionDetail, ProfitBlock, type ProfitView } from "./CollectionDetail";
import DropWindowPanel from "./DropWindowPanel";
import SecondaryMarketPanel from "./SecondaryMarketPanel";
import { TxLink } from "./Bits";

const ZERO = zeroAddress as string;

export default function StatusTab() {
  const { address, txAccount, walletClient, wrongNetwork, chainInfo } = useSigner();
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const saved = useMemo(loadLaunchState, []);
  const [contract, setContract] = useState(saved?.contractAddress ?? "");
  const [status, setStatus] = useState<CollectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profit, setProfit] = useState<ProfitView | null>(null);

  // Owner action form state
  const [newPrice, setNewPrice] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newLimit, setNewLimit] = useState("");
  const [newMaxSupply, setNewMaxSupply] = useState("");
  const [actionMsg, setActionMsg] = useState<ReactNode>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const isOwner = Boolean(
    status && address && status.owner.toLowerCase() === address.toLowerCase(),
  );
  async function load() {
    if (!isAddress(contract)) {
      setError("Enter a valid contract address");
      return;
    }
    if (!publicClient || !chainInfo) {
      setError("Select a supported network first");
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    setProfit(null);
    try {
      const target = contract as `0x${string}`;
      const s = await fetchCollectionStatus(publicClient, target, chainInfo);
      setStatus(s);
      setNewPrice(weiToEth(s.publicDrop.mintPrice));
      setNewLimit(String(s.publicDrop.maxTotalMintableByWallet));
      setNewStart("");
      setNewEnd("");
      setNewMaxSupply("");
      setProfit({ loading: true, ethUsd: null });
      try {
        const p = await fetchProfitData(publicClient, target, s, chainInfo);
        setProfit({ loading: false, ethUsd: p.ethUsd, breakdown: p.breakdown });
      } catch (e) {
        setProfit({
          loading: false,
          ethUsd: null,
          error: e instanceof Error ? e.message.split("\n")[0] : String(e),
        });
      }
    } catch (e) {
      setError(
        `Could not read drop state — is this an ERC721SeaDrop on Robinhood Chain? (${
          e instanceof Error ? e.message.split("\n")[0] : e
        })`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function ownerTx(
    functionName:
      | "updatePublicDrop"
      | "setMaxSupply"
      | "setTransferValidator"
      | "updateDropURI",
    args: unknown[],
  ) {
    if (!walletClient || !publicClient || !address || !txAccount) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: contract as `0x${string}`,
        abi: tokenAbi,
        functionName,
        args,
        account: txAccount,
      } as never);
      const hash = await walletClient.writeContract(request as never);
      await publicClient.waitForTransactionReceipt({ hash });
      setActionMsg(
        <span className="ok">
          {functionName} confirmed: <TxLink hash={hash} />
        </span>,
      );
      await load();
    } catch (e) {
      setActionMsg(<span className="error">{(e as Error).message}</span>);
    } finally {
      setActionBusy(false);
    }
  }

  async function sendUpdatePublicDrop() {
    if (!status) return;
    try {
      const mintPrice = ethToWei(newPrice || "0");
      const startTime = newStart
        ? datetimeLocalToUnix(newStart)
        : status.publicDrop.startTime;
      const endTime = newEnd ? datetimeLocalToUnix(newEnd) : status.publicDrop.endTime;
      const limit = Number(newLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > UINT16_MAX) {
        throw new Error(`Per-wallet limit must be 1..${UINT16_MAX}`);
      }
      if (endTime <= startTime) throw new Error("End time must be after start time");
      if (!chainInfo) throw new Error("Select a supported network first");
      await ownerTx("updatePublicDrop", [
        chainInfo.seaDrop,
        {
          mintPrice,
          startTime,
          endTime,
          maxTotalMintableByWallet: limit,
          feeBps: status.publicDrop.feeBps || chainInfo.feeBps,
          restrictFeeRecipients: true,
        },
      ]);
    } catch (e) {
      setActionMsg(<span className="error">{(e as Error).message}</span>);
    }
  }

  /** Update only the window, leaving price / limit / fee untouched. */
  async function sendSetWindow(startTime: number, endTime: number) {
    if (!status || !chainInfo) return;
    try {
      if (endTime <= startTime) throw new Error("End time must be after start time");
      await ownerTx("updatePublicDrop", [
        chainInfo.seaDrop,
        {
          mintPrice: status.publicDrop.mintPrice,
          startTime,
          endTime,
          maxTotalMintableByWallet: status.publicDrop.maxTotalMintableByWallet,
          feeBps: status.publicDrop.feeBps || chainInfo.feeBps,
          restrictFeeRecipients: true,
        },
      ]);
    } catch (e) {
      setActionMsg(<span className="error">{(e as Error).message}</span>);
    }
  }

  /** Publish stage metadata (name/description) on-chain via updateDropURI. */
  async function sendSetStageMeta(dropUriJson: string) {
    if (!chainInfo) return;
    // Inline data: URI — no IPFS round-trip for a couple of short strings.
    const uri = `data:application/json;base64,${btoa(
      String.fromCharCode(...new TextEncoder().encode(dropUriJson)),
    )}`;
    await ownerTx("updateDropURI", [chainInfo.seaDrop, uri]);
  }

  async function sendSetMaxSupply() {
    if (!status) return;
    const n = Number(newMaxSupply);
    if (!Number.isInteger(n) || n < 1) {
      setActionMsg(<span className="error">Enter a whole number</span>);
      return;
    }
    if (BigInt(n) < status.totalSupply) {
      setActionMsg(
        <span className="error">
          Cannot set maxSupply below what&apos;s already minted ({status.totalSupply.toString()})
        </span>,
      );
      return;
    }
    await ownerTx("setMaxSupply", [BigInt(n)]);
  }

  return (
    <div>
      <div className="panel">
        <h2>Drop status</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={contract}
            onChange={(e) => setContract(e.target.value.trim())}
            placeholder="0x… (prefilled from saved launch)"
          />
          <button className="secondary" onClick={load} disabled={loading}>
            {loading ? "reading…" : "read"}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {status ? (
        <>
          <div className="panel">
            <h2>
              {status.name} ({status.symbol})
            </h2>
            <CollectionDetail contract={contract} status={status} isOwner={isOwner} />
            <p style={{ marginBottom: 0 }}>
              <button
                className="secondary"
                onClick={() => {
                  upsertProject({ address: contract, name: status.name, source: "manual" });
                  setActionMsg(<span className="ok">added to Dashboard</span>);
                }}
              >
                + track on Dashboard
              </button>
            </p>
          </div>

          <div className="panel">
            <h2>Profit</h2>
            {!profit || profit.loading ? (
              <p className="dim">computing from on-chain data…</p>
            ) : profit.error ? (
              <p className="error">Could not compute profit: {profit.error}</p>
            ) : profit.breakdown ? (
              <ProfitBlock b={profit.breakdown} ethUsd={profit.ethUsd} />
            ) : null}
          </div>

          <DropWindowPanel
            status={status}
            isOwner={isOwner}
            busy={actionBusy || wrongNetwork}
            onSetWindow={sendSetWindow}
            onSetStageMeta={sendSetStageMeta}
          />

          {isOwner ? (
            <div className="panel">
              <h2>Owner actions</h2>
              {wrongNetwork ? (
                <p className="warn">Switch to Robinhood Chain to send transactions.</p>
              ) : null}
              <div className="grid">
                <div className="field">
                  <label>new price (ETH)</label>
                  <input value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
                </div>
                <div className="field">
                  <label>new per-wallet limit</label>
                  <input value={newLimit} onChange={(e) => setNewLimit(e.target.value)} />
                </div>
                <div className="field">
                  <label>new start (empty = keep)</label>
                  <input
                    type="datetime-local"
                    value={newStart}
                    onChange={(e) => setNewStart(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>new end (empty = keep)</label>
                  <input
                    type="datetime-local"
                    value={newEnd}
                    onChange={(e) => setNewEnd(e.target.value)}
                  />
                </div>
              </div>
              <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="secondary"
                  disabled={actionBusy || wrongNetwork}
                  onClick={sendUpdatePublicDrop}
                >
                  updatePublicDrop
                </button>
                <button
                  className="secondary"
                  disabled={
                    actionBusy ||
                    wrongNetwork ||
                    (status.transferValidator === ZERO && !chainInfo?.transferValidator)
                  }
                  onClick={() =>
                    ownerTx("setTransferValidator", [
                      status.transferValidator === ZERO
                        ? chainInfo!.transferValidator!
                        : zeroAddress,
                    ])
                  }
                >
                  {status.transferValidator === ZERO
                    ? chainInfo?.transferValidator
                      ? "enforce royalties (set OpenSea validator)"
                      : "enforcement unavailable on this chain"
                    : "disable enforcement (validator → 0x0)"}
                </button>
              </p>
              <div className="grid">
                <div className="field">
                  <label>
                    new maxSupply (cut supply after mint slows — cannot go below minted)
                  </label>
                  <input
                    value={newMaxSupply}
                    onChange={(e) => setNewMaxSupply(e.target.value)}
                    placeholder={status.maxSupply.toString()}
                  />
                </div>
                <div className="field" style={{ justifyContent: "end" }}>
                  <button
                    className="danger"
                    disabled={actionBusy || wrongNetwork || !newMaxSupply}
                    onClick={sendSetMaxSupply}
                  >
                    setMaxSupply
                  </button>
                </div>
              </div>
              {actionMsg ? <p>{actionMsg}</p> : null}
            </div>
          ) : actionMsg ? (
            <p>{actionMsg}</p>
          ) : null}
        </>
      ) : null}

      <SecondaryMarketPanel />
    </div>
  );
}
