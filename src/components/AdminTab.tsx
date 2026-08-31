import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { useRunnerApi } from "../lib/runnerClient";
import { useActiveChain } from "../signer";
import { fetchEthBalance, fetchTopHolders, type Holder } from "../lib/discoverHolders";
import { shortAddress } from "./ConnectBar";

/**
 * The owner's window onto the whole service: who has an account, what plan they
 * are on and for how much longer, what they hold as balance, and the levers to
 * reward someone — a free month, a handful of free snipes, a manual balance
 * correction. Admin-only, and it proves it with every call: the server checks
 * the session is an admin's, so a non-admin who reached this tab still sees
 * nothing.
 */
interface Account {
  address: string;
  createdAt: number;
  tier: "free" | "pro";
  proUntil: number | null;
  nickname: string | null;
  twitter: string | null;
  telegram: string | null;
  balanceWei: string;
  balanceEth: string;
  freeSnipes: number;
  snipes: number;
}
interface Summary {
  accounts: number;
  pro: number;
  totalBalanceEth: string;
  totalSnipes: number;
}

export default function AdminTab() {
  const { base, token, call } = useRunnerApi();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [whales, setWhales] = useState<{ address: string; label?: string }[]>([]);
  const [influencers, setInfluencers] = useState<{ address: string; name: string; twitter?: string }[]>([]);
  const chainInfo = useActiveChain();
  const [discContract, setDiscContract] = useState("");
  const [discBusy, setDiscBusy] = useState(false);
  const [candidates, setCandidates] = useState<Holder[]>([]);

  const load = useCallback(async () => {
    if (!base || !token) return;
    setError(null);
    try {
      const r = (await call("/api/admin/accounts")) as unknown as {
        accounts: Account[];
        summary: Summary;
      };
      setAccounts(r.accounts);
      setSummary(r.summary);
      const c = (await call("/api/curated")) as unknown as {
        whales: { address: string; label?: string }[];
        influencers: { address: string; name: string; twitter?: string }[];
      };
      setWhales(c.whales ?? []);
      setInfluencers(c.influencers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base, token, call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(path: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await call(path, { method: "POST", body: JSON.stringify(body) });
      setNote(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function grantPro(address: string) {
    const days = Number(prompt(`Grant Pro to ${shortAddress(address)} — how many days? (negative to reduce)`, "30"));
    if (!Number.isFinite(days) || days === 0) return;
    void action("/api/admin/grant-pro", { address, days }, `Pro ${days > 0 ? "+" : ""}${days}d for ${shortAddress(address)}`);
  }
  function grantSnipes(address: string) {
    const count = Number(prompt(`Free snipes for ${shortAddress(address)} — how many?`, "5"));
    if (!Number.isInteger(count) || count <= 0) return;
    void action("/api/admin/grant-snipes", { address, count }, `+${count} free snipes for ${shortAddress(address)}`);
  }
  function adjust(address: string) {
    const eth = prompt(`Adjust balance for ${shortAddress(address)} — amount in ETH (negative to debit)`, "0.01");
    if (eth === null || eth.trim() === "") return;
    let wei: bigint;
    try {
      const neg = eth.trim().startsWith("-");
      const n = eth.trim().replace(/^-/, "");
      const [whole, frac = ""] = n.split(".");
      wei = (BigInt(whole || "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18))) * (neg ? -1n : 1n);
    } catch {
      alert("not a number");
      return;
    }
    const reason = prompt("Reason (for the ledger):", "goodwill") ?? "admin adjustment";
    void action("/api/admin/adjust", { address, wei: wei.toString(), note: reason }, `adjusted ${shortAddress(address)}`);
  }

  async function curatedAction(path: string, init: RequestInit, ok: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await call(path, init);
      setNote(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function addWhale() {
    const address = prompt("Whale wallet address (0x…)")?.trim();
    if (!address) return;
    const label = prompt("Label (optional)")?.trim() || "";
    void curatedAction("/api/admin/whales", { method: "POST", body: JSON.stringify({ address, label }) }, "whale added");
  }
  function addInfluencer() {
    const address = prompt("Influencer wallet address (0x…)")?.trim();
    if (!address) return;
    const name = prompt("Name")?.trim();
    if (!name) return;
    const twitter = prompt("Twitter/X handle (optional)")?.trim() || "";
    void curatedAction(
      "/api/admin/influencers",
      { method: "POST", body: JSON.stringify({ address, name, twitter }) },
      "influencer added",
    );
  }

  async function discoverWhales() {
    const api = chainInfo?.blockscoutApi;
    if (!api) {
      setError("this chain has no Blockscout API to read holders from");
      return;
    }
    const contract = discContract.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
      setError("paste a 0x collection contract to scan its holders");
      return;
    }
    setDiscBusy(true);
    setError(null);
    setNote(null);
    setCandidates([]);
    try {
      const holders = await fetchTopHolders(api, contract, 40);
      // Enrich the top 20 with an ETH balance for a rough "size" read — the one
      // figure we can price. Best-effort and rate-limit-friendly (sequential).
      const withBal: Holder[] = [];
      for (const h of holders) {
        withBal.push(
          withBal.length < 20 ? { ...h, balanceWei: await fetchEthBalance(api, h.address) } : h,
        );
      }
      setCandidates(withBal);
      if (holders.length === 0) setNote("no holders came back for that contract");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscBusy(false);
    }
  }

  const whaleSet = new Set(whales.map((w) => w.address.toLowerCase()));

  if (!base || !token) {
    return (
      <div className="panel">
        <h2>Admin</h2>
        <p className="dim">Sign in with your admin wallet on the SNIPE tab first.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Admin — accounts &amp; subscriptions</h2>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}

      {summary ? (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 16 }}>
          <Stat label="accounts" value={String(summary.accounts)} />
          <Stat label="pro" value={String(summary.pro)} />
          <Stat label="balances held" value={`${summary.totalBalanceEth} ETH`} />
          <Stat label="snipes billed" value={String(summary.totalSnipes)} />
        </div>
      ) : null}

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", opacity: 0.7 }}>
              <th style={{ padding: "6px 8px" }}>account</th>
              <th style={{ padding: "6px 8px" }}>tier</th>
              <th style={{ padding: "6px 8px" }}>pro until</th>
              <th style={{ padding: "6px 8px" }}>balance</th>
              <th style={{ padding: "6px 8px" }}>free</th>
              <th style={{ padding: "6px 8px" }}>snipes</th>
              <th style={{ padding: "6px 8px" }}>joined</th>
              <th style={{ padding: "6px 8px" }}>actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.address} style={{ borderTop: "1px solid var(--line, #23242b)" }}>
                <td style={{ padding: "6px 8px" }} title={a.address}>
                  {a.nickname ? `${a.nickname} · ` : ""}
                  <span className="mono-break">{shortAddress(a.address)}</span>
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <span className={`pill ${a.tier === "pro" ? "ok" : ""}`}>{a.tier}</span>
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {a.proUntil ? new Date(a.proUntil).toLocaleDateString() : "—"}
                </td>
                <td style={{ padding: "6px 8px" }}>{a.balanceEth}</td>
                <td style={{ padding: "6px 8px" }}>{a.freeSnipes}</td>
                <td style={{ padding: "6px 8px" }}>{a.snipes}</td>
                <td style={{ padding: "6px 8px" }}>{new Date(a.createdAt).toLocaleDateString()}</td>
                <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                  <button className="secondary" style={btn} disabled={busy} onClick={() => grantPro(a.address)}>
                    pro
                  </button>{" "}
                  <button className="secondary" style={btn} disabled={busy} onClick={() => grantSnipes(a.address)}>
                    +snipes
                  </button>{" "}
                  <button className="secondary" style={btn} disabled={busy} onClick={() => adjust(a.address)}>
                    ±balance
                  </button>
                </td>
              </tr>
            ))}
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: "12px 8px", opacity: 0.6 }}>
                  no accounts yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Discover whales from a collection's holders (runs in your browser, so
          it clears the chain explorer's bot check). Ranks by holdings, with an
          ETH balance for size — there is no USD floor feed for these NFTs. */}
      <div style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 8 }}>Discover whales from a collection</h3>
        <p className="dim" style={{ marginTop: 0, fontSize: 12 }}>
          Paste a collection contract — its biggest holders are ranked here so you
          can add them as whales. Sized by ETH balance (the one figure with a
          price); NFT portfolio value has no floor feed on this chain.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={discContract}
            onChange={(e) => setDiscContract(e.target.value)}
            placeholder="0x… collection contract"
            style={{ flex: 1, minWidth: 260, fontFamily: "var(--mono)" }}
          />
          <button className="primary" disabled={discBusy} onClick={() => void discoverWhales()}>
            {discBusy ? <span className="spin">SCANNING</span> : "find holders"}
          </button>
        </div>
        {candidates.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", fontSize: 12 }}>
            {candidates.map((h) => {
              const already = whaleSet.has(h.address.toLowerCase());
              return (
                <li key={h.address} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
                  <span className="mono-break" title={h.address}>
                    {shortAddress(h.address)}
                    <span className="dim">
                      {" · "}holds {h.count}
                      {h.balanceWei != null ? ` · ${Number(formatEther(BigInt(h.balanceWei))).toFixed(3)} ETH` : ""}
                    </span>
                  </span>
                  {already ? (
                    <span className="pill ok" style={{ fontSize: 10 }}>added</span>
                  ) : (
                    <button
                      className="secondary"
                      style={btn}
                      disabled={busy}
                      onClick={() =>
                        void curatedAction(
                          "/api/admin/whales",
                          { method: "POST", body: JSON.stringify({ address: h.address, label: `holds ${h.count}` }) },
                          `whale added: ${shortAddress(h.address)}`,
                        )
                      }
                    >
                      + whale
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 24 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h3 style={{ marginBottom: 8 }}>
            Whales <span className="dim" style={{ fontSize: 12 }}>({whales.length})</span>
            <button className="secondary" style={{ ...btn, marginLeft: 8 }} disabled={busy} onClick={addWhale}>
              + add
            </button>
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
            {whales.map((w) => (
              <li key={w.address} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
                <span className="mono-break" title={w.address}>
                  {shortAddress(w.address)}
                  {w.label ? <span className="dim"> · {w.label}</span> : null}
                </span>
                <button
                  className="secondary"
                  style={btn}
                  disabled={busy}
                  onClick={() =>
                    void curatedAction(
                      `/api/admin/whales?address=${w.address}`,
                      { method: "DELETE" },
                      "whale removed",
                    )
                  }
                >
                  remove
                </button>
              </li>
            ))}
            {whales.length === 0 ? <li className="dim">none yet</li> : null}
          </ul>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <h3 style={{ marginBottom: 8 }}>
            Influencers <span className="dim" style={{ fontSize: 12 }}>({influencers.length})</span>
            <button className="secondary" style={{ ...btn, marginLeft: 8 }} disabled={busy} onClick={addInfluencer}>
              + add
            </button>
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
            {influencers.map((i) => (
              <li key={i.address} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
                <span title={i.address}>
                  <strong>{i.name}</strong>
                  {i.twitter ? <span className="dim"> · @{i.twitter}</span> : null}{" "}
                  <span className="dim mono-break">{shortAddress(i.address)}</span>
                </span>
                <button
                  className="secondary"
                  style={btn}
                  disabled={busy}
                  onClick={() =>
                    void curatedAction(
                      `/api/admin/influencers?address=${i.address}`,
                      { method: "DELETE" },
                      "influencer removed",
                    )
                  }
                >
                  remove
                </button>
              </li>
            ))}
            {influencers.length === 0 ? <li className="dim">none yet</li> : null}
          </ul>
        </div>
      </div>
    </div>
  );
}

const btn = { padding: "2px 8px", fontSize: 11 } as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      <div className="dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
    </div>
  );
}
