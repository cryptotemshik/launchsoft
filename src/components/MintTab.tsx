import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress } from "viem";
import { useSigner } from "../signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID, openSeaItemUrl } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { formatCountdown, parseCollectionInput, weiToEth } from "../lib/convert";
import {
  checkEligibility,
  type Eligibility,
  type MintParams,
} from "../lib/allowlist";
import {
  fetchAllowListSource,
  gateKind,
  hasAllowList,
  type AllowListSource,
} from "../lib/allowlistSource";
import { formatEthShort } from "../lib/profit";
import { pickFeeRecipient } from "../lib/collectionData";
import { TxLink } from "./Bits";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface MintTarget {
  address: `0x${string}`;
  name: string;
  totalSupply: bigint;
  maxSupply: bigint;
  price: bigint;
  startTime: number;
  endTime: number;
  perWallet: number;
  restrictFeeRecipients: boolean;
  allowedFeeRecipients: readonly string[];
  /** Allow-list root + document, when the drop has one. */
  allow?: AllowListSource;
  /** Whether the connected wallet is on that list. */
  eligibility?: Eligibility;
}

/** Which stage the user is minting from. */
type Stage = "public" | "allowlist";

type DropPhase = "unconfigured" | "pending" | "live" | "ended" | "soldout";

function phaseOf(t: MintTarget, now: number): DropPhase {
  if (t.startTime === 0) return "unconfigured";
  if (t.totalSupply >= t.maxSupply) return "soldout";
  if (now < t.startTime) return "pending";
  if (now > t.endTime) return "ended";
  return "live";
}

