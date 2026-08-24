import { useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { useActiveChain } from "../signer";
import { openSeaCollectionUrl, openSeaProfileUrl } from "../chains";
import { tokenAbi } from "../contracts/seadrop";
import { fetchCollectionImage } from "../lib/collectionData";
import { formatEthShort } from "../lib/profit";
import { timeAgo } from "../lib/convert";
import {
  aggregateTrending,
  feedStats,
  fetchMintFeed,
  mergeMints,
  type MintEvent,
} from "../lib/mintfeed";
import { watchMints, type MintWatch, type WatchStatus } from "../lib/mintWatch";
import { shortAddress } from "./ConnectBar";
import { CopyButton, IpfsImg, TxLink } from "./Bits";
import { TrendingIcon } from "./icons";

const POLL_MS = 5_000;

export default function LiveTab() {
  const chainInfo = useActiveChain();
  const api = chainInfo?.blockscoutApi;
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const [mints, setMints] = useState<MintEvent[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [images, setImages] = useState<Map<string, string | null>>(new Map());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Realtime (optional) — a pasted WebSocket RPC gives instant mints.
  const [wssInput, setWssInput] = useState("");
  const [wssUrl, setWssUrl] = useState("");
  const [wsStatus, setWsStatus] = useState<WatchStatus | "off">("off");
  const [wsError, setWsError] = useState<string | null>(null);

  const namesRef = useRef<Map<string, string>>(new Map());
  const imagesRef = useRef<Map<string, string | null>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const watchRef = useRef<MintWatch | null>(null);

  async function resolveNames(addrs: string[]) {
    if (!publicClient) return;
    const todo = [...new Set(addrs.map((a) => a.toLowerCase()))]
      .filter((a) => !namesRef.current.has(a))
      .slice(0, 12);
    if (todo.length === 0) return;
    await Promise.all(
      todo.map(async (a) => {
        try {
          const name = (await publicClient.readContract({
            address: a as `0x${string}`,
            abi: tokenAbi,
            functionName: "name",
          })) as string;
          namesRef.current.set(a, name);
        } catch {
          namesRef.current.set(a, "");
        }
      }),
    );
    setNames(new Map(namesRef.current));
  }

  async function resolveImages(addrs: string[]) {
    if (!publicClient) return;
    const todo = [...new Set(addrs.map((a) => a.toLowerCase()))]
      .filter((a) => !imagesRef.current.has(a))
      .slice(0, 8);
    if (todo.length === 0) return;
    await Promise.all(
      todo.map(async (a) => {
        const img = await fetchCollectionImage(publicClient, a as `0x${string}`);
        imagesRef.current.set(a, img);
      }),
    );
    setImages(new Map(imagesRef.current));
  }

  function ingest(incoming: MintEvent[]) {
    setMints((prev) => mergeMints(prev, incoming));
    void resolveNames(incoming.map((e) => e.collection));
    void resolveImages(incoming.map((e) => e.collection));
  }

  async function poll() {
    if (!api || !chainInfo) return;
    setLoading(true);
    setError(null);
    try {
      const incoming = await fetchMintFeed(api, chainInfo.seaDrop);
      ingest(incoming);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Blockscout REST backfill + periodic refresh.
  useEffect(() => {
    setMints([]);
    namesRef.current = new Map();
    imagesRef.current = new Map();
    setNames(new Map());
    setImages(new Map());
    void poll();
    timerRef.current = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chainInfo?.id]);

  // Realtime WebSocket subscription (when a wss URL is set).
  useEffect(() => {
    watchRef.current?.stop();
    watchRef.current = null;
    setWsStatus("off");
    setWsError(null);
    if (!wssUrl || !chainInfo) return;
    setWsStatus("connecting");
    watchRef.current = watchMints({
      wssUrl,
      chain: chainInfo.chain,
      seaDrop: chainInfo.seaDrop,
      onMint: (e) => {
        ingest([e]);
        setUpdatedAt(Date.now());
      },
      onStatus: (s, msg) => {
        setWsStatus(s);
        setWsError(s === "error" ? msg ?? "connection error" : null);
      },
    });
    return () => {
      watchRef.current?.stop();
      watchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wssUrl, chainInfo?.id]);

  const stats = useMemo(() => feedStats(mints), [mints]);
  const trending = useMemo(() => aggregateTrending(mints).slice(0, 8), [mints]);
  const oldest = mints.length ? mints[mints.length - 1].t : null;

  const nameOf = (addr: string) => names.get(addr.toLowerCase()) || shortAddress(addr);
  const imgOf = (addr: string) => images.get(addr.toLowerCase()) ?? undefined;

  if (!api) {
    return (
      <div className="panel">
        <h2>Live mints</h2>
        <p className="warn" style={{ marginBottom: 6 }}>
          {chainInfo?.label ?? "This chain"} has no Blockscout API in the
          registry, so the live mint feed can&apos;t be read here.
        </p>
        <p className="dim" style={{ marginBottom: 0 }}>
          Switch to a Blockscout chain — Robinhood, Base, Optimism, Zora,
          Soneium, Unichain, Shape, B3, or Flow — to see what&apos;s minting.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="panel">
        <h2>
          Live mints — {chainInfo?.label}
          {updatedAt ? (
            <span className="dim" style={{ fontSize: 12, fontWeight: 400, marginLeft: 10 }}>
              <span className="ok">● live</span> · {new Date(updatedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-num">{stats.quantity.toLocaleString()}</div>
            <div className="stat-label">NFTs minted</div>
          </div>
          <div className="stat">
            <div className="stat-num">{stats.mints.toLocaleString()}</div>
            <div className="stat-label">mint txns</div>
          </div>
          <div className="stat">
            <div className="stat-num">{stats.minters.toLocaleString()}</div>
            <div className="stat-label">unique minters</div>
          </div>
          <div className="stat">
            <div className="stat-num">{stats.collections.toLocaleString()}</div>
            <div className="stat-label">collections</div>
          </div>
        </div>
        <p className="hint dim" style={{ marginBottom: 0 }}>
          Newest SeaDrop mints across every collection on {chainInfo?.label}
          {oldest ? `, over roughly the last ${timeAgo(oldest)}` : ""}.{" "}
          {wsStatus === "live"
            ? "Realtime via WebSocket."
            : `Refreshes every ${POLL_MS / 1000}s.`}{" "}
          {loading ? "updating…" : ""}
        </p>
        {error ? <p className="error" style={{ marginBottom: 0 }}>{error}</p> : null}
      </div>

      <div className="panel">
        <h2>Realtime feed (optional)</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          The list above refreshes every {POLL_MS / 1000}s off Blockscout. For
          instant mints, paste a <b>WebSocket</b> RPC (<code>wss://…</code>) that
          supports <code>eth_subscribe</code> — e.g. your Alchemy WebSocket URL
          for {chainInfo?.label}. It subscribes directly to SeaDrop mint logs;
          nothing is stored.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ flex: 1, minWidth: 260 }}
            value={wssInput}
            onChange={(e) => setWssInput(e.target.value)}
            placeholder="wss://….g.alchemy.com/v2/YOUR_KEY"
            onKeyDown={(e) => e.key === "Enter" && setWssUrl(wssInput.trim())}
          />
          {wsStatus === "off" ? (
            <button className="secondary" onClick={() => setWssUrl(wssInput.trim())} disabled={!wssInput.trim()}>
              connect
            </button>
          ) : (
            <button
              className="danger"
              onClick={() => {
                setWssUrl("");
                setWssInput("");
              }}
            >
              disconnect
            </button>
          )}
        </div>
        {wsStatus !== "off" ? (
          <p
            className={wsStatus === "live" ? "ok" : wsStatus === "error" ? "error" : "dim"}
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {wsStatus === "live"
              ? "● realtime — subscribed to SeaDrop mints"
              : wsStatus === "connecting"
                ? "connecting…"
                : `WebSocket error: ${wsError ?? "failed"} — check the URL supports eth_subscribe`}
          </p>
        ) : null}
      </div>

      <div className="panel">
        <h2>
          <TrendingIcon /> Trending — most minted
        </h2>
        {trending.length === 0 ? (
          <p className="dim">No mints seen yet — trending appears as drops go live.</p>
        ) : (
          <div className="table-wrap">
            <table className="projects">
              <thead>
                <tr>
                  <th>#</th>
                  <th>collection</th>
                  <th>minted</th>
                  <th>minters</th>
                  <th>volume≈</th>
                  <th>last</th>
                </tr>
              </thead>
              <tbody>
                {trending.map((r, i) => (
                  <tr key={r.collection}>
                    <td className="dim">{i + 1}</td>
                    <td>
                      <span className="coll-cell">
                        <IpfsImg uri={imgOf(r.collection)} size={30} alt="" />
                        <a
                          href={openSeaCollectionUrl(chainInfo!, r.collection)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {nameOf(r.collection)}
                        </a>
                        <CopyButton text={r.collection} />
                      </span>
                    </td>
                    <td>
                      <b>{r.quantity.toLocaleString()}</b>
                      <span className="dim"> ({r.mints} tx)</span>
                    </td>
                    <td>{r.minters.toLocaleString()}</td>
                    <td>
                      {r.volumeWei > 0n ? (
                        `${formatEthShort(r.volumeWei)} ETH`
                      ) : (
                        <span className="dim">free</span>
                      )}
                    </td>
                    <td className="dim">{timeAgo(r.lastT)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Latest mints</h2>
        {mints.length === 0 ? (
          <p className="dim">Waiting for the next mint…</p>
        ) : (
          <ul className="feed">
            {mints.slice(0, 60).map((e) => (
              <li key={e.id} className="feed-row">
                <IpfsImg uri={imgOf(e.collection)} size={34} alt="" />
                <span className="feed-main">
                  <a href={openSeaProfileUrl(e.minter)} target="_blank" rel="noreferrer">
                    <b>{shortAddress(e.minter)}</b>
                  </a>{" "}
                  minted <span className="qty">×{e.quantity}</span>{" "}
                  <a
                    href={openSeaCollectionUrl(chainInfo!, e.collection)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {nameOf(e.collection)}
                  </a>
                  {e.unitPriceWei > 0n ? (
                    <span className="dim"> · {formatEthShort(e.unitPriceWei)} ETH ea</span>
                  ) : (
                    <span className="dim"> · free</span>
                  )}
                </span>
                <span className="feed-meta dim">
                  <CopyButton text={e.collection} title="copy collection contract" />
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
