import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { useSigner } from "../signer";
import { parseEventLogs, zeroHash } from "viem";
import { DEFAULT_DROP_DAYS, launchFactoryFor } from "../config";
import { openSeaCollectionUrl } from "../chains";
import {
  erc721SeaDropAbi,
  erc721SeaDropBytecode,
  launchFactoryAbi,
  tokenAbi,
} from "../contracts/seadrop";
import {
  datetimeLocalToUnix,
  ethToWei,
  isAddress,
  normalizeProvenanceHash,
  nowPlusMinutesLocalInput,
  parseCollectionInput,
  UINT16_MAX,
  UINT48_MAX,
  unixToLocalAndUtc,
  weiToEth,
} from "../lib/convert";
import { importCollection } from "../lib/importCollection";
import { durationToSeconds, formatDuration } from "../lib/dropWindow";
import { pinFile, pinJson, testPinataJwt } from "../lib/pinata";
import { forgetPinataJwt, loadPinataJwt, savePinataJwt } from "../lib/pinataKey";
import { upsertProject } from "../lib/projects";
import {
  clearLaunchState,
  loadLaunchState,
  saveLaunchState,
  updateLaunchState,
  type LaunchFormValues,
  type LaunchState,
} from "../lib/launchState";
import { AddrLink, IpfsLink, Steps, TxLink, type StepView } from "./Bits";
import SuccessPanel from "./SuccessPanel";

/** OpenSea's collection categories. Category lives in OpenSea's own settings;
 *  writing it into contractURI is a best-effort hint for indexers. */
const CATEGORIES = [
  "PFPs",
  "Art",
  "Gaming",
  "Memberships",
  "Photography",
  "Music",
] as const;

/** Pre-reveal copy every token shares until the reveal — editable defaults. */
const DEFAULT_PREREVEAL_DESCRIPTION =
  "Not revealed yet. Every token in this collection shares this placeholder " +
  "until the artwork is revealed on-chain after the mint. Hold tight.";

/** "<collection> (unrevealed)" — the placeholder item name. */
export function defaultPrerevealName(collectionName: string): string {
  const n = collectionName.trim();
  return n ? `${n} (unrevealed)` : "";
}

const EMPTY_FORM: LaunchFormValues = {
  name: "",
  symbol: "",
  description: "",
  websiteUrl: "",
  category: "PFPs",
  prerevealName: "",
  prerevealDescription: DEFAULT_PREREVEAL_DESCRIPTION,
  supply: 0,
  mintPriceEth: "0",
  perWalletLimit: 0,
  startLocal: "",
  startNow: true,
  durationDays: DEFAULT_DROP_DAYS,
  durationHours: 0,
  durationMins: 0,
  provenanceHash: "",
  // Sensible default: the maximum OpenSea honours, enforced on-chain.
  royaltyPercent: "10",
  enforcedRoyalties: true,
  creatorPayoutAddress: "",
};

interface DerivedParams {
  priceWei: bigint;
  startTime: number;
  endTime: number;
  provenance: `0x${string}` | null;
  royaltyBps: number | null;
  payout: `0x${string}`;
}