export default function MintTab() {
  const { address, txAccount, isConnected, walletClient, wrongNetwork, chainInfo } =
    useSigner();
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const [input, setInput] = useState("");
  const [target, setTarget] = useState<MintTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [minting, setMinting] = useState(false);
  const [mintedIds, setMintedIds] = useState<bigint[] | null>(null);
  const [mintTx, setMintTx] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [stage, setStage] = useState<Stage>("public");
  const [checkingAllow, setCheckingAllow] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const active = target ? activeStage(target) : null;
  const phase =
    target && active
      ? phaseOf(
          { ...target, startTime: active.startTime, endTime: active.endTime },
          now,
        )
      : null;

  async function load() {
    const parsed = parseCollectionInput(input);
    if (!parsed) {
      setError("Paste a collection contract address or an OpenSea/Blockscout link");
      return;
    }
    if (!publicClient || !chainInfo) {
      setError("Select a supported network first");
      return;
    }
    const seaDrop = chainInfo.seaDrop;
    setLoading(true);
    setError(null);
    setTarget(null);
    setMintedIds(null);
    setMintTx(null);
    try {
      const read = <T,>(functionName: string): Promise<T> =>
        publicClient.readContract({
          address: parsed,
          abi: tokenAbi,
          functionName,
        } as never) as Promise<T>;
      const [name, totalSupply, maxSupply] = await Promise.all([
        read<string>("name"),
        read<bigint>("totalSupply"),
        read<bigint>("maxSupply"),
      ]);
      const [publicDrop, allowedFeeRecipients] = await Promise.all([
        publicClient.readContract({
          address: seaDrop,
          abi: seaDropAbi,
          functionName: "getPublicDrop",
          args: [parsed],
        }),
        publicClient.readContract({
          address: seaDrop,
          abi: seaDropAbi,
          functionName: "getAllowedFeeRecipients",
          args: [parsed],
        }),
      ]);
      const base: MintTarget = {
        address: parsed,
        name,
        totalSupply,
        maxSupply,
        price: publicDrop.mintPrice,
        startTime: Number(publicDrop.startTime),
        endTime: Number(publicDrop.endTime),
        perWallet: Number(publicDrop.maxTotalMintableByWallet),
        restrictFeeRecipients: publicDrop.restrictFeeRecipients,
        allowedFeeRecipients,
      };
      setTarget(base);
      setQuantity(1);
      setStage("public");
      void checkAllowList(base);
    } catch (e) {
      setError(
        `Could not read this collection — is it a SeaDrop drop on ${chainInfo.label}? (${
          e instanceof Error ? e.message.split("\n")[0] : e
        })`,
      );
    } finally {
      setLoading(false);
    }
  }

  /**
   * Does this drop have an allow-list, and is the connected wallet on it?
   * Runs after the public read so the tab is usable while it resolves.
   */
  async function checkAllowList(t: MintTarget) {
    if (!publicClient || !chainInfo) return;
    setCheckingAllow(true);
    try {
      const source = await fetchAllowListSource(publicClient, chainInfo, t.address);
      let eligibility: Eligibility | undefined;
      if (hasAllowList(source.root) && source.list && address) {
        eligibility = checkEligibility(source.list, address, source.root);
      }
      setTarget((prev) =>
        prev && prev.address === t.address
          ? { ...prev, allow: source, eligibility }
          : prev,
      );
      // Land on the allow-list stage when it's the one that can actually mint.
      if (eligibility?.eligible) setStage("allowlist");
    } catch {
      // Allow-list detection is a bonus — never block the public mint on it.
    } finally {
      setCheckingAllow(false);
    }
  }

  // Re-check when the wallet changes; the answer is per-address.
  useEffect(() => {
    if (target) void checkAllowList(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  /** Price and limit for the stage the user is on. */
  function activeStage(t: MintTarget): {
    price: bigint;
    perWallet: number;
    startTime: number;
    endTime: number;
    params?: MintParams;
  } {
    if (stage === "allowlist" && t.eligibility?.eligible && t.eligibility.params) {
      const p = t.eligibility.params;
      return {
        price: p.mintPrice,
        perWallet: Number(p.maxTotalMintableByWallet),
        startTime: Number(p.startTime),
        endTime: Number(p.endTime),
        params: p,
      };
    }
    return {
      price: t.price,
      perWallet: t.perWallet,
      startTime: t.startTime,
      endTime: t.endTime,
    };
  }

  async function mint() {
    if (!target || !walletClient || !publicClient || !address || !txAccount || !chainInfo)
      return;
    setMinting(true);
    setError(null);
    setMintedIds(null);
    setMintTx(null);
    try {
      const feeRecipient = pickFeeRecipient(
        chainInfo,
        target.allowedFeeRecipients,
        target.restrictFeeRecipients,
      );
      if (!feeRecipient) {
        throw new Error("This drop restricts fee recipients and allows none — cannot mint");
      }
      const active = activeStage(target);
      const value = active.price * BigInt(quantity);
      const el = target.eligibility;
      const useAllowList =
        stage === "allowlist" && el?.eligible && el.params && el.proof;

      // Two distinct calls; each simulated and sent in its own branch so the
      // ABI types stay concrete.
      let hash: `0x${string}`;
      if (useAllowList) {
        const { request } = await publicClient.simulateContract({
          address: chainInfo.seaDrop,
          abi: seaDropAbi,
          functionName: "mintAllowList",
          args: [
            target.address,
            feeRecipient,
            zeroAddress,
            BigInt(quantity),
            el!.params!,
            el!.proof!,
          ],
          account: txAccount,
          value,
        });
        hash = await walletClient.writeContract(request);
      } else {
        const { request } = await publicClient.simulateContract({
          address: chainInfo.seaDrop,
          abi: seaDropAbi,
          functionName: "mintPublic",
          args: [target.address, feeRecipient, zeroAddress, BigInt(quantity)],
          account: txAccount,
          value,
        });
        hash = await walletClient.writeContract(request);
      }
      setMintTx(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`Mint reverted (${hash})`);
      const ids = receipt.logs
        .filter(
          (l) =>
            l.address.toLowerCase() === target.address.toLowerCase() &&
            l.topics[0] === TRANSFER_TOPIC &&
            l.topics[1] ===
              "0x0000000000000000000000000000000000000000000000000000000000000000",
        )
        .map((l) => BigInt(l.topics[3]!));
      setMintedIds(ids);
      // Refresh minted counter.
      const totalSupply = (await publicClient.readContract({
        address: target.address,
        abi: tokenAbi,
        functionName: "totalSupply",
      })) as bigint;
      setTarget({ ...target, totalSupply });
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n").slice(0, 2).join(" ") : String(e));
    } finally {
      setMinting(false);
    }
  }

  const totalCost = active ? active.price * BigInt(quantity || 0) : 0n;

  return (
    <div>
      <div className="panel">
        <h2>Quick mint</h2>
        <p className="dim">
          Manual public mint from YOUR connected wallet — one wallet, one click,
          the same call the drop page makes. For pre-signed multi-wallet
          racing on a public stage, see the SNIPE tab.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="collection address or OpenSea link (opensea.io/assets/robinhood/0x…)"
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <button className="secondary" onClick={load} disabled={loading}>
            {loading ? "reading…" : "read"}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {target && phase && active ? (
        <div className="panel">
          <h2>{target.name}</h2>

          <StagePicker
            target={target}
            stage={stage}
            setStage={setStage}
            checking={checkingAllow}
            walletConnected={Boolean(address)}
          />

          <dl className="kv">
            <dt>minted</dt>
            <dd>
              {target.totalSupply.toString()} / {target.maxSupply.toString()}
            </dd>
            <dt>price</dt>
            <dd>
              {active.price === 0n ? "FREE" : `${weiToEth(active.price)} ETH each`}
              {stage === "allowlist" && active.price !== target.price ? (
                <span className="dim">
                  {" "}
                  (public is{" "}
                  {target.price === 0n ? "FREE" : `${weiToEth(target.price)} ETH`})
                </span>
              ) : null}
            </dd>
            <dt>per wallet</dt>
            <dd>max {active.perWallet}</dd>
            <dt>status</dt>
            <dd>
              {phase === "live" ? (
                <span className="ok">
                  LIVE — ends in {formatCountdown(active.endTime - now)}
                </span>
              ) : phase === "pending" ? (
                <span className="warn">
                  starts in {formatCountdown(active.startTime - now)}
                </span>
              ) : phase === "ended" ? (
                <span className="error">ended</span>
              ) : phase === "soldout" ? (
                <span className="warn">SOLD OUT</span>
              ) : (
                <span className="warn">
                  {stage === "allowlist"
                    ? "allow-list stage not configured"
                    : "public drop not configured"}
                </span>
              )}
            </dd>
          </dl>

          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 12 }}>
            <div className="field" style={{ width: 130 }}>
              <label>quantity (max {active.perWallet})</label>
              <input
                type="number"
                min={1}
                max={active.perWallet}
                value={quantity}
                onChange={(e) =>
                  setQuantity(
                    Math.max(1, Math.min(active.perWallet, Number(e.target.value) || 1)),
                  )
                }
              />
            </div>
            <button
              className="primary"
              style={{ padding: "10px 32px" }}
              disabled={!isConnected || wrongNetwork || phase !== "live" || minting}
              onClick={mint}
            >
              {minting
                ? "minting…"
                : !isConnected
                  ? "CONNECT WALLET"
                  : wrongNetwork
                    ? "SWITCH NETWORK"
                    : `MINT ${quantity}${stage === "allowlist" ? " (ALLOWLIST)" : ""} — ${totalCost === 0n ? "FREE" : `${formatEthShort(totalCost)} ETH`}`}
            </button>
          </div>
          <p className="hint dim" style={{ marginBottom: 0 }}>
            The contract enforces the per-wallet limit; the OpenSea drop fee is
            part of the mint price, not on top of it.
          </p>
        </div>
      ) : null}

      {mintTx ? (
        <div className="panel">
          <h2>Mint result</h2>
          <dl className="kv">
            <dt>tx</dt>
            <dd>
              <TxLink hash={mintTx} />
            </dd>
            {mintedIds && mintedIds.length > 0 ? (
              <>
                <dt>minted</dt>
                <dd>
                  {mintedIds.map((id) => (
                    <div key={id.toString()}>
                      #{id.toString()} —{" "}
                      <a
                        href={openSeaItemUrl(chainInfo ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!, target!.address, id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        view on OpenSea
                      </a>{" "}
                      ·{" "}
                      <a
                        href={openSeaItemUrl(chainInfo ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!, target!.address, id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        sell (opens item page → Sell)
                      </a>
                    </div>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          <p className="dim" style={{ marginBottom: 0 }}>
            Listing happens on opensea.io: the item page&apos;s <b>Sell</b>{" "}
            button lets you set the price, and the wallet will ask for a
            one-time approval on first listing. In-app listing isn&apos;t
            possible from a keyless static app — OpenSea&apos;s order book API
            requires an API key and a backend, and LaunchPad deliberately has
            neither.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Stage selector. Public is always there; the allow-list tab only appears once
 * the drop is known to have one, and is only selectable when the connected
 * wallet actually proves onto it.
 */
function StagePicker({
  target,
  stage,
  setStage,
  checking,
  walletConnected,
}: {
  target: MintTarget;
  stage: Stage;
  setStage: (s: Stage) => void;
  checking: boolean;
  walletConnected: boolean;
}) {
  const allow = target.allow;
  const el = target.eligibility;

  if (checking && !allow) {
    return <p className="dim">checking whether you&apos;re on an allow-list…</p>;
  }
  const kind = allow ? gateKind(allow) : "none";

  if (!allow || kind === "none") {
    return (
      <p className="dim" style={{ marginTop: 0 }}>
        Public stage only — this drop has no allow-list, signature gate or
        token gate.
      </p>
    );
  }

  // Signature-gated: a real allow-list, but membership lives in the signer's
  // backend. No amount of on-chain reading can answer it, and the mint needs
  // that server's signature.
  if (kind === "signed") {
    return (
      <div style={{ marginBottom: 14 }}>
        <p className="warn" style={{ marginTop: 0, marginBottom: 4 }}>
          <b>This drop has a signature-gated allow-list.</b> Its restricted
          stage is authorised by OpenSea signing each mint
          (<code>mintSigned</code>), not by an on-chain list — so whether
          you&apos;re on it is only knowable to OpenSea, and the mint needs
          their signature.
        </p>
        <p className="dim" style={{ marginBottom: 0 }}>
          Mint that stage on opensea.io. The public stage below, when open,
          mints from here as usual.{" "}
          <span className="dim">
            (authorised signer{allow.signers!.length > 1 ? "s" : ""}:{" "}
            {allow.signers!.map((x) => x.slice(0, 10) + "…").join(", ")})
          </span>
        </p>
      </div>
    );
  }

  if (kind === "tokenGated") {
    return (
      <div style={{ marginBottom: 14 }}>
        <p className="warn" style={{ marginTop: 0, marginBottom: 4 }}>
          <b>This drop has a token-gated stage.</b> Holders of{" "}
          {allow.gatedTokens!.map((x) => x.slice(0, 10) + "…").join(", ")} can
          mint it.
        </p>
        <p className="dim" style={{ marginBottom: 0 }}>
          LaunchPad doesn&apos;t mint token-gated stages yet — use opensea.io
          for that one. The public stage below mints from here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="mode-toggle" style={{ marginBottom: 8 }}>
        <button
          className={stage === "public" ? "active" : ""}
          onClick={() => setStage("public")}
        >
          public
        </button>
        <button
          className={stage === "allowlist" ? "active" : ""}
          disabled={!el?.eligible}
          onClick={() => el?.eligible && setStage("allowlist")}
        >
          allowlist {el?.eligible ? "✓" : ""}
        </button>
      </div>

      {allow.problem ? (
        <p className="warn" style={{ marginBottom: 0 }}>
          This drop has an allow-list, but {allow.problem}
        </p>
      ) : !walletConnected ? (
        <p className="dim" style={{ marginBottom: 0 }}>
          This drop has an allow-list — connect a wallet to check whether
          you&apos;re on it.
        </p>
      ) : el?.eligible ? (
        <p className="ok" style={{ marginBottom: 0 }}>
          ● You&apos;re on the allow-list — proof verified against the
          contract&apos;s merkle root, so this mint will go through.
        </p>
      ) : el?.proofMismatch ? (
        <p className="warn" style={{ marginBottom: 0 }}>
          Your wallet is in the published list, but its proof doesn&apos;t match
          the root the contract holds — the list is out of date. Only the public
          stage will mint.
        </p>
      ) : (
        <p className="dim" style={{ marginBottom: 0 }}>
          Your wallet is <b>not</b> on this drop&apos;s allow-list. Public stage
          only.
        </p>
      )}
    </div>
  );
}
