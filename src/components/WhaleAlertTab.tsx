import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveChain } from "../signer";
import { openSeaCollectionUrl } from "../chains";
import { fetchWalletEvents, mergeEvents, type WalletEvent } from "../lib/activity";
import { groupWhaleEntries, type WhaleGroup } from "../lib/whaleAlert";
import { notify, notifyPermission, requestNotifyPermission } from "../lib/notify";
import { useMe, useRunnerApi } from "../lib/runnerClient";
import { shortAddress } from "./ConnectBar";
import { timeAgo } from "../lib/convert";

const POLL_MS = 30_000;
const WINDOW_SEC = 24 * 60 * 60;

/**
 * Whale Alert (Pro): the service keeps a curated list of whale wallets, and
 * this watches them all for the one pattern that matters — several of them
 * going into the same collection at once. Three whales in is the first shout;
 * every whale after that is another. The list of whales is the owner's to
 * curate (admin tab); reading it and the alerts is a Pro feature.
 */
export default function WhaleAlertTab() {
  const { me } = useMe();
  const { base, token, call } = useRunnerApi();
  const chainInfo = useActiveChain();
  const api = chainInfo?.blockscoutApi;

  const [whales, setWhales] = useState<{ address: string; label?: string }[]>([]);
  const eventsRef = useRef<WalletEvent[]>([]);
  const [groups, setGroups] = useState<WhaleGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const seenCounts = useRef<Map<string, number>>(new Map());

  const pro = Boolean(me?.tier === "pro" || me?.admin);

  // Pull the curated whale list once signed in and Pro.
  useEffect(() => {
    if (!base || !token || !pro) return;
    void call("/api/curated")
      .then((c) => setWhales((c as { whales: { address: string; label?: string }[] }).whales ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [base, token, pro, call]);

  const poll = useCallback(async () => {
    if (!api || whales.length === 0) return;
    try {
      const batches = await Promise.all(
        whales.map((w) => fetchWalletEvents(api, w.address, w.label).catch(() => [] as WalletEvent[])),
      );
      const merged = mergeEvents(eventsRef.current, batches.flat(), 1000);
      eventsRef.current = merged;
      const since = Math.floor(Date.now() / 1000) - WINDOW_SEC;
      const g = groupWhaleEntries(merged, { minWhales: 3, sinceT: since });
      setGroups(g);
      // Notify when a group first crosses 3, or gains another whale.
      for (const grp of g) {
        const was = seenCounts.current.get(grp.contract) ?? 0;
        if (grp.count > was) {
          seenCounts.current.set(grp.contract, grp.count);
          if (was >= 3 || grp.count === 3) {
            notify(
              `🐋 ${grp.count} whales in ${grp.collection}`,
              `${grp.count} whales have aped into ${grp.collection}.`,
              `whale-${grp.contract}`,
            );
          }
        }
      }
      setCheckedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, whales]);

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
          moment several of them pile into the same collection. It is a Pro
          feature — upgrade on the Profile tab to switch it on.
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
          watching {whales.length} whale{whales.length === 1 ? "" : "s"}
          {checkedAt ? ` · checked ${timeAgo(Math.floor(checkedAt / 1000))}` : ""}
        </span>
        {notifyPermission() !== "granted" ? (
          <button className="secondary" style={{ fontSize: 11, padding: "2px 10px" }} onClick={() => void requestNotifyPermission()}>
            enable notifications
          </button>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {whales.length === 0 ? (
        <p className="dim">No whales are curated yet. (The owner adds them in the Admin tab.)</p>
      ) : groups.length === 0 ? (
        <p className="dim">No collection has 3+ whales in the last 24h yet. Kept live in the background.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((g) => (
            <div key={g.contract} className="panel" style={{ margin: 0, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 600 }}>
                  🐋 {g.count} whales · {g.collection}
                </div>
                <div className="dim" style={{ fontSize: 12 }}>last {timeAgo(g.lastAt)}</div>
              </div>
              <div className="dim mono-break" style={{ fontSize: 11, marginTop: 4 }}>
                {g.whales.map((w) => shortAddress(w)).join(" · ")}
              </div>
              {chainInfo && g.contract.startsWith("0x") ? (
                <a
                  href={openSeaCollectionUrl(chainInfo, g.contract as `0x${string}`) ?? "#"}
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
