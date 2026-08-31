import { useCallback, useEffect, useState } from "react";
import { useActiveChain } from "../signer";
import { KIND_VERB, fetchWalletEvents, type WalletEvent } from "../lib/activity";
import { useMe, useRunnerApi } from "../lib/runnerClient";
import { shortAddress } from "./ConnectBar";
import { timeAgo } from "../lib/convert";

interface Influencer {
  address: string;
  name: string;
  twitter?: string;
}

/**
 * Influencers (Pro): a vouched-for list of accounts, curated by the owner, and
 * what each of them has been minting and buying lately — so people can follow
 * the wallets they trust. Reads their on-chain NFT activity directly (the same
 * source the tracker uses); a full realised-PnL figure needs trade prices we do
 * not have yet, so this shows the moves, honestly, rather than a made-up number.
 */
export default function InfluencersTab() {
  const { me } = useMe();
  const { base, token, call } = useRunnerApi();
  const chainInfo = useActiveChain();
  const api = chainInfo?.blockscoutApi;

  const [influencers, setInfluencers] = useState<Influencer[]>([]);
  const [activity, setActivity] = useState<Record<string, WalletEvent[]>>({});
  const [error, setError] = useState<string | null>(null);

  const pro = Boolean(me?.tier === "pro" || me?.admin);

  useEffect(() => {
    if (!base || !token || !pro) return;
    void call("/api/curated")
      .then((c) => setInfluencers((c as { influencers: Influencer[] }).influencers ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [base, token, pro, call]);

  const load = useCallback(async () => {
    if (!api || influencers.length === 0) return;
    const entries = await Promise.all(
      influencers.map(
        async (i) => [i.address, await fetchWalletEvents(api, i.address, i.name).catch(() => [])] as const,
      ),
    );
    setActivity(Object.fromEntries(entries));
  }, [api, influencers]);

  useEffect(() => {
    if (!pro) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [load, pro]);

  if (!base || !token) {
    return (
      <div className="panel">
        <h2>Influencers</h2>
        <p className="dim">Sign in with your wallet on the SNIPE tab to follow influencers.</p>
      </div>
    );
  }
  if (!pro) {
    return (
      <div className="panel">
        <h2>Influencers <span className="pill warn">PRO</span></h2>
        <p className="dim">
          Follow a vouched-for set of accounts and see what they are minting and
          buying. A Pro feature — upgrade on the Profile tab to switch it on.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>
        Influencers <span className="pill ok">PRO</span>
      </h2>
      {error ? <p className="error">{error}</p> : null}
      {influencers.length === 0 ? (
        <p className="dim">No influencers are curated yet. (The owner adds them in the Admin tab.)</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {influencers.map((i) => {
            const evs = (activity[i.address] ?? []).slice(0, 6);
            return (
              <div key={i.address} className="panel" style={{ margin: 0, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 600 }}>
                    {i.name}{" "}
                    {i.twitter ? (
                      <a href={`https://x.com/${i.twitter}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                        @{i.twitter}
                      </a>
                    ) : null}
                  </div>
                  <span className="dim" style={{ fontSize: 11 }} title={i.address}>
                    {shortAddress(i.address)}
                  </span>
                </div>
                {evs.length === 0 ? (
                  <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>no recent NFT activity</div>
                ) : (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 12 }}>
                    {evs.map((e) => (
                      <li key={e.id} className={`ev-${e.kind}`}>
                        {KIND_VERB[e.kind]} <strong>{e.collection}</strong>
                        {e.tokenId ? ` #${e.tokenId}` : ""} · {timeAgo(e.t)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
