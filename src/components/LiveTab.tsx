import { useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { useActiveChain } from "../signer";
import { openSeaCollectionUrl } from "../chains";
import { tokenAbi } from "../contracts/seadrop";
import { formatEthShort } from "../lib/profit";
import { timeAgo } from "../lib/convert";
import {
  aggregateTrending,
  feedStats,
  fetchMintFeed,
  mergeMints,
  type MintEvent,
} from "../lib/mintfeed";
import { shortAddress } from "./ConnectBar";
import { CopyButton, TxLink } from "./Bits";
import { TrendingIcon } from "./icons";

const POLL_MS = 5_000;

export default function LiveTab() {
  const chainInfo = useActiveChain();
  const api = chainInfo?.blockscoutApi;
  const publicClient = usePublicClient({ chainId: chainInfo?.id });

  const [mints, setMints] = useState<MintEvent[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namesRef = useRef<Map<string, string>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval>>();

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

  async function poll() {
    if (!api || !chainInfo) return;
    setLoading(true);
    setError(null);
    try {
      const incoming = await fetchMintFeed(api, chainInfo.seaDrop);
      setMints((prev) => mergeMints(prev, incoming));
      setUpdatedAt(Date.now());
      void resolveNames(incoming.map((e) => e.collection));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setMints([]);
    namesRef.current = new Map();
    setNames(new Map());
    void poll();
    timerRef.current = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chainInfo?.id]);

  const stats = useMemo(() => feedStats(mints), [mints]);
  const trending = useMemo(() => aggregateTrending(mints).slice(0, 8), [mints]);
  const oldest = mints.length ? mints[mints.length - 1].t : null;

  const nameOf = (addr: string) =>
    names.get(addr.toLowerCase()) || shortAddress(addr);

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
          {oldest ? `, over roughly the last ${timeAgo(oldest)}` : ""}. Refreshes
          every {POLL_MS / 1000}s. {loading ? "updating…" : ""}
        </p>
        {error ? <p className="error" style={{ marginBottom: 0 }}>{error}</p> : null}
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
                <span className="ev-pill ev-mint">mint</span>
                <span className="feed-main">
                  <b>{shortAddress(e.minter)}</b> minted{" "}
                  <span className="qty">×{e.quantity}</span>{" "}
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