function deriveAndValidate(
  form: LaunchFormValues,
  jwt: string,
  imageFile: File | null,
  resuming: LaunchState | null,
): { params?: DerivedParams; errors: string[] } {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push("Collection name is required");
  if (!form.symbol.trim()) errors.push("Symbol is required");
  if (!Number.isInteger(form.supply) || form.supply < 1)
    errors.push("Supply must be a whole number ≥ 1");
  if (form.supply > 100_000)
    errors.push("Supply > 100,000 — double-check, that is unusually large");
  if (
    !Number.isInteger(form.perWalletLimit) ||
    form.perWalletLimit < 1 ||
    form.perWalletLimit > UINT16_MAX
  )
    errors.push(`Per-wallet limit must be 1..${UINT16_MAX}`);
  if (!jwt.trim()) errors.push("Pinata JWT is required (kept in memory only)");
  if (
    form.websiteUrl.trim() !== "" &&
    !/^https?:\/\/.+\..+/.test(form.websiteUrl.trim())
  )
    errors.push("Website must be a full URL (https://…)");
  if (!imageFile && !resuming?.prerevealImageCid)
    errors.push("Pre-reveal image is required");

  let priceWei = 0n;
  try {
    priceWei = ethToWei(form.mintPriceEth || "0");
  } catch (e) {
    errors.push((e as Error).message);
  }

  // The drop is described as start + duration; SeaDrop's absolute endTime is
  // derived from that, so the window can never come out shorter than asked.
  let startTime = 0;
  let endTime = 0;
  if (form.startNow) {
    // A small cushion: the configure tx has to land before the window opens.
    startTime = Math.floor(Date.now() / 1000) + 120;
  } else {
    try {
      if (!form.startLocal) throw new Error("Start time is required");
      startTime = datetimeLocalToUnix(form.startLocal);
      if (startTime < Math.floor(Date.now() / 1000) - 300)
        errors.push("Start time is in the past");
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const durationSeconds = durationToSeconds({
    days: form.durationDays,
    hours: form.durationHours,
    mins: form.durationMins,
  });
  if (durationSeconds <= 0) {
    errors.push("Duration must be longer than zero — set days, hours or minutes");
  } else if (durationSeconds < 600) {
    errors.push(
      `Duration is only ${formatDuration(durationSeconds)} — that closes the mint almost immediately. Set at least 10 minutes.`,
    );
  }
  if (startTime) {
    endTime = startTime + durationSeconds;
    if (endTime > UINT48_MAX) errors.push("Duration pushes the end time out of range");
  }

  let provenance: `0x${string}` | null = null;
  try {
    provenance = normalizeProvenanceHash(form.provenanceHash);
  } catch (e) {
    errors.push((e as Error).message);
  }

  let royaltyBps: number | null = null;
  if (form.royaltyPercent.trim() !== "") {
    const pct = Number(form.royaltyPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      errors.push("Royalty % must be between 0 and 100");
    } else {
      royaltyBps = Math.round(pct * 100);
      if (royaltyBps === 0) royaltyBps = null;
    }
  }
  if (form.enforcedRoyalties && !royaltyBps) {
    errors.push(
      "Enforced royalties need a royalty % above zero (or switch back to 'signal only')",
    );
  }

  const payout = form.creatorPayoutAddress.trim();
  if (!isAddress(payout)) errors.push("Creator payout address is not a valid address");

  if (errors.length > 0) return { errors };
  return {
    errors,
    params: {
      priceWei,
      startTime,
      endTime,
      provenance,
      royaltyBps,
      payout: payout as `0x${string}`,
    },
  };
}

type Phase = "form" | "confirm" | "running" | "done";

export default function LaunchTab() {
  const { address, txAccount, isConnected, walletClient, wrongNetwork, chainInfo } =
    useSigner();
  const publicClient = usePublicClient({ chainId: chainInfo?.id });
  const factory = launchFactoryFor(chainInfo?.id);

  const saved = useMemo(loadLaunchState, []);
  const [form, setForm] = useState<LaunchFormValues>(() => ({
    ...EMPTY_FORM,
    startLocal: nowPlusMinutesLocalInput(60),
    ...(saved && !saved.completedAt ? saved.form : {}),
  }));
  const [jwt, setJwt] = useState(loadPinataJwt);
  const [rememberJwt, setRememberJwt] = useState(() => loadPinataJwt() !== "");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [collectionImageFile, setCollectionImageFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [phase, setPhase] = useState<Phase>(
    saved?.completedAt && saved.contractAddress ? "done" : "form",
  );
  const [steps, setSteps] = useState<StepView[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [state, setState] = useState<LaunchState | null>(saved);
  const [derived, setDerived] = useState<DerivedParams | null>(null);
  const [launchFee, setLaunchFee] = useState<bigint>(0n);
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNotes, setImportNotes] = useState<string[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const imagePreview = useObjectUrl(imageFile);
  const collectionImagePreview = useObjectUrl(collectionImageFile);

  // The unrevealed item name tracks the collection name ("Foo (unrevealed)")
  // until the user types their own — then it's left alone.
  const [prerevealNameEdited, setPrerevealNameEdited] = useState(
    () => Boolean(saved?.form?.prerevealName),
  );
  useEffect(() => {
    if (prerevealNameEdited) return;
    setForm((f) => ({ ...f, prerevealName: defaultPrerevealName(f.name) }));
  }, [form.name, prerevealNameEdited]);

  // Read the on-chain launch fee once, if a fee factory is configured.
  useEffect(() => {
    if (!factory || !publicClient) return;
    publicClient
      .readContract({
        address: factory as `0x${string}`,
        abi: launchFactoryAbi,
        functionName: "launchFee",
      })
      .then((f) => setLaunchFee(f as bigint))
      .catch(() => setLaunchFee(0n));
  }, [publicClient]);

  const pendingResume =
    saved && saved.contractAddress && !saved.configureTxHash && !saved.completedAt;

  const set = (patch: Partial<LaunchFormValues>) =>
    setForm((f) => ({ ...f, ...patch }));

  // Prefill payout with the connected wallet.
  useEffect(() => {
    if (isConnected && address && form.creatorPayoutAddress === "") {
      set({ creatorPayoutAddress: address });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  async function runImport() {
    const target = parseCollectionInput(importInput);
    if (!target) {
      setImportError("Paste a contract address or an OpenSea/Blockscout link");
      return;
    }
    if (!publicClient || !chainInfo) {
      setImportError("Pick a supported network first");
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportNotes(null);
    try {
      const c = await importCollection(publicClient, target, chainInfo);
      set({
        name: c.name,
        symbol: c.symbol,
        description: c.description,
        websiteUrl: c.websiteUrl,
        ...(c.supply > 0 ? { supply: c.supply } : {}),
        ...(c.mintPriceEth ? { mintPriceEth: c.mintPriceEth } : {}),
        ...(c.perWalletLimit > 0 ? { perWalletLimit: c.perWalletLimit } : {}),
        ...(c.royaltyPercent ? { royaltyPercent: c.royaltyPercent } : {}),
        ...(CATEGORIES.includes(c.category as (typeof CATEGORIES)[number])
          ? { category: c.category }
          : {}),
      });
      setImportNotes(c.notes);
    } catch (e) {
      setImportError(
        `Couldn't read that collection on ${chainInfo.label}: ${
          e instanceof Error ? e.message.split("\n")[0] : e
        }`,
      );
    } finally {
      setImporting(false);
    }
  }

  function openConfirm() {
    const { params, errors: errs } = deriveAndValidate(form, jwt, imageFile, saved);
    setErrors(errs);
    if (params && errs.length === 0) {
      setDerived(params);
      setConfirmChecked(false);
      setPhase("confirm");
    }
  }

  function updateStep(id: string, patch: Partial<StepView>) {
    setSteps((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function runLaunch(resume: boolean) {
    const base = resume ? loadLaunchState() : null;
    const { params, errors: errs } = deriveAndValidate(form, jwt, imageFile, base);
    setErrors(errs);
    if (!params || errs.length > 0) {
      setPhase("form");
      return;
    }
    if (!walletClient || !publicClient || !address || !txAccount || !chainInfo) {
      setErrors(["Connect a wallet or load a fast-mode key on a supported network"]);
      setPhase("form");
      return;
    }
    if (form.enforcedRoyalties && !chainInfo.transferValidator) {
      setErrors([`Enforced royalties aren't available on ${chainInfo.label}`]);
      setPhase("form");
      return;
    }
    if (wrongNetwork) {
      setErrors(["Switch to Robinhood Chain first (button in the top bar)"]);
      setPhase("form");
      return;
    }

    // Resume reuses the frozen timestamps so the drop window doesn't drift.
    let st: LaunchState =
      resume && base
        ? base
        : {
            form,
            startTime: params.startTime,
            endTime: params.endTime,
          };
    if (!resume) saveLaunchState(st);
    setState(st);
    setRunError(null);
    setPhase("running");

    const stepList: StepView[] = [
      { id: "auth", label: "Verify Pinata JWT", status: "pending" },
      { id: "image", label: "Upload pre-reveal image to IPFS", status: "pending" },
      ...(collectionImageFile || st.collectionImageCid
        ? [
            {
              id: "collimage",
              label: "Upload collection picture to IPFS",
              status: "pending" as const,
            },
          ]
        : []),
      { id: "premeta", label: "Upload pre-reveal metadata to IPFS", status: "pending" },
      { id: "contracturi", label: "Upload collection metadata (contractURI)", status: "pending" },
      {
        id: "deploy",
        label: factory
          ? `TX 1/2 — launch${launchFee > 0n ? ` (fee ${weiToEth(launchFee)} ETH)` : ""}`
          : "TX 1/2 — deploy ERC721SeaDrop",
        status: "pending",
      },
      { id: "configure", label: "TX 2/2 — multiConfigure (supply, drop, payout)", status: "pending" },
      ...(params.royaltyBps
        ? [{ id: "royalty", label: `Optional TX — setRoyaltyInfo (${params.royaltyBps} bps)`, status: "pending" as const }]
        : []),
      ...(form.enforcedRoyalties
        ? [{ id: "validator", label: "Optional TX — setTransferValidator (enforced royalties)", status: "pending" as const }]
        : []),
    ];
    setSteps(stepList);

    const fail = (id: string, e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      updateStep(id, { status: "failed", detail: msg });
      setRunError(
        `${msg}\n\nProgress is saved — press LAUNCH again (or Resume) to retry from this step. Nothing already uploaded or deployed is redone.`,
      );
    };

    try {
      // ── Pinata ────────────────────────────────────────────────────────────
      updateStep("auth", { status: "running" });
      await testPinataJwt(jwt);
      updateStep("auth", { status: "done" });

      updateStep("image", { status: "running" });
      if (!st.prerevealImageCid) {
        if (!imageFile) throw new Error("Re-select the pre-reveal image to continue");
        const cid = await pinFile(jwt, imageFile, `${form.name} pre-reveal`, (p) =>
          updateStep("image", { progress: p }),
        );
        st = updateLaunchState({ prerevealImageCid: cid });
        setState(st);
      }
      updateStep("image", {
        status: "done",
        detail: <IpfsLink uri={`ipfs://${st.prerevealImageCid}`} />,
      });

      // Collection picture — OpenSea's collection logo. Optional: without one
      // the contractURI reuses the pre-reveal image, as it did before.
      if (collectionImageFile || st.collectionImageCid) {
        updateStep("collimage", { status: "running" });
        if (!st.collectionImageCid) {
          const cid = await pinFile(
            jwt,
            collectionImageFile!,
            `${form.name} collection picture`,
            (p) => updateStep("collimage", { progress: p }),
          );
          st = updateLaunchState({ collectionImageCid: cid });
          setState(st);
        }
        updateStep("collimage", {
          status: "done",
          detail: <IpfsLink uri={`ipfs://${st.collectionImageCid}`} />,
        });
      }

      updateStep("premeta", { status: "running" });
      if (!st.prerevealMetadataCid) {
        // One shared unrevealed JSON for every token id: ERC721SeaDrop returns
        // baseURI verbatim for ALL ids when it does not end in "/" (verified in
        // the contract source) — no need for `supply` copies of the same file.
        const cid = await pinJson(
          jwt,
          {
            name: form.prerevealName.trim() || `${form.name} (unrevealed)`,
            description:
              form.prerevealDescription.trim() || form.description,
            image: `ipfs://${st.prerevealImageCid}`,
            ...(form.websiteUrl.trim()
              ? { external_url: form.websiteUrl.trim() }
              : {}),
          },
          `${form.name} pre-reveal metadata`,
        );
        st = updateLaunchState({ prerevealMetadataCid: cid });
        setState(st);
      }
      updateStep("premeta", {
        status: "done",
        detail: <IpfsLink uri={`ipfs://${st.prerevealMetadataCid}`} />,
      });

      updateStep("contracturi", { status: "running" });
      if (!st.contractUriCid) {
        // Contract-level metadata per OpenSea's spec; external_link is the
        // collection website. Socials (X/Discord) have no metadata field —
        // OpenSea only connects them via OAuth in collection settings.
        const cid = await pinJson(
          jwt,
          {
            name: form.name,
            description: form.description,
            // Collection logo on OpenSea — its own picture when one was
            // uploaded, else the pre-reveal art.
            image: `ipfs://${st.collectionImageCid ?? st.prerevealImageCid}`,
            ...(form.category ? { category: form.category } : {}),
            ...(form.websiteUrl.trim()
              ? { external_link: form.websiteUrl.trim() }
              : {}),
          },
          `${form.name} contractURI`,
        );
        st = updateLaunchState({ contractUriCid: cid });
        setState(st);
      }
      updateStep("contracturi", {
        status: "done",
        detail: <IpfsLink uri={`ipfs://${st.contractUriCid}`} />,
      });

      // ── TX 1: deploy (via paid factory if configured, else direct) ───────
      updateStep("deploy", { status: "running", detail: "confirm in wallet…" });
      if (!st.contractAddress) {
        if (factory) {
          // Paid launch: factory takes the flat fee and deploys a clone owned
          // by the caller in the same tx.
          const saltBytes = new Uint8Array(32);
          crypto.getRandomValues(saltBytes);
          const salt = `0x${Array.from(saltBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")}` as `0x${string}`;
          const { request } = await publicClient.simulateContract({
            address: factory as `0x${string}`,
            abi: launchFactoryAbi,
            functionName: "launch",
            args: [form.name, form.symbol, salt],
            account: txAccount,
            value: launchFee,
          });
          const hash = await walletClient.writeContract(request);
          st = updateLaunchState({ deployTxHash: hash });
          setState(st);
          updateStep("deploy", { detail: "waiting for confirmation…" });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw new Error(`Launch transaction reverted (${hash})`);
          }
          // Pull the clone address from the CollectionLaunched event.
          const events = parseEventLogs({
            abi: launchFactoryAbi,
            logs: receipt.logs,
            eventName: "CollectionLaunched",
          });
          const collection = (events[0] as unknown as
            | { args: { collection: `0x${string}` } }
            | undefined)?.args.collection;
          if (!collection) {
            throw new Error("Launch succeeded but no collection address in logs");
          }
          st = updateLaunchState({ contractAddress: collection });
          setState(st);
        } else {
          const hash = await walletClient.deployContract({
            abi: erc721SeaDropAbi,
            bytecode: erc721SeaDropBytecode,
            args: [form.name, form.symbol, [chainInfo.seaDrop]],
            account: txAccount,
            chain: chainInfo.chain,
          });
          st = updateLaunchState({ deployTxHash: hash });
          setState(st);
          updateStep("deploy", { detail: "waiting for confirmation…" });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success" || !receipt.contractAddress) {
            throw new Error(`Deploy transaction reverted (${hash})`);
          }
          st = updateLaunchState({ contractAddress: receipt.contractAddress });
          setState(st);
        }
      }
      updateStep("deploy", {
        status: "done",
        detail: <AddrLink address={st.contractAddress!} />,
      });

      // ── TX 2: multiConfigure ─────────────────────────────────────────────
      updateStep("configure", { status: "running", detail: "confirm in wallet…" });
      if (!st.configureTxHash) {
        const config = {
          maxSupply: BigInt(form.supply),
          // No trailing slash: same unrevealed JSON for every token until reveal.
          baseURI: `ipfs://${st.prerevealMetadataCid}`,
          contractURI: `ipfs://${st.contractUriCid}`,
          seaDropImpl: chainInfo.seaDrop,
          publicDrop: {
            mintPrice: params.priceWei,
            startTime: st.startTime,
            endTime: st.endTime,
            maxTotalMintableByWallet: form.perWalletLimit,
            feeBps: chainInfo.feeBps,
            restrictFeeRecipients: true,
          },
          dropURI: "",
          allowListData: {
            merkleRoot: zeroHash,
            publicKeyURIs: [],
            allowListURI: "",
          },
          creatorPayoutAddress: params.payout,
          provenanceHash: params.provenance ?? zeroHash,
          allowedFeeRecipients: [chainInfo.feeRecipient],
          disallowedFeeRecipients: [],
          allowedPayers: [],
          disallowedPayers: [],
          // Public-only mint by design — every other stage stays empty.
          tokenGatedAllowedNftTokens: [],
          tokenGatedDropStages: [],
          disallowedTokenGatedAllowedNftTokens: [],
          signers: [],
          signedMintValidationParams: [],
          disallowedSigners: [],
        };
        const { request } = await publicClient.simulateContract({
          address: st.contractAddress as `0x${string}`,
          abi: erc721SeaDropAbi,
          functionName: "multiConfigure",
          args: [config],
          account: txAccount,
        });
        const hash = await walletClient.writeContract(request);
        updateStep("configure", { detail: "waiting for confirmation…" });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`multiConfigure reverted (${hash})`);
        }
        st = updateLaunchState({ configureTxHash: hash });
        setState(st);
      }
      updateStep("configure", {
        status: "done",
        detail: <TxLink hash={st.configureTxHash!} />,
      });

      // ── Optional TX 3: royalties (ERC-2981) ──────────────────────────────
      if (params.royaltyBps) {
        updateStep("royalty", { status: "running", detail: "confirm in wallet…" });
        if (!st.royaltyTxHash) {
          const hash = await walletClient.writeContract({
            address: st.contractAddress as `0x${string}`,
            abi: tokenAbi,
            functionName: "setRoyaltyInfo",
            args: [{ royaltyAddress: params.payout, royaltyBps: BigInt(params.royaltyBps) }],
            account: txAccount,
            chain: chainInfo.chain,
          });
          updateStep("royalty", { detail: "waiting for confirmation…" });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw new Error(`setRoyaltyInfo reverted (${hash})`);
          }
          st = updateLaunchState({ royaltyTxHash: hash });
          setState(st);
        }
        updateStep("royalty", {
          status: "done",
          detail: <TxLink hash={st.royaltyTxHash!} />,
        });
      }

      // ── Optional TX 4: enforced royalties (OpenSea transfer validator) ───
      if (form.enforcedRoyalties) {
        updateStep("validator", { status: "running", detail: "confirm in wallet…" });
        if (!st.validatorTxHash) {
          const { request } = await publicClient.simulateContract({
            address: st.contractAddress as `0x${string}`,
            abi: tokenAbi,
            functionName: "setTransferValidator",
            args: [chainInfo.transferValidator!],
            account: txAccount,
          });
          const hash = await walletClient.writeContract(request);
          updateStep("validator", { detail: "waiting for confirmation…" });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw new Error(`setTransferValidator reverted (${hash})`);
          }
          st = updateLaunchState({ validatorTxHash: hash });
          setState(st);
        }
        updateStep("validator", {
          status: "done",
          detail: <TxLink hash={st.validatorTxHash!} />,
        });
      }

      st = updateLaunchState({ completedAt: Date.now() });
      setState(st);
      upsertProject({
        address: st.contractAddress!,
        name: form.name,
        source: "launch",
      });
      setPhase("done");
    } catch (e) {
      // Mark the step that was running as failed; progress stays saved.
      setSteps((all) => {
        const firstActive = all.find((s) => s.status === "running");
        if (firstActive) fail(firstActive.id, e);
        else setRunError(e instanceof Error ? e.message : String(e));
        return all;
      });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  if (phase === "done" && state?.contractAddress) {
    return (
      <SuccessPanel
        state={state}
        onReset={() => {
          clearLaunchState();
          setState(null);
          setForm({ ...EMPTY_FORM, startLocal: nowPlusMinutesLocalInput(60) });
          setImageFile(null);
          setCollectionImageFile(null);
          setPhase("form");
        }}
      />
    );
  }

  if (!chainInfo) {
    return (
      <div className="panel">
        <h2>Select a network</h2>
        <p className="dim">
          {isConnected
            ? "Your wallet is on a network LaunchPad doesn't support. Pick a supported OpenSea EVM chain from the selector in the top bar."
            : "Connect a wallet, or switch to fast mode, and pick a network in the top bar to launch."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {pendingResume ? (
        <div className="panel">
          <h2>Unfinished launch detected</h2>
          <p>
            The contract deployed at{" "}
            <AddrLink address={saved!.contractAddress!} /> but configuration
            didn&apos;t finish. Paste your Pinata JWT below if any upload steps
            remain, then resume — completed steps are skipped.
          </p>
          <button className="primary" onClick={() => runLaunch(true)}>
            RESUME CONFIGURATION
          </button>{" "}
          <button
            className="danger"
            onClick={() => {
              clearLaunchState();
              window.location.reload();
            }}
          >
            discard saved launch
          </button>
        </div>
      ) : null}

      <div className="panel">
        <h2>Start from an existing collection (optional)</h2>
        <p className="dim">
          Copies the <b>settings</b> of any collection on {chainInfo.label} into
          the form below — name, symbol, description, website, supply, price,
          per-wallet limit and royalty %. Artwork is never copied: upload your
          own pre-reveal image and your own art at reveal.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ flex: 1, minWidth: 220 }}
            value={importInput}
            onChange={(e) => setImportInput(e.target.value)}
            placeholder="0x… contract address, or an OpenSea/Blockscout link"
            onKeyDown={(e) => e.key === "Enter" && void runImport()}
          />
          <button
            className="secondary"
            disabled={importing}
            onClick={() => void runImport()}
          >
            {importing ? "reading…" : "copy settings"}
          </button>
        </div>
        {importError ? <p className="error">{importError}</p> : null}
        {importNotes ? (
          <>
            <p className="ok" style={{ marginBottom: 4 }}>
              Settings copied into the form — review everything before launching.
            </p>
            <ul className="dim" style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
              {importNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="panel">
        <h2>Collection</h2>
        <div className="grid">
          <div className="field">
            <label>collection name</label>
            <input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="My Collection"
            />
          </div>
          <div className="field">
            <label>symbol</label>
            <input
              value={form.symbol}
              onChange={(e) => set({ symbol: e.target.value.toUpperCase() })}
              placeholder="MYC"
            />
          </div>
          <div className="field wide">
            <label>description</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div className="field">
            <label>category</label>
            <select
              value={form.category}
              onChange={(e) => set({ category: e.target.value })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="hint">
              written into the collection metadata as a hint. OpenSea&apos;s own
              category is set on opensea.io → your collection → Edit — it
              isn&apos;t a contract field, so confirm it there after indexing.
            </span>
          </div>
          <div className="field wide">
            <label>website (optional — shows on OpenSea as the collection link)</label>
            <input
              value={form.websiteUrl}
              onChange={(e) => set({ websiteUrl: e.target.value })}
              placeholder="https://…  (Twitter/X can't be set here — OpenSea connects it via OAuth in collection settings)"
            />
          </div>
          <div className="field">
            <label>number of NFTs (maxSupply)</label>
            <input
              type="number"
              min={1}
              value={form.supply || ""}
              onChange={(e) => set({ supply: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>collection picture (logo on OpenSea)</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setCollectionImageFile(e.target.files?.[0] ?? null)}
            />
            <span className="hint">
              the collection&apos;s own avatar — square works best. Optional: if
              you skip it, the pre-reveal image is used.
            </span>
            {collectionImageFile ? (
              <div className="file-pick">
                <img src={collectionImagePreview ?? undefined} alt="" />
                <span>
                  {collectionImageFile.name}{" "}
                  <span className="dim">
                    ({Math.round(collectionImageFile.size / 1024).toLocaleString()} KB)
                  </span>
                </span>
              </div>
            ) : saved?.collectionImageCid && !state?.completedAt ? (
              <span className="hint ok">
                already uploaded in a previous attempt — re-selecting is optional
              </span>
            ) : null}
          </div>
          <div className="field">
            <label>pre-reveal image (what every token shows)</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
            />
            <span className="hint">
              shown for every token until you run the Reveal — the real art
              stays off IPFS until then
            </span>
            {imageFile ? (
              <div className="file-pick">
                <img src={imagePreview ?? undefined} alt="" />
                <span>
                  {imageFile.name}{" "}
                  <span className="dim">
                    ({Math.round(imageFile.size / 1024).toLocaleString()} KB)
                  </span>
                </span>
              </div>
            ) : saved?.prerevealImageCid && !state?.completedAt ? (
              <span className="hint ok">
                already uploaded in a previous attempt — re-selecting is optional
              </span>
            ) : null}
          </div>
          <div className="field">
            <label>unrevealed item name</label>
            <input
              value={form.prerevealName}
              onChange={(e) => {
                setPrerevealNameEdited(true);
                set({ prerevealName: e.target.value });
              }}
              placeholder={defaultPrerevealName(form.name) || "My Collection (unrevealed)"}
            />
            <span className="hint">
              the name every token shows until the reveal
              {prerevealNameEdited ? (
                <>
                  {" · "}
                  <button
                    className="linklike"
                    onClick={() => {
                      setPrerevealNameEdited(false);
                      set({ prerevealName: defaultPrerevealName(form.name) });
                    }}
                  >
                    reset to default
                  </button>
                </>
              ) : (
                " · follows the collection name automatically"
              )}
            </span>
          </div>
          <div className="field wide">
            <label>unrevealed item description</label>
            <textarea
              rows={2}
              value={form.prerevealDescription}
              onChange={(e) => set({ prerevealDescription: e.target.value })}
              placeholder="shown on every token until the reveal"
            />
            <span className="hint">
              {form.prerevealDescription.trim() === "" ? (
                "empty — the collection description above will be used"
              ) : form.prerevealDescription === DEFAULT_PREREVEAL_DESCRIPTION ? (
                "using the default text — edit it to make it yours"
              ) : (
                <>
                  custom text ·{" "}
                  <button
                    className="linklike"
                    onClick={() =>
                      set({ prerevealDescription: DEFAULT_PREREVEAL_DESCRIPTION })
                    }
                  >
                    reset to default
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Public drop</h2>
        <div className="grid">
          <div className="field">
            <label>mint price (ETH — $ prices don&apos;t exist on-chain)</label>
            <input
              value={form.mintPriceEth}
              onChange={(e) => set({ mintPriceEth: e.target.value })}
              placeholder="0 for free mint"
            />
          </div>
          <div className="field">
            <label>per-wallet mint limit</label>
            <input
              type="number"
              min={1}
              value={form.perWalletLimit || ""}
              onChange={(e) => set({ perWalletLimit: Number(e.target.value) })}
            />
          </div>
          <div className="field wide">
            <label>when does minting open?</label>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <label className="radio-inline">
                <input
                  type="radio"
                  checked={form.startNow}
                  onChange={() => set({ startNow: true })}
                />
                right away
              </label>
              <label className="radio-inline">
                <input
                  type="radio"
                  checked={!form.startNow}
                  onChange={() =>
                    set({
                      startNow: false,
                      startLocal: form.startLocal || nowPlusMinutesLocalInput(60),
                    })
                  }
                />
                at a set time
              </label>
              {!form.startNow ? (
                <input
                  type="datetime-local"
                  style={{ width: "auto", flex: 1, minWidth: 200 }}
                  value={form.startLocal}
                  onChange={(e) => set({ startLocal: e.target.value })}
                />
              ) : null}
            </div>
            {!form.startNow && form.startLocal ? (
              <span className="hint">= {safeUtc(form.startLocal)}</span>
            ) : null}
          </div>

          <div className="field wide">
            <label>how long does minting stay open? (duration)</label>
            <div className="dur-row">
              {(
                [
                  ["durationDays", "days"],
                  ["durationHours", "hours"],
                  ["durationMins", "mins"],
                ] as const
              ).map(([key, unit]) => (
                <div className="field dur-field" key={key}>
                  <label>{unit}</label>
                  <input
                    type="number"
                    min={0}
                    value={form[key]}
                    onChange={(e) =>
                      set({ [key]: Math.max(0, Number(e.target.value) || 0) } as Partial<LaunchFormValues>)
                    }
                  />
                </div>
              ))}
              <div className="field dur-preset">
                <label>presets</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(
                    [
                      ["1h", 0, 1, 0],
                      ["24h", 1, 0, 0],
                      ["7d", 7, 0, 0],
                      ["30d", 30, 0, 0],
                      ["1y", 365, 0, 0],
                    ] as [string, number, number, number][]
                  ).map(([label, d, h, m]) => (
                    <button
                      key={label}
                      className="secondary"
                      style={{ padding: "4px 10px", fontSize: 11 }}
                      onClick={() =>
                        set({ durationDays: d, durationHours: h, durationMins: m })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <span className="hint ok">{windowPreview(form)}</span>
            <span className="hint">
              this is the same number OpenSea&apos;s stage dialog calls
              &ldquo;Duration&rdquo;. The contract stores it as an absolute end
              time, derived from the start above.
            </span>
          </div>
          <div className="field">
            <label>creator payout address (payouts stream here on every mint)</label>
            <input
              value={form.creatorPayoutAddress}
              onChange={(e) => set({ creatorPayoutAddress: e.target.value })}
              placeholder="0x…"
            />
          </div>
          <div className="field">
            <label>royalty % (optional, ERC-2981)</label>
            <input
              value={form.royaltyPercent}
              onChange={(e) => set({ royaltyPercent: e.target.value })}
              placeholder="e.g. 5 — leave empty to skip"
            />
          </div>
          <div className="field">
            <label>royalty enforcement</label>
            <select
              value={form.enforcedRoyalties ? "enforced" : "signal"}
              onChange={(e) =>
                set({ enforcedRoyalties: e.target.value === "enforced" })
              }
            >
              <option value="signal">
                signal only — marketplaces may ignore (default)
              </option>
              <option value="enforced">
                enforced — OpenSea transfer validator (+1 tx)
              </option>
            </select>
            <span className="hint">
              enforced = transfers restricted to royalty-respecting channels via{" "}
              {chainInfo.transferValidator?.slice(0, 10)}… — same validator live enforced
              drops on this chain use; owner can turn it off later
            </span>
          </div>
          <div className="field wide">
            <label>provenance hash (optional, 32-byte hex — set before mint as a trust signal)</label>
            <input
              value={form.provenanceHash}
              onChange={(e) => set({ provenanceHash: e.target.value })}
              placeholder="0x… (SHA-256 of your final art ordering)"
            />
          </div>
        </div>
        <p className="dim" style={{ marginBottom: 0 }}>
          OpenSea drop fee: {chainInfo.feeBps / 100}% to{" "}
          {chainInfo.feeRecipient.slice(0, 10)}… (required for OpenSea drops,
          restricted fee recipients on). Allowlist / signed / token-gated stages
          are intentionally not supported — public mint only. Mint currency is
          native ETH only: the canonical SeaDrop contract hard-codes msg.value
          payment, so ERC-20 pricing (USDG/WETH) would need a custom contract
          that OpenSea&apos;s drop indexing doesn&apos;t recognize.
        </p>
      </div>

      <div className="panel">
        <h2>Pinata</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Pinata pins your images and metadata to IPFS — that&apos;s where
          OpenSea reads them from. Free tier is plenty. Get a key at{" "}
          <a href="https://pinata.cloud" target="_blank" rel="noreferrer">
            pinata.cloud
          </a>{" "}
          → API Keys → New Key (needs <code>pinFileToIPFS</code> +{" "}
          <code>pinJSONToIPFS</code>, or just Admin).
        </p>
        <div className="field">
          <label>
            Pinata JWT{" "}
            {rememberJwt
              ? "(saved in this browser)"
              : "(kept in memory only — re-paste each session)"}
          </label>
          <input
            type="password"
            value={jwt}
            onChange={(e) => {
              setJwt(e.target.value);
              if (rememberJwt) savePinataJwt(e.target.value);
            }}
            placeholder="eyJ…"
            autoComplete="off"
          />
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            <label
              className="dim"
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="checkbox"
                checked={rememberJwt}
                onChange={(e) => {
                  setRememberJwt(e.target.checked);
                  if (e.target.checked) savePinataJwt(jwt);
                  else forgetPinataJwt();
                }}
              />
              remember this key in this browser (prefills next time)
            </label>
            {rememberJwt ? (
              <button
                className="secondary"
                style={{ padding: "2px 10px", fontSize: 11 }}
                onClick={() => {
                  forgetPinataJwt();
                  setRememberJwt(false);
                  setJwt("");
                }}
              >
                forget key
              </button>
            ) : null}
          </div>
          <span className="hint warn">
            Pinata&apos;s dialog shows three values — paste the <b>third</b>,
            &ldquo;JWT (secret access token)&rdquo;, which starts with{" "}
            <code>eyJ</code>. The API Key and API Secret will not work.
          </span>
        </div>
      </div>

      {errors.length > 0 ? (
        <ul className="errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      {phase === "running" ? (
        <div className="panel">
          <h2>Launching</h2>
          <Steps steps={steps} />
          {runError ? (
            <>
              <p className="error">{runError}</p>
              <button className="primary" onClick={() => runLaunch(true)}>
                RETRY FROM FAILED STEP
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <button
          className="primary"
          style={{ width: "100%", padding: "16px" }}
          disabled={!isConnected || wrongNetwork}
          onClick={openConfirm}
        >
          {!isConnected
            ? "CONNECT WALLET TO LAUNCH"
            : wrongNetwork
              ? "SWITCH TO ROBINHOOD CHAIN TO LAUNCH"
              : "LAUNCH"}
        </button>
      )}

      {phase === "confirm" && derived ? (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Confirm launch — read every line</h3>
            <dl>
              <dt>collection</dt>
              <dd>
                {form.name} ({form.symbol})
              </dd>
              <dt>supply</dt>
              <dd>{form.supply.toLocaleString()} NFTs</dd>
              <dt>price</dt>
              <dd>
                {derived.priceWei === 0n
                  ? "FREE (0 ETH)"
                  : `${weiToEth(derived.priceWei)} ETH each`}
              </dd>
              <dt>per wallet</dt>
              <dd>max {form.perWalletLimit} mints</dd>
              <dt>starts</dt>
              <dd>
                {unixToLocalAndUtc(derived.startTime).local}
                <br />
                {unixToLocalAndUtc(derived.startTime).utc}
              </dd>
              <dt>ends</dt>
              <dd>
                {unixToLocalAndUtc(derived.endTime).local}
                <br />
                {unixToLocalAndUtc(derived.endTime).utc}
                <div className="ok">
                  open for {formatDuration(derived.endTime - derived.startTime)}
                </div>
              </dd>
              <dt>payout to</dt>
              <dd>{derived.payout}</dd>
              <dt>OpenSea fee</dt>
              <dd>{chainInfo.feeBps / 100}% of mint price</dd>
              {factory ? (
                <>
                  <dt>launch fee</dt>
                  <dd>
                    {launchFee === 0n ? "FREE" : `${weiToEth(launchFee)} ETH`} (one-off,
                    paid now)
                  </dd>
                </>
              ) : null}
              <dt>royalties</dt>
              <dd>
                {derived.royaltyBps
                  ? `${derived.royaltyBps / 100}% to ${derived.payout.slice(0, 10)}… — ${
                      form.enforcedRoyalties
                        ? "ENFORCED via OpenSea transfer validator"
                        : "signal only (ERC-2981, marketplaces may ignore)"
                    }`
                  : "none (can set later in OpenSea collection settings)"}
              </dd>
              <dt>category</dt>
              <dd>{form.category}</dd>
              <dt>unrevealed name</dt>
              <dd>
                {form.prerevealName.trim() || defaultPrerevealName(form.name)}
              </dd>
              <dt>unrevealed description</dt>
              <dd>
                {form.prerevealDescription.trim() ||
                  form.description.trim() ||
                  "not set"}
              </dd>
              <dt>collection picture</dt>
              <dd>
                {collectionImageFile
                  ? collectionImageFile.name
                  : saved?.collectionImageCid
                    ? "already uploaded"
                    : "not set — the pre-reveal image will be used"}
              </dd>
              <dt>pre-reveal image</dt>
              <dd>
                {imageFile
                  ? imageFile.name
                  : saved?.prerevealImageCid
                    ? "already uploaded"
                    : "—"}
              </dd>
              <dt>website</dt>
              <dd>{form.websiteUrl.trim() || "not set"}</dd>
              <dt>provenance</dt>
              <dd>{derived.provenance ?? "not set"}</dd>
              <dt>predicted link</dt>
              <dd>{openSeaCollectionUrl(chainInfo, "<contract-address>")}</dd>
            </dl>
            <p className="warn">
              Name and symbol are permanent. Price, start/end time and
              per-wallet limit CAN be changed later by the owner via
              updatePublicDrop (Status tab). maxSupply can only be reduced,
              never below what&apos;s already minted.
            </p>
            <p>
              You will sign{" "}
              {2 + (derived.royaltyBps ? 1 : 0) + (form.enforcedRoyalties ? 1 : 0)}{" "}
              transactions: deploy, multiConfigure
              {derived.royaltyBps ? ", setRoyaltyInfo" : ""}
              {form.enforcedRoyalties ? ", setTransferValidator" : ""}.
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
                onClick={() => runLaunch(false)}
              >
                SIGN &amp; LAUNCH
              </button>
              <button className="secondary" onClick={() => setPhase("form")}>
                back
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Preview URL for a picked file, revoked when the file changes or unmounts. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/** Spell the derived window back out, so the absolute end is never a surprise. */
function windowPreview(form: LaunchFormValues): string {
  const seconds = durationToSeconds({
    days: form.durationDays,
    hours: form.durationHours,
    mins: form.durationMins,
  });
  if (seconds <= 0) return "set a duration above zero";
  let start: number;
  if (form.startNow) {
    start = Math.floor(Date.now() / 1000) + 120;
  } else {
    try {
      start = datetimeLocalToUnix(form.startLocal);
    } catch {
      return `${formatDuration(seconds)} — pick a start time to see the end date`;
    }
  }
  const end = unixToLocalAndUtc(start + seconds);
  return `open for ${formatDuration(seconds)} · ends ${end.local}`;
}

function safeUtc(local: string): string {
  try {
    return unixToLocalAndUtc(datetimeLocalToUnix(local)).utc;
  } catch {
    return "invalid date";
  }
}
