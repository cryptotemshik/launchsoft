import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useActiveChain } from "../signer";
import {
  fetchCollectionStatus,
  fetchProfitData,
  type CollectionStatus,
  type ProfitData,
} from "../lib/collectionData";
import { parseCollectionInput } from "../lib/convert";
import {
  estimateVolumeFromRoyalties,
  formatEthShort,
  formatUsdApprox,
} from "../lib/profit";
import {
  loadProjects,
  removeProject,
  syncLaunchIntoRegistry,
  upsertProject,
  type ProjectEntry,
} from "../lib/projects";
import { buildCumulativeSeries, dedupeByReceiver } from "../lib/series";
import { shortAddress } from "./ConnectBar";
import { CopyButton } from "./Bits";
import { CollectionDetail, ProfitBlock } from "./CollectionDetail";
import MintProfitPanel from "./MintProfitPanel";
import ProfitChart from "./ProfitChart";

const REFRESH_MS = 30_000;

interface Row {
  entry: ProjectEntry;
  status?: CollectionStatus;
  profit?: ProfitData;
  error?: string;
}

type SortKey = "date" | "profit" | "minted" | "volume" | "name";

export default function DashboardTab() {
  const { address } = useAccount();
  const chainInfo = useActiveChain();
  const publicClient = usePublicClient({ chainId: chainInfo?.id });
  const [projects, setProjects] = useState<ProjectEntry[]>(syncLaunchIntoRegistry);
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const [addInput, setAddInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDesc, setSortDesc] = useState(true);
  const [onlyMine, setOnlyMine] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  async function refresh(list: ProjectEntry[]) {
    if (!publicClient || !chainInfo || list.length === 0 || refreshing) return;
    setRefreshing(true);
    try {
      for (const entry of list) {
        const key = entry.address.toLowerCase();
        try {
          const target = entry.address as `0x${string}`;
          const status = await fetchCollectionStatus(publicClient, target, chainInfo);
          const profit = await fetchProfitData(publicClient, target, status, chainInfo);
          setRows((m) => new Map(m).set(key, { entry, status, profit }));
          // Cache display bits so the table paints instantly next visit.
          if (entry.name !== status.name || (profit.createdAt && !entry.createdAt)) {
            upsertProject({
              ...entry,
              name: status.name,
              createdAt: profit.createdAt ?? entry.createdAt,
            });
          }
        } catch (e) {
          setRows((m) =>
            new Map(m).set(key, {
              entry,
              error: e instanceof Error ? e.message.split("\n")[0] : String(e),
            }),
          );
        }
      }
      setUpdatedAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setRows(new Map()); // clear stale rows when the active chain changes
    void refresh(projects);
    timerRef.current = setInterval(() => void refresh(loadProjects()), REFRESH_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, chainInfo?.id]);

  function addProject() {
    const parsed = parseCollectionInput(addInput);
    if (!parsed) {
      setAddError("Paste a contract address, an OpenSea collection/item link, or a Blockscout link");
      return;
    }
    setAddError(null);
    setAddInput("");
    const next = upsertProject({ address: parsed, source: "manual" });
    setProjects(next);
    void refresh(next.filter((p) => p.address.toLowerCase() === parsed.toLowerCase()));
  }

  const rowList = useMemo(() => {
    let list = projects.map(
      (entry) => rows.get(entry.address.toLowerCase()) ?? { entry },
    );
    if (onlyMine && address) {
      list = list.filter(
        (r) => r.status?.owner.toLowerCase() === address.toLowerCase(),
      );
    }
    const dir = sortDesc ? -1n : 1n;
    const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0) * Number(dir);
    list.sort((a, b) => {
      switch (sortKey) {
        case "profit":
          return cmpBig(a.profit?.breakdown.profit ?? 0n, b.profit?.breakdown.profit ?? 0n);
        case "minted":
          return cmpBig(a.status?.totalSupply ?? 0n, b.status?.totalSupply ?? 0n);
        case "volume":
          return cmpBig(volumeOf(a) ?? -1n, volumeOf(b) ?? -1n);
        case "name":
          return (
            (a.status?.name ?? a.entry.name ?? "").localeCompare(
              b.status?.name ?? b.entry.name ?? "",
            ) * Number(dir)
          );
        case "date":
        default:
          return (
            ((a.profit?.createdAt ?? a.entry.createdAt ?? 0) -
              (b.profit?.createdAt ?? b.entry.createdAt ?? 0)) *
            Number(dir)
          );
      }
    });
    return list;
  }, [projects, rows, sortKey, sortDesc, onlyMine, address]);

  // ── Totals + chart series (royalties deduped by receiver so a shared payout
  // wallet isn't counted once per collection) ──────────────────────────────
  const { series, totalProfit, ethUsd } = useMemo(() => {
    const loaded = [...rows.values()].filter((r) => r.status && r.profit);
    const royaltyLists = loaded.map((r) => ({
      receiver: r.status!.royaltyReceiver,
      events: r.profit!.royaltyEvents,
    }));
    const royaltyEvents = dedupeByReceiver(royaltyLists);
    const events = [
      ...loaded.flatMap((r) => r.profit!.mintEvents),
      ...royaltyEvents,
      ...loaded.map((r) => ({
        t: r.profit!.createdAt ?? 0,
        wei: -r.profit!.breakdown.launchCost,
      })),
    ].filter((e) => e.wei !== 0n);
    const series = buildCumulativeSeries(events, Math.floor(Date.now() / 1000));
    const totalProfit = events.reduce((acc, e) => acc + e.wei, 0n);
    const ethUsd = loaded.find((r) => r.profit!.ethUsd !== null)?.profit!.ethUsd ?? null;
    return { series, totalProfit, ethUsd };
  }, [rows]);

  function header(key: SortKey, label: string) {
    return (
      <th
        onClick={() => {
          if (sortKey === key) setSortDesc(!sortDesc);
          else {
            setSortKey(key);
            setSortDesc(true);
          }
        }}
      >
        {label}
        {sortKey === key ? (sortDesc ? " ▼" : " ▲") : ""}
      </th>
    );
  }

  return (
    <div>
      <MintProfitPanel />

      <div className="panel">
        <h2>Total profit — all projects</h2>
        <div
          className={`profit-big ${totalProfit >= 0n ? "profit-pos" : "profit-neg"}`}
        >
          {totalProfit >= 0n ? "▲ +" : "▼ "}
          {formatEthShort(totalProfit)} ETH
          {formatUsdApprox(totalProfit, ethUsd) ? (
            <span className="profit-usd">{formatUsdApprox(totalProfit, ethUsd)}</span>
          ) : null}
        </div>
        <ProfitChart points={series} ethUsd={ethUsd} updatedAt={updatedAt} />
      </div>

      <div className="panel">
        <h2>Projects</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input
            style={{ flex: 1, minWidth: 220 }}
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            placeholder="add by 0x address or OpenSea/Blockscout link"
            onKeyDown={(e) => e.key === "Enter" && addProject()}
          />
          <button className="secondary" onClick={addProject}>
            + add
          </button>
          <button
            className="secondary"
            disabled={refreshing}
            onClick={() => void refresh(projects)}
          >
            {refreshing ? "refreshing…" : "refresh"}
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }} className="dim">
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(e) => setOnlyMine(e.target.checked)}
            />
            only mine
          </label>
        </div>
        {addError ? <p className="error">{addError}</p> : null}
        {projects.length === 0 ? (
          <div className="empty-state">
            NO COLLECTIONS TRACKED —{" "}
            <span className="es-action">ADD ONE BY ADDRESS OR LINK ↑</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="projects">
              <thead>
                <tr>
                  {header("name", "collection")}
                  {header("minted", "minted")}
                  {header("volume", "volume≈")}
                  <th>deployer</th>
                  {header("profit", "profit")}
                  {header("date", "date")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rowList.map((r) => {
                  const key = r.entry.address.toLowerCase();
                  const vol = volumeOf(r);
                  const p = r.profit?.breakdown.profit;
                  const created = r.profit?.createdAt ?? r.entry.createdAt;
                  const isExpanded = expanded === key;
                  return [
                    <tr
                      key={key}
                      className={`project-row ${isExpanded ? "expanded" : ""}`}
                      onClick={() => setExpanded(isExpanded ? null : key)}
                    >
                      <td>
                        <span className="coll-cell">
                          {r.status?.name ?? r.entry.name ?? shortAddress(r.entry.address)}
                          <CopyButton text={r.entry.address} />
                        </span>
                        {r.error ? <div className="error">{r.error}</div> : null}
                      </td>
                      <td>
                        {r.status
                          ? `${r.status.totalSupply} / ${r.status.maxSupply}`
                          : "…"}
                      </td>
                      <td>
                        {vol !== null && vol !== undefined ? (
                          `${formatEthShort(vol)} ETH`
                        ) : (
                          <span className="dim" title="No royalties set — secondary volume can't be derived on-chain">
                            —
                          </span>
                        )}
                      </td>
                      <td>{r.status ? shortAddress(r.status.owner) : "…"}</td>
                      <td className={p !== undefined ? (p >= 0n ? "ok" : "error") : ""}>
                        {p !== undefined ? `${p >= 0n ? "+" : ""}${formatEthShort(p)}` : "…"}
                      </td>
                      <td>
                        {created
                          ? new Date(created * 1000).toLocaleDateString()
                          : "…"}
                      </td>
                      <td>
                        <button
                          className="danger"
                          style={{ padding: "2px 8px", fontSize: 11 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setProjects(removeProject(r.entry.address));
                          }}
                          title="remove from dashboard (nothing on-chain changes)"
                        >
                          ×
                        </button>
                      </td>
                    </tr>,
                    isExpanded && r.status ? (
                      <tr key={`${key}-detail`} className="project-detail">
                        <td colSpan={7}>
                          <CollectionDetail
                            contract={r.entry.address}
                            status={r.status}
                            isOwner={Boolean(
                              address &&
                                r.status.owner.toLowerCase() === address.toLowerCase(),
                            )}
                          />
                          {r.profit ? (
                            <div style={{ marginTop: 12 }}>
                              <ProfitBlock
                                b={r.profit.breakdown}
                                ethUsd={r.profit.ethUsd}
                              />
                            </div>
                          ) : null}
                          <p className="dim" style={{ marginBottom: 0 }}>
                            owner actions (price/supply/enforcement) live in the
                            Status tab — paste this address there.
                          </p>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="dim" style={{ marginBottom: 0, fontSize: 11 }}>
          volume≈ is secondary volume derived from royalty payouts (royalties ÷
          royalty %); it needs royalties &gt; 0 to be computable on-chain.
          Totals dedupe royalty payouts when collections share a receiver
          wallet. Auto-refreshes every {REFRESH_MS / 1000}s.
        </p>
      </div>
    </div>
  );
}

function volumeOf(r: Row): bigint | null | undefined {
  if (!r.status || !r.profit) return undefined;
  return estimateVolumeFromRoyalties(r.profit.breakdown.royalties, r.status.royaltyBps);
}
