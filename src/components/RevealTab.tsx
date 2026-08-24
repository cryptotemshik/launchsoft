import { useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { useSigner } from "../signer";
import { tokenAbi } from "../contracts/seadrop";
import { isAddress } from "../lib/convert";
import {
  buildTokenMetadata,
  parseStudioCsv,
  validateReveal,
  type StudioRow,
} from "../lib/csv";
import { pinDirectory, testPinataJwt } from "../lib/pinata";
import { loadPinataJwt, savePinataJwt } from "../lib/pinataKey";
import { loadLaunchState, updateLaunchState } from "../lib/launchState";
import { AddrLink, IpfsLink, Steps, TxLink, type StepView } from "./Bits";

type Phase = "form" | "running" | "done";

export default function RevealTab() {
  const { address, txAccount, isConnected, walletClient, wrongNetwork, chainInfo } =
    useSigner();
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const saved = useMemo(loadLaunchState, []);
  const [contract, setContract] = useState(saved?.contractAddress ?? "");
  const [jwt, setJwt] = useState(loadPinataJwt);
  const [images, setImages] = useState<File[]>([]);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvName, setCsvName] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("form");
  const [steps, setSteps] = useState<StepView[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [revealTx, setRevealTx] = useState<string | null>(
    saved?.revealTxHash ?? null,
  );

  const usingSaved = saved?.contractAddress === contract && contract !== "";

  function updateStep(id: string, patch: Partial<StepView>) {
    setSteps((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function onPickImages(list: FileList | null) {
    if (!list) return;
    // webkitdirectory delivers the whole folder; keep only images.
    const files = Array.from(list).filter((f) =>
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f.name),
    );
    setImages(files);
  }

  async function onPickCsv(file: File | null) {
    if (!file) {
      setCsvText(null);
      setCsvName("");
      return;
    }
    setCsvText(await file.text());
    setCsvName(file.name);
  }

  async function runReveal() {
    setErrors([]);
    setRunError(null);
    const errs: string[] = [];
    if (!isAddress(contract)) errs.push("Contract address is not valid");
    if (!jwt.trim()) errs.push("Pinata JWT is required");
    if (images.length === 0) errs.push("Select the images folder (1.png … N.png)");
    if (!walletClient || !publicClient || !address || !txAccount)
      errs.push("Connect a wallet or load a fast-mode key");
    if (wrongNetwork) errs.push("Switch to Robinhood Chain first");
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }

    const stepList: StepView[] = [
      { id: "chain", label: "Read collection state from chain", status: "pending" },
      { id: "validate", label: "Validate images ↔ CSV ↔ supply", status: "pending" },
      { id: "imgup", label: "Upload images folder to IPFS", status: "pending" },
      { id: "metaup", label: "Build + upload metadata folder", status: "pending" },
      { id: "tx", label: "TX — setBaseURI(ipfs://<metadataCID>/)", status: "pending" },
    ];
    setSteps(stepList);
    setPhase("running");

    try {
      // ── Chain state ──────────────────────────────────────────────────────
      updateStep("chain", { status: "running" });
      const target = contract as `0x${string}`;
      const [owner, maxSupply, name] = await Promise.all([
        publicClient!.readContract({ address: target, abi: tokenAbi, functionName: "owner" }),
        publicClient!.readContract({ address: target, abi: tokenAbi, functionName: "maxSupply" }),
        publicClient!.readContract({ address: target, abi: tokenAbi, functionName: "name" }),
      ]);
      if (owner.toLowerCase() !== address!.toLowerCase()) {
        throw new Error(
          `Connected wallet is not the owner of this contract (owner is ${owner})`,
        );
      }
      const supply = Number(maxSupply);
      updateStep("chain", {
        status: "done",
        detail: `${name} — maxSupply ${supply}, owner ok`,
      });

      // ── Validation ───────────────────────────────────────────────────────
      updateStep("validate", { status: "running" });
      let csvRows: StudioRow[] | null = null;
      if (csvText) {
        const parsed = parseStudioCsv(csvText);
        if (parsed.errors.length > 0) {
          throw new Error(`CSV problems:\n- ${parsed.errors.join("\n- ")}`);
        }
        csvRows = parsed.rows;
      }
      const problems = validateReveal({
        supply,
        imageFileNames: images.map((f) => f.name),
        csvRows,
      });
      if (problems.length > 0) {
        throw new Error(`Refusing to reveal:\n- ${problems.join("\n- ")}`);
      }
      updateStep("validate", {
        status: "done",
        detail: csvRows
          ? `${images.length} images, CSV rows matched`
          : `${images.length} images, minimal metadata (no CSV)`,
      });

      // ── Upload images ────────────────────────────────────────────────────
      updateStep("imgup", { status: "running" });
      await testPinataJwt(jwt);
      const imagesCid = await pinDirectory(
        jwt,
        images.map((f) => ({ path: f.name, content: f })),
        `${name} images`,
        (p) => updateStep("imgup", { progress: p }),
      );
      updateStep("imgup", {
        status: "done",
        detail: <IpfsLink uri={`ipfs://${imagesCid}`} />,
      });

      // ── Build + upload metadata ──────────────────────────────────────────
      updateStep("metaup", { status: "running" });
      const byId = new Map<number, StudioRow>();
      csvRows?.forEach((r) => byId.set(r.tokenId, r));
      const fileById = new Map<number, string>();
      for (const f of images) {
        const id = Number(f.name.match(/^(\d+)\./)![1]);
        fileById.set(id, f.name);
      }
      const metadataFiles = [];
      for (let id = 1; id <= supply; id++) {
        const row = byId.get(id) ?? null;
        // Prefer the CSV's file_name mapping; fall back to the file whose name
        // starts with the token id.
        const imageFileName = row?.fileName ?? fileById.get(id)!;
        const meta = buildTokenMetadata({
          tokenId: id,
          collectionName: name,
          imagesCid,
          imageFileName,
          csvRow: row,
        });
        // Files are named "1", "2", … with NO extension: tokenURI is
        // baseURI + tokenId, no ".json" suffix (verified in contract source).
        metadataFiles.push({
          path: String(id),
          content: new Blob([JSON.stringify(meta)], { type: "application/json" }),
        });
      }
      const metadataCid = await pinDirectory(
        jwt,
        metadataFiles,
        `${name} metadata`,
        (p) => updateStep("metaup", { progress: p }),
      );
      updateStep("metaup", {
        status: "done",
        detail: <IpfsLink uri={`ipfs://${metadataCid}`} />,
      });
      if (usingSaved) {
        updateLaunchState({ revealImagesCid: imagesCid, revealMetadataCid: metadataCid });
      }

      // ── setBaseURI ───────────────────────────────────────────────────────
      updateStep("tx", { status: "running", detail: "confirm in wallet…" });
      // Trailing slash is required: with it, tokenURI = baseURI + tokenId.
      const newBaseURI = `ipfs://${metadataCid}/`;
      const { request } = await publicClient!.simulateContract({
        address: target,
        abi: tokenAbi,
        functionName: "setBaseURI",
        args: [newBaseURI],
        account: txAccount!,
      });
      const hash = await walletClient!.writeContract(request);
      updateStep("tx", { detail: "waiting for confirmation…" });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`setBaseURI reverted (${hash})`);
      updateStep("tx", { status: "done", detail: <TxLink hash={hash} /> });
      if (usingSaved) updateLaunchState({ revealTxHash: hash });
      setRevealTx(hash);
      setPhase("done");
    } catch (e) {
      setSteps((all) => {
        const running = all.find((s) => s.status === "running");
        if (running) {
          const msg = e instanceof Error ? e.message : String(e);
          setRunError(msg);
          return all.map((s) =>
            s.id === running.id ? { ...s, status: "failed" as const } : s,
          );
        }
        setRunError(e instanceof Error ? e.message : String(e));
        return all;
      });
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>Reveal — publish the real art</h2>
        <p className="dim">
          The real images touch IPFS only now, at reveal time — uploading them
          earlier would let snipers scrape rarities before mint-out. This
          uploads images + metadata, then sends ONE transaction:
          setBaseURI(&quot;ipfs://&lt;metadataCID&gt;/&quot;). The contract
          emits BatchMetadataUpdate, which tells OpenSea to refresh.
        </p>
        <div className="grid">
          <div className="field wide">
            <label>contract address {usingSaved ? "(from saved launch)" : ""}</label>
            <input
              value={contract}
              onChange={(e) => setContract(e.target.value.trim())}
              placeholder="0x…"
            />
          </div>
          <div className="field">
            <label>images folder (1.png … N.png)</label>
            <input
              type="file"
              // @ts-expect-error — webkitdirectory is non-standard but universal
              webkitdirectory=""
              multiple
              onChange={(e) => onPickImages(e.target.files)}
            />
            {images.length > 0 ? (
              <span className="hint ok">{images.length} image files selected</span>
            ) : null}
          </div>
          <div className="field">
            <label>metadata CSV (optional — OpenSea Studio format)</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onPickCsv(e.target.files?.[0] ?? null)}
            />
            <span className="hint">
              {csvName
                ? `${csvName} loaded`
                : 'tokenID,name,description,file_name,external_url,attributes[…] — no CSV → "Name #N" metadata'}
            </span>
          </div>
          <div className="field wide">
            <label>
              Pinata JWT{" "}
              {loadPinataJwt() ? "(saved in this browser)" : "(memory only)"}
            </label>
            <input
              type="password"
              value={jwt}
              onChange={(e) => {
                setJwt(e.target.value);
                // Keep a remembered key in sync; never starts remembering here.
                if (loadPinataJwt()) savePinataJwt(e.target.value);
              }}
              placeholder="eyJ…"
              autoComplete="off"
            />
          </div>
        </div>
      </div>

      {errors.length > 0 ? (
        <ul className="errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      {phase !== "form" ? (
        <div className="panel">
          <h2>Revealing</h2>
          <Steps steps={steps} />
          {runError ? (
            <>
              <p className="error">{runError}</p>
              <button className="primary" onClick={runReveal}>
                RETRY
              </button>
            </>
          ) : null}
          {phase === "done" ? (
            <p className="ok">
              Revealed ✓ — OpenSea picks up BatchMetadataUpdate automatically.
              If an item still shows the placeholder after a while: item page →
              … → Refresh metadata.
            </p>
          ) : null}
        </div>
      ) : (
        <button
          className="primary"
          style={{ width: "100%", padding: "16px" }}
          disabled={!isConnected || wrongNetwork}
          onClick={runReveal}
        >
          {!isConnected
            ? "CONNECT WALLET TO REVEAL"
            : wrongNetwork
              ? "SWITCH TO ROBINHOOD CHAIN TO REVEAL"
              : "REVEAL"}
        </button>
      )}

      {revealTx && phase === "form" ? (
        <p className="dim">
          A reveal was already recorded for the saved launch:{" "}
          <TxLink hash={revealTx} />
        </p>
      ) : null}

      {saved?.contractAddress && !usingSaved ? (
        <p className="dim">
          Saved launch: <AddrLink address={saved.contractAddress} /> —{" "}
          <button
            className="secondary"
            onClick={() => setContract(saved.contractAddress!)}
          >
            use it
          </button>
        </p>
      ) : null}
    </div>
  );
}
