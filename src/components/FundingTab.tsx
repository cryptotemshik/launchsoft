import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import {
  openSeaCollectionUrlBySlug,
  openSeaItemUrlBySlug,
  openSeaProfileUrl,
} from "../chains";
import StaleServer from "./StaleServer";
import { AddrLink, TxLink } from "./Bits";
import WalletPicker from "./WalletPicker";

/**
 * Move ETH across the server's wallet set: fan it out before a mint, sweep it
 * back after.
 *
 * Both run on the server, so a hundred transfers are signed together and fired
 * at the sequencer at once — roughly one round-trip, not a hundred. Keys never
 * come here; the only key this page can send is the optional one-off payer,
 * which the server uses for that call and never stores.
 */

interface TransferOutcome {
  address: string;
  txHash?: string;
  amountWei?: string;
  status: "sent" | "rejected" | "skipped";
  detail?: string;
}

interface ServerWallet {
  address: `0x${string}`;
  label?: string;
  balance: string | null;
}

interface WalletsView {
  chain?: string;
  wallets: ServerWallet[];
}

interface DisperseResult {
  from: string;
  fromBalanceWei: string;
  requiredWei: string;
  funded: number;
  skipped: number;
  outcomes: TransferOutcome[];
}

interface CollectResult {
  to: string;
  swept: number;
  skipped: number;
  totalWei: string;
  outcomes: TransferOutcome[];
}

interface Holding {
  wallet: string;
  collection: string;
  collectionName?: string;
  tokenIds: string[];
}

interface NftsView {
  chain?: string;
  totalTokens: number;
  holdings: Holding[];
  openSeaSlug?: string;
  checked?: number;
  withTokens?: number;
  tookMs?: number;
}

interface NftOutcome {
  wallet: string;
  collection: string;
  tokenId: string;
  txHash?: string;
  status: "sent" | "rejected";
  detail?: string;
}

interface SweepNftsResult {
  to: string;
  moved: number;
  total: number;
  outcomes: NftOutcome[];
}

const eth = (wei?: string) => (wei ? Number(wei) / 1e18 : 0);

