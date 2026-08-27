import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { formatGwei, parseGwei } from "viem";
import { clearPendingTarget, readPendingTarget } from "../lib/snipeTarget";
import { useActiveChain } from "../signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { checkEligibility, type Eligibility, type MintParams } from "../lib/allowlist";
import {
  fetchAllowListSource,
  gateKind,
  hasAllowList,
  type AllowListSource,
} from "../lib/allowlistSource";
import {
  formatCountdown,
  parseCollectionInput,
  unixToLocalAndUtc,
  weiToEth,
} from "../lib/convert";
import { formatEthShort } from "../lib/profit";
import {
  parseRpcEndpoints,
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { makeReadClient, primaryReadHost } from "../lib/readClient";
import { useCustomRpcs } from "../lib/customRpc";
import { useRunnerApi } from "../lib/runnerClient";
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

type Phase = "form" | "confirm" | "firing";
type Timing = "now" | "wait";

export default function SnipeTab() {
  const chainInfo = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID);
  const wagmiClient = usePublicClient({ chainId: chainInfo?.id });

  const [input, setInput] = useState(() => readPendingTarget() ?? "");
  const [target, setTarget] = useState<SnipeTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [checkingAllow, setCheckingAllow] = useState(false);
  const [stage, setStage] = useState<Stage>("public");

  /**
   * The wallets that actually fire, read from the server.
   *
   * This was a box you pasted private keys into, so the browser could sign and
   * broadcast by itself. That path is gone. The wallets live on the box beside
   * the sequencer and the server never hands their keys back — quite rightly —
   * so the browser could not have fired with them however the list was chosen.
   * Everything here is now a read against their addresses, and the firing
   * belongs to the runner below.
   */
  const [serverWallets, setServerWallets] = useState<{ address: string; label?: string }[]>([]);
  const [walletError, setWalletError] = useState<string | null>(null);
  const { base: runnerBase, token: runnerToken, call: runnerCall } = useRunnerApi();
  // Shared with the launch tab — one setting, editable from either.
  const { text: extraRpcText, setText: setExtraRpcText, urls: customRpcs } = useCustomRpcs();
  const [quantity, setQuantity] = useState(1);
  // "max" defers the number to the stage, which matters when queueing several
  // drops that each declare their own per-wallet cap.
  const [maxQuantity, setMaxQuantity] = useState(false);
  const [maxFeeGwei, setMaxFeeGwei] = useState("2");
  const [tipGwei, setTipGwei] = useState("0.05");
  const [gasLimitStr, setGasLimitStr] = useState("500000");
  const [baseFeeWei, setBaseFeeWei] = useState<bigint | null>(null);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());

  const [timing, setTiming] = useState<Timing>("now");
  const [phase, setPhase] = useState<Phase>("form");
  const [confirmChecked, setConfirmChecked] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!runnerBase || !runnerToken) return;
    let alive = true;
    void (async () => {
      try {
        const r = (await runnerCall("/api/wallets")) as unknown as {
          wallets?: { address: string; label?: string }[];
        };
        if (alive) {
          setServerWallets(r.wallets ?? []);
          setWalletError(null);
        }
      } catch (e) {
        if (alive) setWalletError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [runnerBase, runnerToken, runnerCall]);

  const addresses = useMemo(() => serverWallets.map((w) => w.address), [serverWallets]);

  // Per-wallet allow-list eligibility, computed from the fetched list + pasted
  // keys. Each wallet needs its own proof, so this is exactly the same shape
  // as the public path — just per-wallet calldata instead of one shared blob.
  const eligByAddr = useMemo(() => {
    const map = new Map<string, Eligibility>();
    const allow = target?.allow;
    if (allow?.list && hasAllowList(allow.root)) {
      for (const a of addresses) {
        map.set(a.toLowerCase(), checkEligibility(allow.list, a, allow.root));
      }
    }
    return map;
  }, [target?.allow, addresses]);

  const allowKind = target?.allow ? gateKind(target.allow) : "none";
  const hasMerkle = allowKind === "merkle";
  const eligibleAddresses = addresses.filter((a) => eligByAddr.get(a.toLowerCase())?.eligible);
  // Representative allow-list params (window/price) — same across the list.
  const allowParams: MintParams | undefined = eligibleAddresses
    .map((a) => eligByAddr.get(a.toLowerCase())?.params)
    .find(Boolean);

  /**
   * Reads go through the pasted endpoint first, with the chain's public RPC
   * only as a backstop. Without this the endpoint someone paid for would be
   * used to broadcast and nothing else, while every balance, nonce and stage
   * read still queued behind the public node's rate limit.
   */
  const publicClient = useMemo(() => {
    if (!chainInfo || customRpcs.length === 0) return wagmiClient;
    return makeReadClient(chainInfo.chain, customRpcs) as unknown as typeof wagmiClient;
  }, [chainInfo, customRpcs, wagmiClient]);

  const endpoints: RpcEndpoint[] = useMemo(() => {
    const defaults = chainInfo?.chain.rpcUrls.default.http ?? [];
    // The chain's own sequencer, where it has one: an L2 orders by arrival
    // time, so this is the shortest path into the queue.
    const submit = chainInfo?.submitRpcs ?? [];
    return parseRpcEndpoints([...submit, ...defaults, ...customRpcs]);
  }, [chainInfo, customRpcs]);

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
    if (!publicClient || addresses.length === 0) {
      setBalances(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      addresses.map(
        async (a) =>
          [a, await publicClient.getBalance({ address: a as `0x${string}` })] as const,
      ),
    ).then((pairs) => {
      if (!cancelled) setBalances(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.join(","), publicClient]);

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
  const firingAddresses = stage === "allowlist" ? eligibleAddresses : addresses;
  const unaffordable = firingAddresses.filter((a) => {
    const bal = balances.get(a.toLowerCase());
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

  // A collection handed over from the scanner arrives in `input` — read it
  // without making the user press the button they just pressed next door,
  // then forget the handoff so coming back here later starts clean.
  useEffect(() => {
    if (!readPendingTarget() || !publicClient || !chainInfo) return;
    clearPendingTarget();
    void load();
    // Once, for whatever was handed over at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, chainInfo]);

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


  const totalMintCost = stagePrice * BigInt(effectiveQty) * BigInt(firingAddresses.length);
  const canFire =
    Boolean(target) &&
    firingAddresses.length > 0 &&
    endpoints.length > 0 &&
    !gasError &&
    (phaseDrop === "live" || phaseDrop === "pending");

  return (
    <div>
      <div className="panel">
        <h2>Snipe</h2>
        <p className="dim">
          Pre-signed, multi-wallet racing for a SeaDrop drop — <b>public</b> or{" "}
          <b>allow-list</b>. Each of the server&apos;s wallets builds and signs
          its own transaction from on-chain drop data,
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
              eligibleCount={eligibleAddresses.length}
              walletCount={addresses.length}
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
        <h2>Wallets — the ones on the server</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Firing happens on the box, from the keys in <code>snipe.keys</code>.
          This is what it holds, with each wallet&apos;s balance and — on an
          allow-list stage — whether it proves onto the list. Which of them
          fire is chosen in the runner below.
        </p>
        {walletError ? <p className="error">{walletError}</p> : null}
        {serverWallets.length === 0 ? (
          <div className="empty-state">
            {runnerBase && runnerToken ? (
              <>
                NO WALLETS ON THE SERVER —{" "}
                <span className="es-action">ADD THEM IN THE WALLETS TAB</span>
              </>
            ) : (
              <>
                NOT CONNECTED —{" "}
                <span className="es-action">FILL IN THE SERVER URL AND TOKEN BELOW</span>
              </>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {serverWallets.map((w) => {
              const bal = balances.get(w.address.toLowerCase());
              const short = bal !== undefined && bal < requiredPerWallet;
              const el = eligByAddr.get(w.address.toLowerCase());
              const showAllow = stage === "allowlist" && hasMerkle;
              return (
                <div key={w.address} className="mono-break" style={{ fontSize: 12 }}>
                  {w.address}
                  {w.label ? <span className="dim"> · {w.label}</span> : null}{" "}
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
        )}
      </div>
      <div className="panel">
        <h2>Your RPC</h2>
        <p className="dim">
          Paste your own endpoint (Alchemy, QuickNode, your own node) — one per
          line, best first. It becomes the <b>main</b> RPC: every read on this
          page goes through it, and the chain&apos;s public RPC drops to being
          the backstop behind it, used only if yours errors. It is remembered
          between visits, and handed to your server when you connect below, so
          balances and nonces there stop queueing behind the public node&apos;s
          rate limit.
        </p>
        <textarea
          rows={2}
          value={extraRpcText}
          onChange={(e) => setExtraRpcText(e.target.value)}
          placeholder="https://….g.alchemy.com/v2/YOUR_KEY"
        />
        <p className="dim hint" style={{ marginBottom: 0 }}>
          reads go to <b>{chainInfo ? primaryReadHost(chainInfo.chain, customRpcs) : "—"}</b>
          {customRpcs.length === 0 ? " (the public RPC — paste yours above)" : ""}.
          {" "}
          Broadcast hits all {endpoints.length} endpoint
          {endpoints.length === 1 ? "" : "s"} at once —{" "}
          {endpoints.map((e) => e.label).join(", ") || "none"} — since{" "}
          {chainInfo?.submitRpcs?.length
            ? "the sequencer orders by arrival time and whichever path reaches it first wins"
            : "whichever accepts it first wins"}
          . All of them are connected before the stage opens, so firing costs
          only a round-trip.
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
            <button
              className="primary"
              disabled={!canFire || phase === "firing"}
              onClick={() => setPhase("confirm")}
            >
              REVIEW {stage === "allowlist" ? "(ALLOWLIST)" : ""}
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
        gas={{ maxFeeGwei, tipGwei, limit: Number(gasLimitStr) || 500000 }}
        extraRpcs={customRpcs}
        timing={timing}
      />

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
                {firingAddresses.length}
                {stage === "allowlist" && firingAddresses.length !== addresses.length
                  ? ` of ${addresses.length} (rest not on list)`
                  : ""}
              </dd>
              <dt>quantity</dt>
              <dd>
                {effectiveQty} / wallet{maxQuantity ? " (stage max)" : ""} ={" "}
                {effectiveQty * firingAddresses.length} NFTs total
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
                  setPhase("form");
                  document
                    .querySelector("#remote-runner")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                QUEUE IT ON THE SERVER
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
