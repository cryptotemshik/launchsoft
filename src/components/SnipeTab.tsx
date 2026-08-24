import { useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { encodeFunctionData, formatGwei, parseGwei, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { useActiveChain } from "../signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { pickFeeRecipient } from "../lib/collectionData";
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
  type RpcEndpoint,
} from "../lib/rpcBlast";
import { waitUntil } from "../lib/snipeTimer";
import { Steps, TxLink, type StepView } from "./Bits";

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
}

type DropPhase = "unconfigured" | "pending" | "live" | "ended" | "soldout";

function phaseOf(t: SnipeTarget, now: number): DropPhase {
  if (t.startTime === 0) return "unconfigured";
  if (t.totalSupply >= t.maxSupply) return "soldout";
  if (now < t.startTime) return "pending";
  if (now > t.endTime) return "ended";
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

type FireStatus = "queued" | "dispatched" | "accepted" | "mined" | "reverted" | "rejected" | "timeout";

interface FireRow {
  address: `0x${string}`;
  status: FireStatus;
  txHash?: Hex;
  detail?: string;
}

const STEP_STATUS: Record<FireStatus, StepView["status"]> = {
  queued: "pending",
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

  const [keysText, setKeysText] = useState("");
  const [extraRpcText, setExtraRpcText] = useState("");
  const [quantity, setQuantity] = useState(1);
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

  const endpoints: RpcEndpoint[] = useMemo(() => {
    const defaults = chainInfo?.chain.rpcUrls.default.http ?? [];
    const extra = extraRpcText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return parseRpcEndpoints([...defaults, ...extra]);
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

  const requiredPerWallet =
    (gasLimit ?? 0n) * (maxFeePerGas ?? 0n) + (target ? target.price * BigInt(quantity) : 0n);
  const unaffordable = accounts.filter((a) => {
    const bal = balances.get(a.address);
    return bal !== undefined && bal < requiredPerWallet;
  });

  const phaseDrop = target ? phaseOf(target, now) : null;

  useEffect(() => {
    if (phaseDrop === "pending") setTiming("wait");
    else if (phaseDrop === "live") setTiming("now");
  }, [phaseDrop]);

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
      setTarget({
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
      });
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

  function cancelWait() {
    abortRef.current?.abort();
  }

  async function fire() {
    if (!target || !publicClient || !chainInfo) return;
    if (accounts.length === 0) {
      setError("Paste at least one valid private key");
      return;
    }
    if (endpoints.length === 0) {
      setError("No RPC endpoint available for this chain — add one");
      return;
    }
    if (gasError || maxFeePerGas === null || maxPriorityFeePerGas === null || gasLimit === null) {
      setError(gasError ?? "Fix the gas settings first");
      return;
    }

    setPhase("firing");
    setError(null);
    setRows(accounts.map((a) => ({ address: a.address, status: "queued" })));

    try {
      const feeRecipient = pickFeeRecipient(
        chainInfo,
        target.allowedFeeRecipients,
        target.restrictFeeRecipients,
      );
      if (!feeRecipient) {
        throw new Error("This drop restricts fee recipients and allows none — cannot mint");
      }
      const data = encodeFunctionData({
        abi: seaDropAbi,
        functionName: "mintPublic",
        args: [target.address, feeRecipient, zeroAddress, BigInt(quantity)],
      });
      const value = target.price * BigInt(quantity);

      // Sign everything now, well before the stage opens — at fire time
      // there's nothing left to compute, only bytes to send.
      const nonces = await Promise.all(
        accounts.map((a) => publicClient.getTransactionCount({ address: a.address, blockTag: "pending" })),
      );
      const prepared = await Promise.all(
        accounts.map(async (a, i) => {
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

      if (timing === "wait" && target.startTime * 1000 > Date.now()) {
        abortRef.current = new AbortController();
        const outcome = await waitUntil(target.startTime * 1000, {
          onTick: setCountdownMs,
          signal: abortRef.current.signal,
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
          setRows((prev) => (prev.map((r) => (r.address === address ? { ...r, status: "accepted" } : r))));
          const receipt = await waitForReceiptOrNull(publicClient, blast.txHash, 60_000);
          if (!receipt) {
            setRows((prev) =>
              prev.map((r) =>
                r.address === address ? { ...r, status: "timeout", detail: "no receipt yet — check the explorer link" } : r,
              ),
            );
            return;
          }
          setRows((prev) =>
            prev.map((r) =>
              r.address === address ? { ...r, status: receipt.status === "success" ? "mined" : "reverted" } : r,
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

  const totalMintCost = target ? target.price * BigInt(quantity) * BigInt(accounts.length) : 0n;
  const canFire =
    Boolean(target) &&
    accounts.length > 0 &&
    endpoints.length > 0 &&
    !gasError &&
    (phaseDrop === "live" || phaseDrop === "pending");

  return (
    <div>
      <div className="panel">
        <h2>Snipe (public stage)</h2>
        <p className="dim">
          Pre-signed, multi-wallet racing for a SeaDrop <b>public</b> mint —
          transactions are built and signed locally from on-chain drop data
          and blasted to every configured RPC the instant the stage opens.
          Allow-list / signed / token-gated stages aren&apos;t supported here:
          those need a signature or list only the drop&apos;s own backend can
          produce, and can&apos;t be built from on-chain data alone — use the
          MINT tab&apos;s allow-list detection for those, or opensea.io.
        </p>
        <p className="warn" style={{ marginBottom: 0 }}>
          Racing to fire faster than other bidders on a public stage. It
          doesn&apos;t touch anyone else&apos;s wallet or bypass anything the
          contract enforces — but it is a competitive-advantage tool, not a
          neutral one. Use it on your own judgment.
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
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>collection</dt>
            <dd>{target.name}</dd>
            <dt>minted</dt>
            <dd>
              {target.totalSupply.toString()} / {target.maxSupply.toString()}
            </dd>
            <dt>price</dt>
            <dd>{target.price === 0n ? "FREE" : `${weiToEth(target.price)} ETH each`}</dd>
            <dt>per wallet</dt>
            <dd>max {target.perWallet}</dd>
            <dt>status</dt>
            <dd>
              {phaseDrop === "live" ? (
                <span className="ok">LIVE — ends in {formatCountdown(target.endTime - now)}</span>
              ) : phaseDrop === "pending" ? (
                <span className="warn">
                  starts in {formatCountdown(target.startTime - now)} (
                  {unixToLocalAndUtc(target.startTime).local})
                </span>
              ) : phaseDrop === "ended" ? (
                <span className="error">ended</span>
              ) : phaseDrop === "soldout" ? (
                <span className="warn">SOLD OUT</span>
              ) : (
                <span className="warn">public drop not configured</span>
              )}
            </dd>
          </dl>
        ) : null}
      </div>

      <div className="panel">
        <h2>Wallets</h2>
        <p className="dim">
          Paste one private key per line — hidden from view, held in this
          tab&apos;s memory only, never written to disk or sent anywhere
          except as a locally-signed transaction. Cleared on refresh.
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
            {keyErrors.length} line{keyErrors.length > 1 ? "s" : ""} couldn&apos;t be read
            (bad key or duplicate).
          </p>
        ) : null}
        {accounts.length > 0 ? (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {accounts.map((a) => {
              const bal = balances.get(a.address);
              const short = bal !== undefined && bal < requiredPerWallet;
              return (
                <div key={a.address} className="mono-break" style={{ fontSize: 12 }}>
                  {a.address}{" "}
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
          whichever accepts it first wins. Chain defaults are always
          included — paste extra ones (e.g. your own Alchemy URL) below, one
          per line, for a real edge over public nodes.
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
          base fee + tip; max fee is only a ceiling, but a node reserves gas ×
          max fee upfront, so the wallet must hold that much.
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
          <div className="field" style={{ width: 160 }}>
            <label>quantity / wallet {target ? `(max ${target.perWallet})` : ""}</label>
            <input
              type="number"
              min={1}
              max={target?.perWallet || undefined}
              value={quantity}
              onChange={(e) =>
                setQuantity(Math.max(1, Math.min(target?.perWallet || 999, Number(e.target.value) || 1)))
              }
            />
          </div>
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
              {unixToLocalAndUtc(target.startTime).local} ({unixToLocalAndUtc(target.startTime).utc}
              ). Keep this tab open — closing it or letting the machine sleep
              stops the countdown.
            </p>
          ) : null}

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
            <button className="primary" disabled={!canFire || phase === "firing"} onClick={() => setPhase("confirm")}>
              REVIEW &amp; FIRE
            </button>
            {!target
              ? null
              : phaseDrop === "ended" || phaseDrop === "soldout" || phaseDrop === "unconfigured"
                ? <span className="dim">nothing to fire at right now</span>
                : null}
          </div>
        </div>
      ) : null}

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
              <dt>chain</dt>
              <dd>{chainInfo?.label}</dd>
              <dt>collection</dt>
              <dd>
                {target.name} ({target.address})
              </dd>
              <dt>wallets</dt>
              <dd>{accounts.length}</dd>
              <dt>quantity</dt>
              <dd>
                {quantity} / wallet = {quantity * accounts.length} NFTs total
              </dd>
              <dt>mint cost</dt>
              <dd>{totalMintCost === 0n ? "FREE" : `${formatEthShort(totalMintCost)} ETH total (+ gas per wallet)`}</dd>
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
                  : `hold and fire at ${unixToLocalAndUtc(target.startTime).local}`}
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
              Every wallet above signs and fires this exact call the moment you confirm (or the
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
              <button className="primary" disabled={!confirmChecked} onClick={() => void fire()}>
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
