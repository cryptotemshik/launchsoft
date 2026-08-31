import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveChain } from "../signer";
import { openSeaCollectionUrl } from "../chains";
import { notify, notifyPermission, requestNotifyPermission } from "../lib/notify";
import { useMe, useRunnerApi } from "../lib/runnerClient";
import { shortAddress } from "./ConnectBar";
import { timeAgo } from "../lib/convert";

const POLL_MS = 30_000;

/**
 * Whale Alert (Pro): the one signal — several curated whales entering the same
 * collection at once. Three whales in is the first report; every whale after
 * that is another. The watching and the counting happen on the server, around
 * the clock, so this tab just shows what it found and pings the browser when a
 * new report lands. The whale list is the owner's to curate (admin tab).
 */
interface Alert {
  contract: string;
  name: string | null;
  whales: string[];
  count: number;
  firstAt: number;
  lastAt: number;
  minted: number;
}
interface Feed {
  alerts: Alert[];
  windowHours: number;
  watching: number;
  openSeaSlug?: string;
  status: string;
}

export default function WhaleAlertTab() {
  const { me } = useMe();
  const { base, token, call } = useRunnerApi();
  const chainInfo = useActiveChain();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenCounts = useRef<Map<string, number>>(new Map());

  const pro = Boolean(me?.tier === "pro" || me?.admin);

  const poll = useCallback(async () => {
    if (!base || !token || !pro) return;
    try {
      const f = (await call("/api/whale-alerts")) as unknown as Feed;
      setFeed(f);
      setError(null);
      for (const a of f.alerts ?? []) {
        const was = seenCounts.current.get(a.contract) ?? 0;
        if (a.count > was) {
          seenCounts.current.set(a.contract, a.count);
          if (a.count >= 3) {
            notify(
              `🐋 ${a.count} whales in ${a.name ?? "a collection"}`,
              `${a.count} whales have entered ${a.name ?? a.contract}.`,
              `whale-${a.contract}`,
            );
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base, token, pro, call]);

  useEffect(() => {
    if (!pro) return;
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll, pro]);

  if (!base || !token) {
    return (
      <div className="panel">
        <h2>Whale Alert</h2>
        <p className="dim">Sign in with your wallet on the SNIPE tab to use Whale Alert.</p>
      </div>
    );
  }
  if (!pro) {
    return (
      <div className="panel">
        <h2>Whale Alert <span className="pill warn">PRO</span></h2>
        <p className="dim">
          Whale Alert watches a curated set of whale wallets and tells you the
          moment three or more of them pile into the same collection. It runs on
          the server around the clock. A Pro feature — upgrade on the Profile tab.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>
        Whale Alert <span className="pill ok">PRO</span>
      </h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <span className="dim" style={{ fontSize: 12 }}>
          watching {feed?.watching ?? 0} whales · last {feed?.windowHours ?? 24}h
          {feed?.status ? ` · ${feed.status}` : ""}
        </span>
        {notifyPermission() !== "granted" ? (
          <button className="secondary" style={{ fontSize: 11, padding: "2px 10px" }} onClick={() => void requestNotifyPermission()}>
            enable notifications
          </button>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {(feed?.watching ?? 0) === 0 ? (
        <p className="dim">No whales are curated yet. (The owner adds them in the Admin tab.)</p>
      ) : (feed?.alerts?.length ?? 0) === 0 ? (
        <p className="dim">No collection has 3+ whales in the last {feed?.windowHours ?? 24}h yet. Watched on the server — you&apos;ll be notified.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {feed!.alerts.map((a) => (
            <div key={a.contract} className="panel" style={{ margin: 0, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 600 }}>
                  🐋 {a.count} whales · {a.name ?? shortAddress(a.contract)}
                  {a.minted > 0 ? <span className="dim" style={{ fontWeight: 400 }}> · {a.minted} minted</span> : null}
                </div>
                <div className="dim" style={{ fontSize: 12 }}>last {timeAgo(Math.floor(a.lastAt / 1000))}</div>
              </div>
              <div className="dim mono-break" style={{ fontSize: 11, marginTop: 4 }}>
                {a.whales.map((w) => shortAddress(w)).join(" · ")}
              </div>
              {chainInfo && a.contract.startsWith("0x") ? (
                <a
                  href={openSeaCollectionUrl(chainInfo, a.contract as `0x${string}`) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12 }}
                >
                  view collection ↗
                </a>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