export default function FundingTab() {
  const { url, setUrl, token, setToken, remember, setRemember, base, call, save, serverVersion } =
    useRunnerApi();

  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<WalletsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Disperse
  const [payerMode, setPayerMode] = useState<"stored" | "key">("key");
  const [payerAddress, setPayerAddress] = useState("");
  const [payerKey, setPayerKey] = useState("");
  const [amount, setAmount] = useState("0.001");
  const [skipFunded, setSkipFunded] = useState(true);
  const [dResult, setDResult] = useState<DisperseResult | null>(null);

  // Collect
  const [dest, setDest] = useState("");
  const [cResult, setCResult] = useState<CollectResult | null>(null);

  // NFTs
  const [nfts, setNfts] = useState<NftsView | null>(null);
  const [nftDest, setNftDest] = useState("");
  /**
   * Which wallets the sweep gathers from. Empty until the wallet list lands,
   * then all of them — the common case — and narrowed from there.
   */
  const [nftFrom, setNftFrom] = useState<Set<string>>(new Set());
  const [nftFilter, setNftFilter] = useState("");
  const [nResult, setNResult] = useState<SweepNftsResult | null>(null);
  // How the scan results are shown. Kept apart from the scan itself so
  // re-sorting or narrowing to one collection never costs another chain read.
  const [nftSort, setNftSort] = useState<"tokens" | "wallet" | "collection">("tokens");
  const [nftSortDesc, setNftSortDesc] = useState(true);
  const [onlyCollection, setOnlyCollection] = useState<string | null>(null);
  const [nftError, setNftError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const v = (await call("/api/wallets")) as unknown as WalletsView;
      setView((prev) => {
        // First sight of the wallet set selects all of it, which is what a
        // sweep almost always wants. After that, only drop what the server no
        // longer has, so a refresh mid-selection doesn't undo the picking.
        const live = new Set<string>(v.wallets.map((w) => w.address));
        setNftFrom((chosen) =>
          prev === null ? live : new Set([...chosen].filter((a) => live.has(a))),
        );
        return v;
      });
      setConnected(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call]);

  useEffect(() => {
    if (base && token) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      save();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runDisperse(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setDResult(null);
    try {
      const body: Record<string, unknown> = {
        amountEth: amount.trim(),
        dryRun,
        ...(skipFunded ? { skipIfAtLeastEth: amount.trim() } : {}),
      };
      if (payerMode === "key") body.fromKey = payerKey.trim();
      else body.fromAddress = payerAddress;

      const r = (await call("/api/disperse", {
        method: "POST",
        body: JSON.stringify(body),
      })) as unknown as DisperseResult;
      setDResult(r);
      if (!dryRun) {
        // It was a private key; don't leave it on screen.
        setPayerKey("");
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runCollect(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setCResult(null);
    try {
      const r = (await call("/api/collect", {
        method: "POST",
        body: JSON.stringify({ to: dest.trim(), dryRun }),
      })) as unknown as CollectResult;
      setCResult(r);
      if (!dryRun) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function scanNfts() {
    setBusy(true);
    setNftError(null);
    setNfts(null);
    try {
      const q = nftFilter.trim() ? `?collection=${encodeURIComponent(nftFilter.trim())}` : "";
      setNfts((await call(`/api/nfts${q}`)) as unknown as NftsView);
    } catch (e) {
      setNftError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runNftSweep(dryRun: boolean) {
    setBusy(true);
    setNftError(null);
    setNResult(null);
    try {
      const r = (await call("/api/sweep-nfts", {
        method: "POST",
        body: JSON.stringify({
          to: nftDest.trim(),
          collection: nftFilter.trim() || undefined,
          // Only pin the sources when it is a strict subset; sending the whole
          // list would freeze the sweep against wallets added later.
          ...(nftFrom.size < (view?.wallets.length ?? 0) ? { from: [...nftFrom] } : {}),
          dryRun,
        }),
      })) as unknown as SweepNftsResult;
      setNResult(r);
      if (!dryRun) await scanNfts();
    } catch (e) {
      setNftError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const wallets = view?.wallets ?? [];

  /**
   * The wallets a sweep could gather from, each showing how many tokens it is
   * actually holding.
   *
   * The count is the whole reason to annotate them: picking sources blind
   * means ticking wallets that hold nothing, which costs a scan and moves
   * nothing. It comes from the last scan, so it reads "—" until one is run.
   */
  const sweepSources = useMemo(() => {
    const held = new Map<string, number>();
    for (const h of nfts?.holdings ?? []) {
      const k = h.wallet.toLowerCase();
      held.set(k, (held.get(k) ?? 0) + h.tokenIds.length);
    }
    return wallets.map((w) => {
      const n = held.get(w.address.toLowerCase()) ?? 0;
      return { ...w, note: nfts ? (n > 0 ? `${n} NFT` : "") : undefined };
    });
  }, [wallets, nfts]);
  const total = wallets.reduce((n, w) => n + Number(w.balance ?? 0), 0);
  const empty = wallets.filter((w) => Number(w.balance ?? 0) === 0).length;

  /**
   * What the scan table shows: the same holdings, narrowed and ordered.
   *
   * Derived rather than stored, so choosing a collection or a sort order is
   * instant — the chain has already been read and nothing here goes back to it.
   */
  const nftRows = (() => {
    const rows = (nfts?.holdings ?? []).filter(
      (h) => !onlyCollection || h.collection.toLowerCase() === onlyCollection,
    );
    const dir = nftSortDesc ? -1 : 1;
    return [...rows].sort((a, b) => {
      if (nftSort === "wallet") return dir * a.wallet.localeCompare(b.wallet);
      if (nftSort === "collection") {
        const an = a.collectionName ?? a.collection;
        const bn = b.collectionName ?? b.collection;
        // Same collection, so order by holding size — the useful tiebreak.
        return dir * (an.localeCompare(bn) || a.tokenIds.length - b.tokenIds.length);
      }
      return dir * (a.tokenIds.length - b.tokenIds.length);
    });
  })();

  /** Collections found by the scan, largest first, for the filter chips. */
  const nftCollections = (() => {
    const by = new Map<string, { address: string; name?: string; tokens: number }>();
    for (const h of nfts?.holdings ?? []) {
      const key = h.collection.toLowerCase();
      const e = by.get(key) ?? { address: h.collection, name: h.collectionName, tokens: 0 };
      e.tokens += h.tokenIds.length;
      by.set(key, e);
    }
    return [...by.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.tokens - a.tokens);
  })();

  const shownTokens = nftRows.reduce((n, h) => n + h.tokenIds.length, 0);
  const shownWallets = new Set(nftRows.map((h) => h.wallet.toLowerCase())).size;

  function nftHeader(key: typeof nftSort, label: string) {
    return (
      <th
        className="sortable"
        onClick={() => {
          if (nftSort === key) setNftSortDesc(!nftSortDesc);
          else {
            setNftSort(key);
            setNftSortDesc(true);
          }
        }}
      >
        {label}
        {nftSort === key ? (nftSortDesc ? " ▼" : " ▲") : ""}
      </th>
    );
  }

  return (
    <div>
      <div className="panel">
        <h2>Funding</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Top the wallet set up before a mint, and sweep it back afterwards.
          Everything runs on the server: a hundred transfers are signed together
          and fired at the sequencer at once, so it takes about one round-trip
          rather than a hundred of them.
        </p>
        <p className="hint dim" style={{ marginBottom: 0 }}>
          For a free mint on this chain the real cost is the gas <i>reservation</i>,
          not the fee: a node checks the wallet holds{" "}
          <code>gas limit × max fee</code> before it will even accept the
          transaction, while the fee actually paid is a few millionths of an ETH.
          With the default 500,000 limit at 2 gwei that reservation is 0.001 ETH,
          so <b>0.002 ETH per wallet</b> is a comfortable float. Add the mint
          price on top for a paid drop. The limit is a ceiling, not a charge —
          raising it costs nothing but the float, and buys headroom on a
          contract whose mint is heavier than usual.
        </p>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 2, minWidth: 240 }}>
            <label>server URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label>token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="SNIPE_TOKEN"
              autoComplete="off"
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <button className="secondary" onClick={() => void connect()} disabled={busy || !base || !token}>
            {busy ? <span className="spin">BUSY</span> : connected ? "refresh" : "connect"}
          </button>
          <label className="dim" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            remember token in this browser
          </label>
          {connected ? (
            <span className="pill ok">
              {wallets.length} wallets · {total.toFixed(4)} ETH total
              {empty ? ` · ${empty} empty` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />
      </div>

      {!connected ? (
        <div className="panel panel-locked">
          <h2>Not connected</h2>
          <p className="warn" style={{ marginTop: 0, marginBottom: 0 }}>
            Connect to your server above to send ETH out to the wallet set,
            sweep it back, and gather minted NFTs onto one wallet.
          </p>
        </div>
      ) : (
        <>
          <div className="panel">
            <h2>Send out — one wallet → all {wallets.length}</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              Where the money comes from: the server has to sign one transaction
              per wallet, so it needs a key it can sign with — a browser wallet
              would ask you to approve {wallets.length || "N"} times.
              The simplest route is to send one ordinary transfer from
              MetaMask into any wallet already on the server, then pick that one
              below as the payer. Pasting a payer key works too and is never
              stored.
            </p>
            <div className="mode-toggle" style={{ marginBottom: 12 }}>
              <button className={payerMode === "key" ? "active" : ""} onClick={() => setPayerMode("key")}>
                paste a payer key
              </button>
              <button className={payerMode === "stored" ? "active" : ""} onClick={() => setPayerMode("stored")}>
                use a stored wallet
              </button>
            </div>

            {payerMode === "key" ? (
              <div className="field">
                <label>payer private key — used for this transfer, never stored</label>
                <input
                  type="password"
                  value={payerKey}
                  onChange={(e) => setPayerKey(e.target.value)}
                  placeholder="0x… (64 hex chars)"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="field">
                <label>payer — one of the wallets already on the server</label>
                <select value={payerAddress} onChange={(e) => setPayerAddress(e.target.value)}>
                  <option value="">select a wallet…</option>
                  {wallets.map((w) => (
                    <option key={w.address} value={w.address}>
                      {w.address.slice(0, 10)}…{w.address.slice(-4)} — {Number(w.balance ?? 0).toFixed(4)} ETH
                      {w.label ? ` (${w.label})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginTop: 10 }}>
              <div className="field" style={{ width: 190 }}>
                <label>amount per wallet (ETH)</label>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.001" />
              </div>
              <label className="dim" style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 10 }}>
                <input type="checkbox" checked={skipFunded} onChange={(e) => setSkipFunded(e.target.checked)} />
                skip wallets that already hold this much
              </label>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button className="secondary" disabled={busy} onClick={() => void runDisperse(true)}>
                DRY RUN
              </button>
              <button
                className="primary"
                disabled={busy || (payerMode === "key" ? !payerKey.trim() : !payerAddress)}
                onClick={() => void runDisperse(false)}
              >
                SEND TO ALL WALLETS
              </button>
            </div>

            {dResult ? (
              <>
                <dl className="kv" style={{ marginTop: 14 }}>
                  <dt>payer</dt>
                  <dd>
                    <AddrLink address={dResult.from} /> — {eth(dResult.fromBalanceWei).toFixed(4)} ETH
                  </dd>
                  <dt>needs</dt>
                  <dd>{eth(dResult.requiredWei).toFixed(5)} ETH incl. gas</dd>
                  <dt>result</dt>
                  <dd>
                    <span className="ok">{dResult.funded} sent</span>
                    {dResult.skipped ? <span className="dim"> · {dResult.skipped} already funded</span> : null}
                  </dd>
                </dl>
                <OutcomeList outcomes={dResult.outcomes} />
              </>
            ) : null}
          </div>

          <div className="panel">
            <h2>Collect back — all {wallets.length} → one address</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              Every wallet with a balance sends what it holds, minus the gas it
              must reserve. Empty and dust wallets are skipped automatically —
              nothing to type but the destination.
            </p>
            <div className="field">
              <label>destination address</label>
              <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="0x…" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button className="secondary" disabled={busy || !dest.trim()} onClick={() => void runCollect(true)}>
                DRY RUN
              </button>
              <button className="primary" disabled={busy || !dest.trim()} onClick={() => void runCollect(false)}>
                COLLECT EVERYTHING
              </button>
            </div>

            {cResult ? (
              <>
                <dl className="kv" style={{ marginTop: 14 }}>
                  <dt>to</dt>
                  <dd>
                    <AddrLink address={cResult.to} />
                  </dd>
                  <dt>result</dt>
                  <dd>
                    <span className="ok">
                      {cResult.swept} swept · {eth(cResult.totalWei).toFixed(5)} ETH
                    </span>
                    {cResult.skipped ? <span className="dim"> · {cResult.skipped} skipped</span> : null}
                  </dd>
                </dl>
                <OutcomeList outcomes={cResult.outcomes} />
              </>
            ) : null}
          </div>

          <div className="panel">
            <h2>Collect NFTs — all wallets → one wallet</h2>
            <p className="dim" style={{ marginTop: 0 }}>
              After a multi-wallet mint the tokens sit across every wallet, and
              listing them means signing into every wallet. This moves them onto
              one address so you can sell from a single place. Transfers are
              signed together and fired at once, same as everything else here.
            </p>

            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <label>only this collection (optional — blank means every NFT held)</label>
                <input
                  value={nftFilter}
                  onChange={(e) => setNftFilter(e.target.value)}
                  placeholder="0x… collection address"
                />
              </div>
              <button className="secondary" disabled={busy} onClick={() => void scanNfts()}>
                {busy ? <span className="spin">SCANNING</span> : "SCAN WALLETS"}
              </button>
            </div>

            {nftError ? <p className="error">{nftError}</p> : null}

            {nfts ? (
              nfts.totalTokens === 0 ? (
                <p className="dim" style={{ marginTop: 12, marginBottom: 0 }}>
                  No NFTs found on the server&apos;s wallets
                  {nftFilter.trim() ? " for that collection" : ""}.
                </p>
              ) : (
                <>
                  <p className="ok" style={{ marginTop: 12 }}>
                    {shownTokens} token{shownTokens === 1 ? "" : "s"} on{" "}
                    {shownWallets} of {nfts.checked ?? "?"} wallets
                    {onlyCollection ? " (filtered)" : ""}
                    {nfts.tookMs ? ` · ${(nfts.tookMs / 1000).toFixed(1)}s` : ""}
                  </p>

                  {nftCollections.length > 1 ? (
                    <div className="wallet-picker-chips">
                      <button
                        className={onlyCollection === null ? "secondary active-chip" : "secondary"}
                        onClick={() => setOnlyCollection(null)}
                      >
                        all ({nfts.totalTokens})
                      </button>
                      {nftCollections.map((c) => (
                        <button
                          key={c.key}
                          className={onlyCollection === c.key ? "secondary active-chip" : "secondary"}
                          onClick={() => setOnlyCollection(onlyCollection === c.key ? null : c.key)}
                          title={c.address}
                        >
                          {c.name ?? `${c.address.slice(0, 8)}…`} ({c.tokens})
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="table-wrap">
                    <table className="projects">
                      <thead>
                        <tr>
                          {nftHeader("wallet", "wallet")}
                          {nftHeader("collection", "collection")}
                          {nftHeader("tokens", "tokens")}
                        </tr>
                      </thead>
                      <tbody>
                        {nftRows.map((h) => (
                          <tr key={h.wallet + h.collection}>
                            <td>
                              <a
                                href={openSeaProfileUrl(h.wallet)}
                                target="_blank"
                                rel="noreferrer"
                                title={h.wallet}
                              >
                                {h.wallet.slice(0, 10)}…{h.wallet.slice(-4)}
                              </a>
                            </td>
                            <td>
                              <a
                                href={openSeaCollectionUrlBySlug(nfts.openSeaSlug, h.collection)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {h.collectionName ?? `${h.collection.slice(0, 10)}…`}
                              </a>
                            </td>
                            <td>
                              <b>{h.tokenIds.length}</b>{" "}
                              <span className="token-ids">
                                {h.tokenIds.map((id) => (
                                  <a
                                    key={id}
                                    href={openSeaItemUrlBySlug(nfts.openSeaSlug, h.collection, id)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    #{id}
                                  </a>
                                ))}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            ) : null}

            {/* Which wallets to gather from. Sweeping the lot onto one address
                is the common case and stays the default, but splitting a set
                across two destinations is a real thing to want, and doing it
                by sweeping everything and sending half back costs an extra
                round of gas. */}
            <WalletPicker
              title="gather from"
              wallets={sweepSources}
              chosen={nftFrom}
              setChosen={setNftFrom}
            />

            <div className="field" style={{ marginTop: 12 }}>
              <label>send every token to</label>
              <input value={nftDest} onChange={(e) => setNftDest(e.target.value)} placeholder="0x…" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button
                className="secondary"
                disabled={busy || !nftDest.trim() || nftFrom.size === 0}
                onClick={() => void runNftSweep(true)}
              >
                DRY RUN
              </button>
              <button
                className="primary"
                disabled={busy || !nftDest.trim() || nftFrom.size === 0}
                onClick={() => void runNftSweep(false)}
              >
                {nftFrom.size === (view?.wallets.length ?? 0)
                  ? "MOVE ALL NFTs"
                  : `MOVE FROM ${nftFrom.size} WALLET(S)`}
              </button>
            </div>
            {nftFrom.size === 0 ? (
              <p className="warn" style={{ marginBottom: 0 }}>
                No source wallets ticked — there is nothing to gather from.
              </p>
            ) : null}

            {nResult ? (
              <>
                <dl className="kv" style={{ marginTop: 14 }}>
                  <dt>to</dt>
                  <dd>
                    <AddrLink address={nResult.to} />
                  </dd>
                  <dt>result</dt>
                  <dd>
                    <span className={nResult.moved > 0 ? "ok" : "warn"}>
                      {nResult.moved}/{nResult.total} moved
                    </span>
                  </dd>
                </dl>
                <NftOutcomeList outcomes={nResult.outcomes} />
              </>
            ) : null}

            <p className="hint dim" style={{ marginBottom: 0 }}>
              To have this happen by itself after every mint, set{" "}
              <code>consolidateTo</code> in the server&apos;s{" "}
              <code>snipe.config.json</code> (or the <code>CONSOLIDATE_TO</code>{" "}
              env var) to the destination address. The automatic sweep uses the
              token ids from the mint receipt, so it moves exactly what was just
              minted and nothing else.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function NftOutcomeList({ outcomes }: { outcomes: NftOutcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table className="projects">
        <thead>
          <tr>
            <th>wallet</th>
            <th>token</th>
            <th>status</th>
            <th>tx</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.slice(0, 100).map((o) => (
            <tr key={o.wallet + o.collection + o.tokenId}>
              <td className="dim">
                {o.wallet.slice(0, 10)}…{o.wallet.slice(-4)}
              </td>
              <td>#{o.tokenId}</td>
              <td>
                <span className={o.status === "sent" ? "ok" : "error"}>{o.status}</span>
                {o.detail ? <span className="dim"> — {o.detail}</span> : null}
              </td>
              <td>{o.txHash ? <TxLink hash={o.txHash} label="tx" /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutcomeList({ outcomes }: { outcomes: TransferOutcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table className="projects">
        <thead>
          <tr>
            <th>wallet</th>
            <th>amount</th>
            <th>status</th>
            <th>tx</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.address + (o.txHash ?? o.status)}>
              <td className="dim">
                {o.address.slice(0, 10)}…{o.address.slice(-4)}
              </td>
              <td>{o.amountWei ? `${eth(o.amountWei).toFixed(5)} ETH` : "—"}</td>
              <td>
                <span className={o.status === "sent" ? "ok" : o.status === "skipped" ? "dim" : "error"}>
                  {o.status}
                </span>
                {o.detail ? <span className="dim"> — {o.detail}</span> : null}
              </td>
              <td>{o.txHash ? <TxLink hash={o.txHash} label="tx" /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
