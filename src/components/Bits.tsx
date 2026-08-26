import { useEffect, useRef, useState, type ReactNode } from "react";
import { sndTxConfirmed, sndTxFailed, sndTxSubmitted } from "../lib/sound";
import {
  CHAINS_BY_ID,
  DEFAULT_CHAIN_ID,
  explorerAddressUrl,
  explorerTxUrl,
  ipfsGatewayUrl,
  ipfsUrl,
  IPFS_GATEWAYS,
} from "../chains";
import { useActiveChain } from "../signer";
import { collectionOpenSeaUrl, setOpenSeaUrl } from "../lib/projects";
import { recordClick, type LinkKind } from "../lib/linkStats";
import { CheckIcon, CopyIcon } from "./icons";

/**
 * Copy-to-clipboard button — copies `text` and briefly flips to a check.
 * Used to grab a collection's contract address without leaving the app.
 */
export function CopyButton({
  text,
  title = "copy contract address",
}: {
  text: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for insecure contexts / older browsers.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={copy}
      title={title}
      aria-label={title}
    >
      {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
    </button>
  );
}

/** Active chain, falling back to the default so links still resolve. */
function useLinkChain() {
  return useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const info = useLinkChain();
  return (
    <a
      className={label ? undefined : "mono-break"}
      href={explorerTxUrl(info, hash)}
      target="_blank"
      rel="noreferrer"
    >
      {label ?? hash}
    </a>
  );
}

export function AddrLink({ address }: { address: string }) {
  const info = useLinkChain();
  return (
    <a
      className="mono-break"
      href={explorerAddressUrl(info, address)}
      target="_blank"
      rel="noreferrer"
    >
      {address}
    </a>
  );
}

/**
 * The collection's OpenSea link with a copy button and an inline editor.
 * OpenSea mints its own slug at index time, so the address-based URL is only
 * a fallback until the real one is pasted in.
 */
export function OpenSeaLink({
  address,
  fallback,
  label = "OpenSea",
  onCounted,
}: {
  address: string;
  fallback: string;
  label?: string;
  onCounted?: () => void;
}) {
  const [url, setUrl] = useState(() => collectionOpenSeaUrl(address, fallback));
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  function commit() {
    setOpenSeaUrl(address, draft);
    setUrl(draft.trim() || fallback);
    setEditing(false);
  }

  if (editing) {
    return (
      <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        <input
          style={{ minWidth: 220 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://opensea.io/collection/your-slug"
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        <button className="secondary" style={{ padding: "2px 10px", fontSize: 11 }} onClick={commit}>
          save
        </button>
        <button
          className="secondary"
          style={{ padding: "2px 10px", fontSize: 11 }}
          onClick={() => setEditing(false)}
        >
          cancel
        </button>
      </span>
    );
  }

  return (
    <span className="addr-row">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={() => {
          recordClick(address, "opensea");
          onCounted?.();
        }}
      >
        {label}
      </a>
      <CopyButton text={url} title="copy OpenSea link" />
      <button
        className="secondary"
        style={{ padding: "2px 10px", fontSize: 11 }}
        title="paste the real OpenSea link once the collection is indexed"
        onClick={() => {
          setDraft(url === fallback ? "" : url);
          setEditing(true);
        }}
      >
        edit
      </button>
    </span>
  );
}

/**
 * An outbound link that bumps this collection's click counter before opening.
 * Counts clicks made here, in this browser — see lib/linkStats for the limits.
 */
export function TrackedLink({
  contract,
  kind,
  href,
  children,
  onCounted,
}: {
  contract: string;
  kind: LinkKind;
  href: string;
  children: ReactNode;
  onCounted?: () => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => {
        recordClick(contract, kind);
        onCounted?.();
      }}
    >
      {children}
    </a>
  );
}

/**
 * An image that resolves an ipfs:// URI and falls back across gateways on
 * error, so a single slow/rate-limited gateway doesn't leave a broken image.
 * Renders a neutral placeholder while empty or once every gateway has failed.
 */
export function IpfsImg({
  uri,
  alt = "",
  size = 34,
  radius = 8,
}: {
  uri?: string | null;
  alt?: string;
  size?: number;
  radius?: number;
}) {
  const [gw, setGw] = useState(0);
  const [failed, setFailed] = useState(false);

  // Reset the gateway walk whenever the source changes.
  useEffect(() => {
    setGw(0);
    setFailed(false);
  }, [uri]);

  const box = {
    width: size,
    height: size,
    borderRadius: radius,
    flex: "none" as const,
    objectFit: "cover" as const,
    background: "var(--surface-hi)",
    border: "1px solid var(--line)",
  };

  if (!uri || failed) {
    return <div style={{ ...box, display: "inline-block" }} aria-hidden />;
  }
  const src = uri.startsWith("ipfs://") ? ipfsUrl(uri, gw) : uri;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      style={box}
      onError={() => {
        if (uri.startsWith("ipfs://") && gw + 1 < IPFS_GATEWAYS.length) setGw((g) => g + 1);
        else setFailed(true);
      }}
    />
  );
}

export function IpfsLink({ uri }: { uri: string }) {
  return (
    <a
      className="mono-break"
      href={ipfsGatewayUrl(uri)}
      target="_blank"
      rel="noreferrer"
    >
      {uri}
    </a>
  );
}

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepView {
  id: string;
  label: string;
  status: StepStatus;
  detail?: ReactNode;
  /** 0..1 upload progress while running. */
  progress?: number;
}

const MARKERS: Record<StepStatus, string> = {
  pending: "[ ]",
  running: "[~]",
  done: "[✓]",
  failed: "[✗]",
};

export function Steps({ steps }: { steps: StepView[] }) {
  // Sounds ride the status transitions: a step starting to run is a
  // submission, done a confirmation, failed a buzz. Diffing here means every
  // flow that renders Steps gets audio without knowing about it.
  const prev = useRef<Map<string, StepStatus>>(new Map());
  useEffect(() => {
    for (const s of steps) {
      const was = prev.current.get(s.id);
      if (was === s.status) continue;
      if (s.status === "running" && was === "pending") sndTxSubmitted();
      if (s.status === "done" && was !== undefined) sndTxConfirmed();
      if (s.status === "failed") sndTxFailed();
      prev.current.set(s.id, s.status);
    }
  }, [steps]);
  return (
    <ul className="steps">
      {steps.map((s) => (
        <li key={s.id} className={s.status}>
          <span className="marker">{MARKERS[s.status]}</span>
          <span style={{ flex: 1 }}>
            {s.label}
            {s.status === "running" && s.progress !== undefined ? (
              <div className={`progressbar${s.progress >= 1 ? " full" : ""}`}>
                <div style={{ width: `${Math.round(s.progress * 100)}%` }} />
              </div>
            ) : null}
            {s.detail ? <div className="detail">{s.detail}</div> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
