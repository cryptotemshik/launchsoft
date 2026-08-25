import { useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { encodeFunctionData, formatGwei, parseGwei, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { useActiveChain } from "../signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { pickFeeRecipient } from "../lib/collectionData";
import { checkEligibility, type Eligibility, type MintParams } from "../lib/allowlist";
import {
  fetchAllowListSource,
  gateKind,
  hasAllowList,
  type AllowListSource,
} from "../lib/allowlistSource";
import {
  formatCountdown,
  normalizePrivateKey,
  parseCollectionInput,
  unixToLocalAndUtc,
  weiToEth,
} from "../lib/convert";
import { formatEthShort } from "../lib/profit";
import {
  blastToAll,
  isAlreadyKnown,
  parseRpcEndpoints,
  prepareBlast,
  waitForReceiptOrNull,
  warmEndpoints,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { waitUntil } from "../lib/snipeTimer";
import { Steps, TxLink, type StepView } from "./Bits";
import RemoteRunner from "./RemoteRunner";

interface SnipeTarget {
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
}

type Stage = "public" | "allowlist";
type DropPhase = "unconfigured" | "pending" | "live" | "ended" | "soldout";

function phaseOf(startTime: number, endTime: number, minted: bigint, supply: bigint, now: number): DropPhase {
  if (startTime === 0) return "unconfigured";
  if (minted >= supply && supply > 0n) return "soldout";
  if (now < startTime) return "pending";
  if (now > endTime) return "ended";
  return "live";
}

interface ParsedKey {
  raw: string;
  address?: `0x${string}`;
  account?: PrivateKeyAccount;
  error?: string;
}

function parseKeys(text: string): ParsedKey[] {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((raw) => {
      try {
        const account = privateKeyToAccount(normalizePrivateKey(raw));
        const addr = account.address.toLowerCase();
        if (seen.has(addr)) return { raw, error: "duplicate — already listed above" };
        seen.add(addr);
        return { raw, address: account.address, account };
      } catch (e) {
        return { raw, error: e instanceof Error ? e.message : String(e) };
      }
    });
}

type FireStatus =
  | "queued"
  | "skipped"
  | "dispatched"
  | "accepted"
  | "mined"
  | "reverted"
  | "rejected"
  | "timeout";

interface FireRow {
  address: `0x${string}`;
  status: FireStatus;
  txHash?: Hex;
  detail?: string;
}

const STEP_STATUS: Record<FireStatus, StepView["status"]> = {
  queued: "pending",
  skipped: "pending",
  dispatched: "running",
  accepted: "running",
  mined: "done",
  reverted: "failed",
  rejected: "failed",
  timeout: "failed",
};

type Phase = "form" | "confirm" | "firing";
type Timing = "now" | "wait";

export default function SnipeTab() {
  const chainInfo = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID);
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const [input, setInput] = useState("");
  const [target, setTarget] = useState<SnipeTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [checkingAllow, setCheckingAllow] = useState(false);
  const [stage, setStage] = useState<Stage>("public");

  const [keysText, setKeysText] = useState("");
  const [extraRpcText, setExtraRpcText] = useState("");
  const [quantity, setQuantity] = useState(1);
  // "max" defers the number to the stage, which matters when queueing several
  // drops that each declare their own per-wallet cap.
  const [maxQuantity, setMaxQuantity] = useState(false);
  const [maxFeeGwei, setMaxFeeGwei] = useState("2");
  const [tipGwei, setTipGwei] = useState("0.05");
  const [gasLimitStr, setGasLimitStr] = useState("250000");
  const [baseFeeWei, setBaseFeeWei] = useState<bigint | null>(null);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());

  const [timing, setTiming] = useState<Timing>("now");
  const [phase, setPhase] = useState<Phase>("form");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [countdownMs, setCountdownMs] = useState<number | null>(null);
  const [rows, setRows] = useState<FireRow[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const parsedKeys = useMemo(() => parseKeys(keysText), [keysText]);
  const accounts = useMemo(
    () => parsedKeys.map((k) => k.account).filter((a): a is PrivateKeyAccount => Boolean(a)),
    [parsedKeys],
  );
  const keyErrors = parsedKeys.filter((k) => k.error);

  // Per-wallet allow-list eligibility, computed from the fetched list + pasted
  // keys. Each wallet needs its own proof, so this is exactly the same shape
  // as the public path — just per-wallet calldata instead of one shared blob.
  const eligByAddr = useMemo(() => {
    const map = new Map<string, Eligibility>();
    const allow = target?.allow;
    if (allow?.list && hasAllowList(allow.root)) {
      for (const a of accounts) {
        map.set(a.address.toLowerCase(), checkEligibility(allow.list, a.address, allow.root));
      }
    }
    return map;
  }, [target?.allow, accounts]);

  const allowKind = target?.allow ? gateKind(target.allow) : "none";
  const hasMerkle = allowKind === "merkle";
  const eligibleAccounts = accounts.filter((a) => eligByAddr.get(a.address.toLowerCase())?.eligible);
  // Representative allow-list params (window/price) — same across the list.
  const allowParams: MintParams | undefined = eligibleAccounts
    .map((a) => eligByAddr.get(a.address.toLowerCase())?.params)
    .find(Boolean);

  const endpoints: RpcEndpoint[] = useMemo(() => {
    const defaults = chainInfo?.chain.rpcUrls.default.http ?? [];
    // The chain's own sequencer, where it has one: an L2 orders by arrival
    // time, so this is the shortest path into the queue.
    const submit = chainInfo?.submitRpcs ?? [];
    const extra = extraRpcText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return parseRpcEndpoints([...submit, ...defaults, ...extra]);
  }, [chainInfo, extraRpcText]);

  // Live base fee, so the gas fields have a real number to aim above.
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    async function poll() {
      try {
        const block = await publicClient!.getBlock();
        if (!cancelled) setBaseFeeWei(block.baseFeePerGas ?? null);
      } catch {
        // public RPC hiccup — keep showing the last known value
      }
    }
    void poll();
    const t = setInterval(poll, 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [publicClient]);

  // Wallet balances — re-checked whenever the wallet list changes.
  useEffect(() => {
    if (!publicClient || accounts.length === 0) {
      setBalances(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      accounts.map(
        async (a) => [a.address, await publicClient.getBalance({ address: a.address })] as const,
      ),
    ).then((pairs) => {
      if (!cancelled) setBalances(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.map((a) => a.address).join(","), publicClient]);

  // ── Active stage: price / per-wallet limit / window depend on the stage ──
  const stagePrice = stage === "allowlist" && allowParams ? allowParams.mintPrice : target?.price ?? 0n;
  const stagePerWallet =
    stage === "allowlist" && allowParams
      ? Number(allowParams.maxTotalMintableByWallet)
      : target?.perWallet ?? 0;
  const stageStart =
    stage === "allowlist" && allowParams ? Number(allowParams.startTime) : target?.startTime ?? 0;
  const stageEnd =
    stage === "allowlist" && allowParams ? Number(allowParams.endTime) : target?.endTime ?? 0;

  let maxFeePerGas: bigint | null = null;
  let maxPriorityFeePerGas: bigint | null = null;
  let gasLimit: bigint | null = null;
  let gasError: string | null = null;
  try {
    maxFeePerGas = parseGwei(maxFeeGwei || "0");
  } catch {
    gasError = "max fee isn't a valid gwei amount";
  }
  try {
    maxPriorityFeePerGas = parseGwei(tipGwei || "0");
  } catch {
    gasError = gasError ?? "tip isn't a valid gwei amount";
  }
  try {
    gasLimit = BigInt(gasLimitStr || "0");
    if (gasLimit <= 0n) throw new Error();
  } catch {
    gasError = gasError ?? "gas limit must be a whole number";
  }
  if (!gasError && maxFeePerGas !== null && maxPriorityFeePerGas !== null && maxPriorityFeePerGas > maxFeePerGas) {
    gasError = "tip cannot exceed max fee — invalid under EIP-1559";
  }
  if (!gasError && baseFeeWei !== null && maxFeePerGas !== null && maxFeePerGas < baseFeeWei) {
    gasError = `max fee is below the current base fee (${formatGwei(baseFeeWei)} gwei) — every node will reject it`;
  }

  // "max" resolves against the stage's own cap, which is only known after read.
  const effectiveQty = maxQuantity && stagePerWallet > 0 ? stagePerWallet : quantity;
  const requiredPerWallet =
    (gasLimit ?? 0n) * (maxFeePerGas ?? 0n) + stagePrice * BigInt(effectiveQty);
  // In allowlist mode, only eligible wallets fire — judge affordability on those.
  const firingAccounts = stage === "allowlist" ? eligibleAccounts : accounts;
  const unaffordable = firingAccounts.filter((a) => {
    const bal = balances.get(a.address.toLowerCase());
    return bal !== undefined && bal < requiredPerWallet;
  });

  const phaseDrop = target ? phaseOf(stageStart, stageEnd, target.totalSupply, target.maxSupply, now) : null;

  useEffect(() => {
    if (phaseDrop === "pending") setTiming("wait");
    else if (phaseDrop === "live") setTiming("now");
  }, [phaseDrop]);

  // Clamp quantity to the active stage's per-wallet cap.
  useEffect(() => {
    if (stagePerWallet > 0) setQuantity((q) => Math.min(Math.max(1, q), stagePerWallet));
  }, [stagePerWallet]);

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
    setLoading(true);
    setError(null);
    setTarget(null);
    setRows([]);
    setStage("public");
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
          address: chainInfo.seaDrop,
          abi: seaDropAbi,
          functionName: "getPublicDrop",
          args: [parsed],
        }),
        publicClient.readContract({
          address: chainInfo.seaDrop,
          abi: seaDropAbi,
          functionName: "getAllowedFeeRecipients",
          args: [parsed],
        }),
      ]);
      const base: SnipeTarget = {
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

  /** Fetch the allow-list document once for the collection (per-wallet proofs
   *  are derived locally in eligByAddr). Runs after the public read. */
  async function checkAllowList(t: SnipeTarget) {
    if (!publicClient || !chainInfo) return;
    setCheckingAllow(true);
    try {
      const source = await fetchAllowListSource(publicClient, chainInfo, t.address);
      setTarget((prev) => (prev && prev.address === t.address ? { ...prev, allow: source } : prev));
    } catch {
      // Allow-list detection is a bonus — never block the public snipe on it.
    } finally {
      setCheckingAllow(false);
    }
  }

  function cancelWait() {
    abortRef.current?.abort();
  }

  async function fire() {
    if (!target || !publicClient || !chainInfo) return;
    if (endpoints.length === 0) {
      setError("No RPC endpoint available for this chain — add one");
      return;
    }
    if (gasError || maxFeePerGas === null || maxPriorityFeePerGas === null || gasLimit === null) {
      setError(gasError ?? "Fix the gas settings first");
      return;
    }
    if (firingAccounts.length === 0) {
      setError(
        stage === "allowlist"
          ? "None of the pasted wallets are on this drop's allow-list"
          : "Paste at least one valid private key",
      );
      return;
    }

    setPhase("firing");
    setError(null);
    // Every pasted wallet gets a row; ineligible ones (allowlist mode) are
    // marked skipped up front so the log shows the full picture.
    setRows(
      accounts.map((a) => {
        const firing = firingAccounts.some((f) => f.address === a.address);
        return {
          address: a.address,
          status: firing ? "queued" : "skipped",
          detail: firing ? undefined : "not on this drop's allow-list",
        };
      }),
    );

    try {
      const feeRecipient = pickFeeRecipient(
        chainInfo,
        target.allowedFeeRecipients,
        target.restrictFeeRecipients,
      );
      if (!feeRecipient) {
        throw new Error("This drop restricts fee recipients and allows none — cannot mint");
      }

      // Per-wallet calldata: identical for the public stage, but each allow-list
      // wallet carries its own proof + params, so it's built per wallet.
      const nonces = await Promise.all(
        firingAccounts.map((a) =>
          publicClient.getTransactionCount({ address: a.address, blockTag: "pending" }),
        ),
      );
      const prepared = await Promise.all(
        firingAccounts.map(async (a, i) => {
          let data: Hex;
          let value: bigint;
          let qty: number;
          if (stage === "allowlist") {
            const el = eligByAddr.get(a.address.toLowerCase())!;
            qty = Math.min(effectiveQty, Number(el.params!.maxTotalMintableByWallet) || effectiveQty);
            data = encodeFunctionData({
              abi: seaDropAbi,
              functionName: "mintAllowList",
              args: [target.address, feeRecipient, zeroAddress, BigInt(qty), el.params!, el.proof!],
            });
            value = el.params!.mintPrice * BigInt(qty);
          } else {
            qty = effectiveQty;
            data = encodeFunctionData({
              abi: seaDropAbi,
              functionName: "mintPublic",
              args: [target.address, feeRecipient, zeroAddress, BigInt(qty)],
            });
            value = target.price * BigInt(qty);
          }
          const rawTx = await a.signTransaction({
            chainId: chainInfo.id,
            to: chainInfo.seaDrop,
            data,
            value,
            nonce: nonces[i],
            maxFeePerGas: maxFeePerGas!,
            maxPriorityFeePerGas: maxPriorityFeePerGas!,
            gas: gasLimit!,
            type: "eip1559",
          });
          return { address: a.address, blast: prepareBlast(rawTx) };
        }),
      );

      // Open every connection now so the broadcast pays only a round-trip.
      await warmEndpoints(endpoints);

      if (timing === "wait" && stageStart * 1000 > Date.now()) {
        abortRef.current = new AbortController();
        const outcome = await waitUntil(stageStart * 1000, {
          onTick: setCountdownMs,
          signal: abortRef.current.signal,
          // Re-warm shortly before the stage opens: a long hold would
          // otherwise let idle connections drop and hand back the TLS cost.
          onApproach: () => void warmEndpoints(endpoints),
        });
        setCountdownMs(null);
        if (outcome === "aborted") {
          setPhase("form");
          return;
        }
      }

      setRows((prev) =>
        prev.map((r) => {
          const p = prepared.find((x) => x.address === r.address);
          return p ? { ...r, status: "dispatched", txHash: p.blast.txHash } : r;
        }),
      );

      await Promise.all(
        prepared.map(async ({ address, blast }) => {
          const { results } = blastToAll(blast, endpoints);
          const settled = await results;
          const accepted = settled.some((r) => r.txHash !== null || isAlreadyKnown(r.error));
          if (!accepted) {
            const reasons = [...new Set(settled.map((r) => r.error).filter(Boolean))].join("; ");
            setRows((prev) =>
              prev.map((r) => (r.address === address ? { ...r, status: "rejected", detail: reasons } : r)),
            );
            return;
          }
          setRows((prev) => prev.map((r) => (r.address === address ? { ...r, status: "accepted" } : r)));
          const receipt = await waitForReceiptOrNull(publicClient, blast.txHash, 60_000);
          if (!receipt) {
            setRows((prev) =>
              prev.map((r) =>
                r.address === address
                  ? { ...r, status: "timeout", detail: "no receipt yet — check the explorer link" }
                  : r,
              ),
            );
            return;
          }
          setRows((prev) =>
            prev.map((r) =>
              r.address === address
                ? { ...r, status: receipt.status === "success" ? "mined" : "reverted" }
                : r,
            ),
          );
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("form");
    }
  }

  const totalMintCost = stagePrice * BigInt(effectiveQty) * BigInt(firingAccounts.length);
  const canFire =
    Boolean(target) &&
    firingAccounts.length > 0 &&
    endpoints.length > 0 &&
    !gasError &&
    (phaseDrop === "live" || phaseDrop === "pending");

  return (
    <div>
      <div className="panel">
        <h2>Snipe</h2>
        <p className="dim">
          Pre-signed, multi-wallet racing for a SeaDrop drop — <b>public</b> or{" "}
          <b>allow-list</b>. Paste any number of private keys and each wallet
          builds and signs its transaction locally from on-chain drop data,
          then blasts it to every configured RPC the instant the stage opens.
          Allow-list wallets each carry their own merkle proof (verified against
          the contract&apos;s root); wallets not on the list are skipped.
        </p>
        <p className="warn" style={{ marginBottom: 0 }}>
          Racing to fire faster than other bidders. It doesn&apos;t touch anyone
          else&apos;s wallet or bypass anything the contract enforces — but it is
          a competitive-advantage tool, not a neutral one. Use it on your own
          judgment.
        </p>
      </div>

      <div className="panel">
        <h2>Target</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="collection address or OpenSea link"
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <button className="secondary" onClick={load} disabled={loading}>
            {loading ? "reading…" : "read"}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}

        {target ? (
          <>
            <StagePicker
              target={target}
              stage={stage}
              setStage={setStage}
              checking={checkingAllow}
              hasMerkle={hasMerkle}
              allowKind={allowKind}
              eligibleCount={eligibleAccounts.length}
              walletCount={accounts.length}
            />
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>collection</dt>
              <dd>{target.name}</dd>
              <dt>minted</dt>
              <dd>
                {target.totalSupply.toString()} / {target.maxSupply.toString()}
              </dd>
              <dt>price</dt>
              <dd>{stagePrice === 0n ? "FREE" : `${weiToEth(stagePrice)} ETH each`}</dd>
              <dt>per wallet</dt>
              <dd>max {stagePerWallet}</dd>
              <dt>status</dt>
              <dd>
                {phaseDrop === "live" ? (
                  <span className="ok">LIVE — ends in {formatCountdown(stageEnd - now)}</span>
                ) : phaseDrop === "pending" ? (
                  <span className="warn">
                    starts in {formatCountdown(stageStart - now)} ({unixToLocalAndUtc(stageStart).local})
                  </span>
                ) : phaseDrop === "ended" ? (
                  <span className="error">ended</span>
                ) : phaseDrop === "soldout" ? (
                  <span className="warn">SOLD OUT</span>
                ) : (
                  <span className="warn">
                    {stage === "allowlist" ? "allow-list stage not configured" : "public drop not configured"}
                  </span>
                )}
              </dd>
            </dl>
          </>
        ) : null}
      </div>

      <div className="panel">
        <h2>Wallets — for firing from this browser</h2>
        <p className="warn" style={{ marginTop: 0 }}>
          <b>Using the remote runner below? Leave this empty.</b> These two are
          separate: the server fires with its own wallets (the ones in{" "}
          <code>snipe.keys</code> on the box), and never sees what you type here.
          This box is only for minting straight from this tab, without a server —
          which is slower, because your transaction travels from here rather than
          from beside the sequencer.
        </p>
        <p className="dim">
          Paste one private key per line — hidden from view, held in this
          tab&apos;s memory only, never written to disk or sent anywhere except
          as a locally-signed transaction. Cleared on refresh.
        </p>
        <textarea
          rows={4}
          value={keysText}
          onChange={(e) => setKeysText(e.target.value)}
          placeholder={"0x…\n0x…"}
          style={{ fontFamily: "var(--mono)", WebkitTextSecurity: "disc" } as React.CSSProperties}
        />
        {keyErrors.length > 0 ? (
          <p className="error" style={{ marginBottom: 0 }}>
            {keyErrors.length} line{keyErrors.length > 1 ? "s" : ""} couldn&apos;t be read (bad key or
            duplicate).
          </p>
        ) : null}
        {accounts.length > 0 ? (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {accounts.map((a) => {
              const bal = balances.get(a.address.toLowerCase());
              const short = bal !== undefined && bal < requiredPerWallet;
              const el = eligByAddr.get(a.address.toLowerCase());
              const showAllow = stage === "allowlist" && hasMerkle;
              return (
                <div key={a.address} className="mono-break" style={{ fontSize: 12 }}>
                  {a.address}{" "}
                  {showAllow ? (
                    el?.eligible ? (
                      <span className="ok">● on allow-list</span>
                    ) : el?.proofMismatch ? (
                      <span className="warn">● list out of date</span>
                    ) : (
                      <span className="dim">● not on list</span>
                    )
                  ) : null}{" "}
                  <span className={short ? "error" : "dim"}>
                    {bal === undefined ? "checking balance…" : `${weiToEth(bal)} ETH`}
                    {short ? " — can't cover gas + mint price at this quantity" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="panel">
        <h2>RPC endpoints</h2>
        <p className="dim">
          Every endpoint gets the raw signed transaction at the same instant;
          whichever accepts it first wins. The chain&apos;s <b>sequencer</b> and
          public RPC are included automatically
          {chainInfo?.submitRpcs?.length
            ? " — this chain's sequencer is the shortest path into its ordering queue, since an L2 sequences by arrival time"
            : ""}
          . Paste extra endpoints (e.g. your own Alchemy URL) below, one per
          line. All connections are opened before the stage opens, so firing
          costs only a round-trip.
        </p>
        <textarea
          rows={2}
          value={extraRpcText}
          onChange={(e) => setExtraRpcText(e.target.value)}
          placeholder="https://….g.alchemy.com/v2/YOUR_KEY"
        />
        <p className="dim hint" style={{ marginBottom: 0 }}>
          {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}:{" "}
          {endpoints.map((e) => e.label).join(", ") || "none"}
        </p>
      </div>

      <div className="panel">
        <h2>Gas &amp; quantity</h2>
        <p className="dim hint" style={{ marginTop: 0 }}>
          current base fee: {baseFeeWei === null ? "…" : `${formatGwei(baseFeeWei)} gwei`}. You pay
          base fee + tip; max fee is only a ceiling, but a node reserves gas × max
          fee upfront, so the wallet must hold that much.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="field" style={{ width: 130 }}>
            <label>max fee (gwei)</label>
            <input value={maxFeeGwei} onChange={(e) => setMaxFeeGwei(e.target.value)} />
          </div>
          <div className="field" style={{ width: 130 }}>
            <label>tip (gwei)</label>
            <input value={tipGwei} onChange={(e) => setTipGwei(e.target.value)} />
          </div>
          <div className="field" style={{ width: 130 }}>
            <label>gas limit</label>
            <input value={gasLimitStr} onChange={(e) => setGasLimitStr(e.target.value)} />
          </div>
          <div className="field" style={{ width: 190 }}>
            <label>quantity / wallet {stagePerWallet > 0 ? `(max ${stagePerWallet})` : ""}</label>
            <input
              type="number"
              min={1}
              max={stagePerWallet || undefined}
              value={quantity}
              disabled={maxQuantity}
              onChange={(e) =>
                setQuantity(Math.max(1, Math.min(stagePerWallet || 999, Number(e.target.value) || 1)))
              }
            />
          </div>
          <label
            className="dim"
            style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 10 }}
          >
            <input type="checkbox" checked={maxQuantity} onChange={(e) => setMaxQuantity(e.target.checked)} />
            mint the max the stage allows
          </label>
        </div>
        {gasError ? <p className="error" style={{ marginBottom: 0 }}>{gasError}</p> : null}
        {unaffordable.length > 0 ? (
          <p className="warn" style={{ marginBottom: 0 }}>
            {unaffordable.length} wallet{unaffordable.length > 1 ? "s" : ""} can&apos;t cover this
            quantity at this gas ceiling — lower the ceiling, the quantity, or fund them.
          </p>
        ) : null}
      </div>

      {target ? (
        <div className="panel">
          <h2>Timing</h2>
          <div className="mode-toggle">
            <button className={timing === "now" ? "active" : ""} onClick={() => setTiming("now")}>
              fire now
            </button>
            <button
              className={timing === "wait" ? "active" : ""}
              disabled={phaseDrop !== "pending"}
              onClick={() => setTiming("wait")}
            >
              wait for stage {phaseDrop === "pending" ? "" : "(not upcoming)"}
            </button>
          </div>
          {timing === "wait" && phaseDrop === "pending" ? (
            <p className="dim" style={{ marginBottom: 0 }}>
              Transactions sign immediately and hold; nothing is sent until{" "}
              {unixToLocalAndUtc(stageStart).local} ({unixToLocalAndUtc(stageStart).utc}). Keep this
              tab open — closing it or letting the machine sleep stops the countdown.
            </p>
          ) : null}

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
            <button className="primary" disabled={!canFire || phase === "firing"} onClick={() => setPhase("confirm")}>
              REVIEW &amp; FIRE {stage === "allowlist" ? "(ALLOWLIST)" : ""}
            </button>
            {target && (phaseDrop === "ended" || phaseDrop === "soldout" || phaseDrop === "unconfigured") ? (
              <span className="dim">nothing to fire at right now</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <RemoteRunner
        collection={target?.address}
        collectionName={target?.name}
        stage={stage}
        quantity={maxQuantity ? "max" : quantity}
        gas={{ maxFeeGwei, tipGwei, limit: Number(gasLimitStr) || 250000 }}
        extraRpcs={extraRpcText.split("\n").map((l) => l.trim()).filter(Boolean)}
        timing={timing}
      />

      {phase === "firing" && countdownMs !== null ? (
        <div className="panel">
          <h2>Waiting for stage…</h2>
          <p className="ok" style={{ fontSize: 20 }}>
            {formatCountdown(Math.ceil(countdownMs / 1000))}
          </p>
          <button className="secondary" onClick={cancelWait}>
            cancel
          </button>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="panel">
          <h2>Fire log</h2>
          <Steps
            steps={rows.map((r): StepView => ({
              id: r.address,
              label: `${r.address.slice(0, 10)}…${r.address.slice(-4)}`,
              status: STEP_STATUS[r.status],
              detail: (
                <>
                  {r.status === "queued" ? "signed, waiting to fire" : r.status}
                  {r.txHash ? (
                    <>
                      {" — "}
                      <TxLink hash={r.txHash} />
                    </>
                  ) : null}
                  {r.detail ? ` — ${r.detail}` : ""}
                </>
              ),
            }))}
          />
        </div>
      ) : null}

      {phase === "confirm" && target ? (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Confirm snipe — read every line</h3>
            <dl>
              <dt>stage</dt>
              <dd>{stage === "allowlist" ? "allow-list" : "public"}</dd>
              <dt>chain</dt>
              <dd>{chainInfo?.label}</dd>
              <dt>collection</dt>
              <dd>
                {target.name} ({target.address})
              </dd>
              <dt>wallets firing</dt>
              <dd>
                {firingAccounts.length}
                {stage === "allowlist" && firingAccounts.length !== accounts.length
                  ? ` of ${accounts.length} (rest not on list)`
                  : ""}
              </dd>
              <dt>quantity</dt>
              <dd>
                {effectiveQty} / wallet{maxQuantity ? " (stage max)" : ""} ={" "}
                {effectiveQty * firingAccounts.length} NFTs total
              </dd>
              <dt>mint cost</dt>
              <dd>
                {totalMintCost === 0n
                  ? "FREE"
                  : `${formatEthShort(totalMintCost)} ETH total (+ gas per wallet)`}
              </dd>
              <dt>gas</dt>
              <dd>
                max {maxFeeGwei} gwei · tip {tipGwei} gwei · limit {gasLimitStr}
              </dd>
              <dt>RPC endpoints</dt>
              <dd>{endpoints.map((e) => e.label).join(", ")}</dd>
              <dt>timing</dt>
              <dd>
                {timing === "now"
                  ? "fire immediately on confirm"
                  : `hold and fire at ${unixToLocalAndUtc(stageStart).local}`}
              </dd>
            </dl>
            {unaffordable.length > 0 ? (
              <p className="warn">
                {unaffordable.length} wallet{unaffordable.length > 1 ? "s" : ""} will likely be
                rejected for insufficient balance — they&apos;ll show as rejected in the log rather
                than block the others.
              </p>
            ) : null}
            <p className="dim">
              Every firing wallet signs and fires this exact call the moment you confirm (or the
              stage opens, if waiting). Signed transactions can&apos;t be recalled once broadcast.
            </p>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              I checked every parameter above
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                className="primary"
                disabled={!confirmChecked}
                onClick={() => {
                  setConfirmChecked(false);
                  void fire();
                }}
              >
                SIGN &amp; FIRE
              </button>
              <button className="secondary" onClick={() => setPhase("form")}>
                cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Public / allow-list stage picker. Public is always available; the allow-list
 * button appears once the drop is known to have a merkle list, and names how
 * many pasted wallets prove onto it. Signed/token-gated stages can't be built
 * from on-chain data, so they're reported, not offered.
 */
function StagePicker({
  target,
  stage,
  setStage,
  checking,
  hasMerkle,
  allowKind,
  eligibleCount,
  walletCount,
}: {
  target: SnipeTarget;
  stage: Stage;
  setStage: (s: Stage) => void;
  checking: boolean;
  hasMerkle: boolean;
  allowKind: ReturnType<typeof gateKind>;
  eligibleCount: number;
  walletCount: number;
}) {
  const allow = target.allow;

  if (checking && !allow) {
    return <p className="dim" style={{ marginTop: 0, marginBottom: 0 }}>checking for an allow-list…</p>;
  }

  if (allowKind === "signed") {
    return (
      <p className="warn" style={{ marginTop: 0, marginBottom: 0 }}>
        <b>Signature-gated allow-list.</b> That stage is authorised by OpenSea signing each mint
        (<code>mintSigned</code>) — not buildable from on-chain data, so mint it on opensea.io. The
        public stage still races from here.
      </p>
    );
  }
  if (allowKind === "tokenGated") {
    return (
      <p className="warn" style={{ marginTop: 0, marginBottom: 0 }}>
        <b>Token-gated stage.</b> Holders of{" "}
        {allow!.gatedTokens!.map((x) => x.slice(0, 10) + "…").join(", ")} mint it — not supported
        here yet. The public stage still races from here.
      </p>
    );
  }

  if (!hasMerkle) {
    return (
      <p className="dim" style={{ marginTop: 0, marginBottom: 0 }}>
        Public stage only — no merkle allow-list on this drop.
        {allow?.problem ? ` (${allow.problem})` : ""}
      </p>
    );
  }

  return (
    <div className="mode-toggle" style={{ marginBottom: 0 }}>
      <button className={stage === "public" ? "active" : ""} onClick={() => setStage("public")}>
        public
      </button>
      <button className={stage === "allowlist" ? "active" : ""} onClick={() => setStage("allowlist")}>
        allowlist{" "}
        {walletCount > 0 ? (
          <span style={{ opacity: 0.7 }}>
            ({eligibleCount}/{walletCount} eligible)
          </span>
        ) : null}
      </button>
    </div>
  );
}
