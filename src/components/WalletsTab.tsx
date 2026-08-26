import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveChain } from "../signer";
import { openSeaCollectionUrl } from "../chains";
import {
  KIND_VERB,
  fetchWalletEvents,
  mergeEvents,
  type WalletEvent,
} from "../lib/activity";
import {
  addWallets,
  clearWatchlist,
  loadWatchlist,
  parseWalletBlob,
  removeWallet,
  type WatchedWallet,
} from "../lib/watchlist";
import {
  notify,
  notifyPermission,
  requestNotifyPermission,
  type NotifyPermission,
} from "../lib/notify";
import { timeAgo } from "../lib/convert";
import { shortAddress } from "./ConnectBar";
import { AddrLink, TxLink } from "./Bits";

const POLL_MS = 5_000;
const KIND_CLASS: Record<WalletEvent["kind"], string> = {
  mint: "ev-mint",
  buy: "ev-buy",
  sell: "ev-sell",
  receive: "ev-recv",
  send: "ev-send",
};

export default function WalletsTab() {
  const chainInfo = useActiveChain();
  const api = chainInfo?.blockscoutApi;

  const [wallets, setWallets] = useState<WatchedWallet[]>(loadWatchlist);
  const [blob, setBlob] = useState("");
  const [addNote, setAddNote] = useState<string | null>(null);
  const [events, setEvents] = useState<WalletEvent[]>([]);
  const [perm, setPerm] = useState<NotifyPermission>(notifyPermission);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seenRef = useRef<Set<string>>(new Set());
  const baselinedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const walletsKey = useMemo(
    () => wallets.map((w) => w.address).join(","),
    [wallets],
  );

  async function poll() {
    if (!api || wallets.length === 0 || checking) return;
    setChecking(true);
    setError(null);
    try {
      const batches = await Promise.all(
        wallets.map((w) =>
          fetchWalletEvents(api, w.address, w.label).catch(() => [] as WalletEvent[]),
        ),
      );
      const incoming = batches.flat();
      const fresh = incoming.filter((e) => !seenRef.current.has(e.id));
      for (const e of incoming) seenRef.current.add(e.id);

      // Suppress the first (baseline) batch so we don't fire a flood of old
      // events; notify only for genuinely new ones after that.
      if (baselinedRef.current && perm === "granted") {
        for (const e of fresh.sort((a, b) => a.t - b.t).slice(-6)) {
          const who = e.label || shortAddress(e.wallet);
          notify(
            `${who} ${KIND_VERB[e.kind]} ${e.collection}`,
            e.tokenId ? `#${e.tokenId} · ${chainInfo?.label ?? ""}` : chainInfo?.label ?? "",
            e.id,
          );
        }
      }
      baselinedRef.current = true;
      setEvents((prev) => mergeEvents(prev, incoming));
      setCheckedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  // Reset baseline + feed whenever the chain or the tracked set changes.
  useEffect(() => {
    seenRef.current = new Set();
    baselinedRef.current = false;
    setEvents([]);
    void poll();
    timerRef.current = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, walletsKey]);

  function onAdd() {
    const { wallets: parsed, invalid } = parseWalletBlob(blob);
    if (parsed.length === 0) {
      setAddNote("No valid 0x… addresses found. Paste one per line (label optional).");
      return;
    }
    const before = wallets.length;
    const next = addWallets(parsed);
    setWallets(next);
    setBlob("");
    const added = next.length - before;
    const parts = [`${added} added`, `${parsed.length - added} already tracked`];
    if (invalid.length) parts.push(`${invalid.length} line(s) skipped`);
    setAddNote(parts.join(" · "));
  }

  async function enableNotifications() {
    setPerm(await requestNotifyPermission());
  }

  return (
    <div>
      <div className="panel">
        <h2>Wallet tracker</h2>
        <p className="dim">
          Watch any set of wallets and get alerted when they <b>mint</b>,{" "}
          <b>buy</b>, or <b>sell</b> an NFT. Addresses only — never keys. Add in
          bulk: one per line, an optional label on the same line
          (<code>0xabc… whale</code>).
        </p>
        <textarea
          rows={4}
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          placeholder={"0x1234…abcd  vitalik\n0xabcd…5678\n0x… , punk-whale"}
          style={{ width: "100%", fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <button className="primary" onClick={onAdd}>
            + add wallets
          </button>
          <button className="secondary" disabled={checking || !api} onClick={() => void poll()}>
            {checking ? "checking…" : "check now"}
          </button>
          {perm === "granted" ? (
            <span className="pill ok" style={{ alignSelf: "center" }}>
              notifications on
            </span>
          ) : perm === "unsupported" ? (
            <span className="dim" style={{ alignSelf: "center" }}>
              notifications not supported here
            </span>
          ) : (
            <button className="secondary" onClick={() => void enableNotifications()}>
              {perm === "denied" ? "notifications blocked — enable in browser" : "enable notifications"}
            </button>
          )}
          {wallets.length > 0 ? (
            <button
              className="danger"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                setWallets(clearWatchlist());
                setEvents([]);
              }}
            >
              clear all
            </button>
          ) : null}
        </div>
        {addNote ? <p className="dim" style={{ marginBottom: 0 }}>{addNote}</p> : null}
        {!api ? (
          <p className="warn" style={{ marginBottom: 0 }}>
            {chainInfo?.label ?? "This chain"} has no Blockscout API in the
            registry, so live activity can&apos;t be read here. Switch to a
            Blockscout chain (Robinhood, Base, Optimism, Zora, Soneium,
            Unichain, Shape, B3, Flow) to track wallets.
          </p>
        ) : null}
        <p className="hint dim" style={{ marginBottom: 0 }}>
          Alerts fire while this tab is open (browser notifications). Closed-tab
          push isn&apos;t possible from a static site — that needs a backend with
          Web Push, which this keyless app doesn&apos;t run.
        </p>
      </div>

      {wallets.length > 0 ? (
        <div className="panel">
          <h2>Tracked wallets ({wallets.length})</h2>
          <div className="chip-wrap">
            {wallets.map((w) => (
              <span key={w.address} className="wallet-chip">
                {w.label ? <b>{w.label}</b> : null}
                <AddrLink address={w.address} />
                <button
                  className="chip-x"
                  title="stop tracking"
                  onClick={() => setWallets(removeWallet(w.address))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <h2>
          Activity feed
          {checkedAt ? (
            <span className="dim" style={{ fontSize: 12, fontWeight: 400, marginLeft: 10 }}>
              <span className="ok">● live</span> · checked {new Date(checkedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </h2>
        {error ? <p className="error">{error}</p> : null}
        {events.length === 0 ? (
          <p className="dim">
            {wallets.length === 0
              ? "Add wallets above to start tracking their NFT mints, buys, and sells."
              : api
                ? "No recent NFT activity for the tracked wallets yet."
                : "Live activity is unavailable on this chain."}
          </p>
        ) : (
          <ul className="feed">
            {/* Sixty rendered rows is plenty of feed; memory keeps 200. */}
            {events.slice(0, 60).map((e) => (
              <li key={e.id} className="feed-row">
                <span className={`ev-pill ${KIND_CLASS[e.kind]}`}>{e.kind}</span>
                <span className="feed-main">
                  <b>{e.label || shortAddress(e.wallet)}</b> {KIND_VERB[e.kind]}{" "}
                  {e.contract ? (
                    <a
                      href={openSeaCollectionUrl(chainInfo!, e.contract)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {e.collection}
                    </a>
                  ) : (
                    e.collection
                  )}
                  {e.tokenId ? <span className="dim"> #{e.tokenId}</span> : null}
                </span>
                <span className="feed-meta dim">
                  {timeAgo(e.t)} · <TxLink hash={e.txHash} label="tx" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
