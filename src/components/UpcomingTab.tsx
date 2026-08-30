/**
 * Drops that haven't happened yet.
 *
 * They get spotted on a phone, scrolling Twitter, hours before there is an
 * OpenSea page or a contract to paste anywhere — which is why the bot exists
 * and why `/add` there takes the four things worth knowing.
 *
 * The same four can be typed here, because the phone is not always where you
 * are. Both routes end in the same `buildUpcoming`, so a name the bot accepts
 * cannot be one this form rejects.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { createTabStore } from "../lib/tabStore";
import { notifyWatchlistChanged, onWatchlistChanged } from "../lib/watchlistSignal";
import { ColorPicker, NoteBox } from "./DropNote";
import { isPickable, type Pickable } from "../lib/calendarColor";
import type { UpcomingMint } from "../lib/upcoming";
import type { ScannedDrop } from "../lib/dropScan";
import { larpReport, type LarpReport } from "../lib/larp";
import type { CollectionInfo } from "../lib/collectionInfo";
import type { IndexedCollection } from "../lib/creatorIndex";
import DropTable, { isReal, type SortKey } from "./DropTable";
import SnipeButton from "./SnipeButton";
import { seedWatched } from "../lib/watchedStore";
import { openSeaCollectionUrlBySlug } from "../chains";
import StaleServer from "./StaleServer";


/** A start time in the format the date parser reads back. */
function whenInput(at: number): string {
  const d = new Date(at * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A stand-in address for an entry with no contract yet.
 *
 * The table keys on the contract, and the whole point of this list is drops
 * that do not have one. Derived from the entry's own id so rows stay distinct,
 * and shaped so `isReal` rejects it everywhere it would matter — nothing links
 * to it, nothing offers to snipe it.
 */
function placeholderFor(id: string): `0x${string}` {
  // Deliberately not hex. An id like "m2" mapped onto hex digits produced
  // 0x0200…00, which passes for an address — and the row then offered to
  // snipe a contract that does not exist. The "wl:" marker cannot.
  return `0xwl:${id}` as `0x${string}`;
}

/**
 * The watchlist, kept where leaving the tab cannot throw it away.
 *
 * At module scope on purpose: the app renders one tab at a time, so the
 * component is unmounted the moment you look at anything else, and this list
 * costs three requests to rebuild. See src/lib/tabStore.ts.
 */
interface UpcomingData {
  /** Null until the first read, so "empty" and "not read yet" stay apart. */
  list: UpcomingMint[] | null;
  drops: Record<string, ScannedDrop>;
  info: Record<string, CollectionInfo>;
  related: { owners?: Record<string, IndexedCollection[]> };
  twitterRelated: Record<string, IndexedCollection[]>;
  slug?: string;
}

const store = createTabStore<UpcomingData>(
  { list: null, drops: {}, info: {}, related: {}, twitterRelated: {} },
  {
    describeError: (m) =>
      /404/.test(m)
        ? "This server is too old to keep upcoming mints — update it from the Snipe tab."
        : m,
  },
);

/**
 * The other view of this list has written to it — drop what is held.
 *
 * A store with a fetcher reads again at once, so a colour picked in one tab is
 * the colour in the other before you get there. One belonging to a tab nobody
 * has opened yet simply counts as stale.
 */
onWatchlistChanged((source) => {
  if (source === store) return;
  store.invalidate();
  void store.run();
});

export default function UpcomingTab() {
  const { url, setUrl, token, setToken, base, call, save, serverVersion } = useRunnerApi();
  const held = useSyncExternalStore(store.subscribe, store.getState);
  const { list, drops, info, related, twitterRelated, slug } = held.data;
  const { error, busy } = held;
  const [sort, setSort] = useState<SortKey>("start");
  const [desc, setDesc] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", twitter: "", contract: "", supply: "", when: "" });
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<string | null>(null);

  /**
   * The list, then the public stage and the marketplace lookup for everything
   * on it. Throws rather than catching: the store turns that into the line of
   * red text and keeps the rows already on screen.
   */
  const load = useCallback(async () => {
    {
      save();
      const r = (await call("/api/upcoming")) as unknown as {
        upcoming?: UpcomingMint[];
        openSeaSlug?: string;
      };
      // Every "watch" button on every tab reads this, so it knows what is
      // already listed without asking again.
      seedWatched(r.upcoming ?? []);
      const entries = Array.isArray(r.upcoming) ? r.upcoming : [];
      store.set({ list: entries, slug: r.openSeaSlug });

      /**
       * The public stage of everything that has a contract.
       *
       * This is the same table the scanner shows, and that table is about the
       * public drop — not whatever mint happens to have run on the contract.
       * One batch read for the stages, then the marketplace lookup the scanner
       * already uses for handles and floors.
       */
      const withContract = entries.map((m) => m.contract).filter((c): c is string => Boolean(c));
      if (withContract.length > 0) {
        const list = withContract.join(",");
        const [d, meta] = await Promise.all([
          call(`/api/drops?contracts=${list}`) as Promise<Record<string, unknown>>,
          call(`/api/collection-info?contracts=${list}`) as Promise<Record<string, unknown>>,
        ]);
        store.set({
          drops: Object.fromEntries(
            ((d.drops as ScannedDrop[]) ?? []).map((x) => [x.contract.toLowerCase(), x]),
          ),
          related: (d.related as { owners?: Record<string, IndexedCollection[]> }) ?? {},
          info: (meta.known as Record<string, CollectionInfo>) ?? {},
          twitterRelated: (meta.twitters as Record<string, IndexedCollection[]>) ?? {},
        });
      }
      setNow(Math.floor(Date.now() / 1000));
    }
  }, [call, save]);

  useEffect(() => {
    store.setFetcher(base && token ? load : null);
  }, [load, base, token]);

  /**
   * Fill the form in from the chain once a contract is typed.
   *
   * Everything else on the form is readable from the address — the name and
   * supply from the contract, the start from its public stage, the handle from
   * the marketplace — so asking for them again is asking someone to copy what
   * the machine could fetch. Only blank fields are filled: what you have
   * already typed is what you meant, and an autofill that overwrites it is
   * worse than none.
   */
  useEffect(() => {
    const c = draft.contract.trim();
    if (!adding || !base || !token || !/^0x[0-9a-fA-F]{40}$/.test(c)) {
      setFound(null);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      setLooking(true);
      try {
        const r = (await call(`/api/collection-preview?contract=${c}`)) as unknown as {
          name?: string;
          maxSupply?: string;
          startTime?: number;
          twitter?: string | null;
          onChain?: boolean;
        };
        if (!alive) return;
        setDraft((d) => ({
          ...d,
          name: d.name.trim() || r.name || d.name,
          twitter: d.twitter.trim() || r.twitter || d.twitter,
          supply: d.supply.trim() || (r.maxSupply && r.maxSupply !== "0" ? r.maxSupply : d.supply),
          when: d.when.trim() || (r.startTime ? whenInput(r.startTime) : d.when),
        }));
        setFound(
          r.onChain
            ? `read ${r.name ?? "the collection"}${r.twitter ? ` · @${r.twitter}` : " · no account connected"}`
            : "nothing configured on-chain for that address yet — fill the rest in by hand",
        );
      } catch {
        if (alive) setFound(null);
      } finally {
        if (alive) setLooking(false);
      }
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Only the address drives this: re-running it as the other fields are
    // typed would fight whoever is typing them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.contract, adding, base, token, call]);

  const add = useCallback(async () => {
    setAddBusy(true);
    setAddError(null);
    try {
      const r = (await call("/api/upcoming", {
        method: "POST",
        body: JSON.stringify(draft),
      })) as unknown as { upcoming?: UpcomingMint[] };
      store.set({ list: Array.isArray(r.upcoming) ? r.upcoming : [] });
      notifyWatchlistChanged(store);
      setDraft({ name: "", twitter: "", contract: "", supply: "", when: "" });
      setAdding(false);
      // The row is on the list but has no stage or handle behind it yet, and
      // the tab no longer re-reads itself on every visit. So it is read now.
      void store.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAddError(
        /404/.test(msg) ? "This server is too old to add from here — update it first." : msg,
      );
    } finally {
      setAddBusy(false);
    }
  }, [call, draft]);

  /**
   * Opening the tab draws what is held and reads again only if it has aged,
   * underneath the rows rather than instead of them.
   */
  useEffect(() => {
    if (base && token && store.isStale()) void store.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Watchlist entries as table rows.
   *
   * A row that has a contract is whatever the chain says about its public
   * stage, with the entry's own name kept — you wrote it, and the contract's
   * lower-case version is not an improvement. A row that has no contract is
   * still a row: it carries a placeholder address so the table can key on it,
   * and everything unknowable about it reads as unknown.
   */
  const rows = useMemo((): ScannedDrop[] => {
    return (list ?? []).map((m) => {
      const onChain = m.contract ? drops[m.contract.toLowerCase()] : undefined;
      if (onChain) return { ...onChain, name: m.name || onChain.name };
      return {
        contract: (m.contract as `0x${string}`) ?? placeholderFor(m.id),
        name: m.name,
        priceWei: "0",
        startTime: m.at ?? 0,
        endTime: 0,
        maxPerWallet: 0,
        feeBps: 0,
        block: 0,
        maxSupply: m.supply,
      };
    });
  }, [list, drops]);

  const reports = useMemo(() => {
    const out: Record<string, LarpReport> = {};
    const t = Math.floor(Date.now() / 1000);
    for (const d of rows) {
      // A drop with no contract has no public stage, so there is nothing to
      // grade — and grading it on the zeros standing in for one would invent
      // a number.
      if (!isReal(d.contract)) continue;
      const key = d.contract.toLowerCase();
      const m = info[key];
      out[key] = larpReport({
        priceWei: d.priceWei,
        maxPerWallet: d.maxPerWallet,
        feeBps: d.feeBps,
        maxSupply: d.maxSupply,
        minted: d.minted,
        twitter: m ? m.twitter : undefined,
        followers: m?.followers,
        joinedMs: m?.joinedMs,
        floorUnit: m ? (m.floor?.unit ?? null) : undefined,
        floorSymbol: m?.floor?.symbol ?? null,
        floorUsd: m?.floor?.usd ?? null,
        baseURI: d.baseURI,
        provenanceHash: d.provenanceHash,
        now: t,
      });
    }
    return out;
  }, [rows, info]);

  /** Back from a row to the entry it came from, so remove knows what to drop. */
  const entryFor = useCallback(
    (contract: string) =>
      (list ?? []).find(
        (m) =>
          m.contract?.toLowerCase() === contract.toLowerCase() ||
          placeholderFor(m.id) === contract,
      ),
    [list],
  );

  const dated = (list ?? []).filter((m) => m.at !== undefined).length;
  const undated = (list ?? []).length - dated;

  const ownerCounts = useMemo(() => {
    const by = new Map<string, number>();
    for (const [owner, l] of Object.entries(related.owners ?? {})) by.set(owner, l.length);
    return by;
  }, [related]);

  // The countdown column would otherwise go stale while the tab sits open.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * Write what a person thinks about a row: its colour, or its note.
   *
   * Optimistic — the swatch moves and the note appears at once, and the write
   * follows. Waiting for a round trip to watch a colour change would make the
   * picker feel broken; a failed write shows up as red text and the next read
   * puts the row back.
   */
  const annotate = useCallback(
    async (m: UpcomingMint, patch: { color?: Pickable; note?: string }) => {
      const applied: Partial<UpcomingMint> = {};
      if (patch.color !== undefined) {
        applied.color = patch.color === "auto" ? undefined : patch.color;
      }
      if (patch.note !== undefined) applied.note = patch.note || undefined;
      store.set({
        list: (store.getState().data.list ?? []).map((x) =>
          x.id === m.id ? { ...x, ...applied } : x,
        ),
      });
      try {
        await call(`/api/upcoming?id=${encodeURIComponent(m.id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        notifyWatchlistChanged(store);
      } catch (e) {
        store.setError(e instanceof Error ? e.message : String(e));
        void store.run();
      }
    },
    [call],
  );

  async function remove(m: UpcomingMint) {
    if (!confirm(`Remove ${m.name} from the list?`)) return;
    try {
      const r = (await call(`/api/upcoming?id=${encodeURIComponent(m.id)}`, {
        method: "DELETE",
      })) as unknown as { upcoming?: UpcomingMint[] };
      if (Array.isArray(r.upcoming)) store.set({ list: r.upcoming });
      notifyWatchlistChanged(store);
    } catch (e) {
      store.setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>Watchlist — drops to come back to</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Drops worth coming back to. Some are only an account and a rumour,
          with no contract to paste anywhere yet; others came from the scanner
          or the feed and already have one, and those carry a <b>snipe</b>{" "}
          button straight through. Add them from the phone through the Telegram
          bot, from the rows in Scanner and Live, or by hand here.
        </p>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 2, minWidth: 200 }}>
            <label>server URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-tunnel.trycloudflare.com"
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
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
        {adding ? (
          <form
            className="add-upcoming"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="filter-grid">
              <div className="field" style={{ gridColumn: "span 2" }}>
                <label>name</label>
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Pipe Dogs"
                />
              </div>
              <div className="field" style={{ gridColumn: "span 2" }}>
                <label>twitter</label>
                <input
                  value={draft.twitter}
                  onChange={(e) => setDraft({ ...draft, twitter: e.target.value })}
                  placeholder="@pipedogsnft or a link"
                />
              </div>
              <div className="field" style={{ gridColumn: "span 2" }}>
                <label>contract</label>
                <input
                  value={draft.contract}
                  onChange={(e) => setDraft({ ...draft, contract: e.target.value })}
                  placeholder="0x… — the rest fills itself in"
                />
              </div>
              <div className="field">
                <label>supply</label>
                <input
                  inputMode="numeric"
                  value={draft.supply}
                  onChange={(e) => setDraft({ ...draft, supply: e.target.value })}
                  placeholder="not announced"
                />
              </div>
              <div className="field">
                <label>when</label>
                <input
                  value={draft.when}
                  onChange={(e) => setDraft({ ...draft, when: e.target.value })}
                  placeholder="01.09 18:00, or blank"
                />
              </div>
            </div>
            {looking ? (
              <p className="dim" style={{ margin: "6px 0 0" }}>
                <span className="spin">reading the contract</span>
              </p>
            ) : found ? (
              <p className="ok" style={{ margin: "6px 0 0", fontSize: 12 }}>
                {found}
              </p>
            ) : null}
            {addError ? <p className="error">{addError}</p> : null}
            <p className="dim hint" style={{ margin: "6px 0 0" }}>
              The name, plus a Twitter or a contract — either is enough to find
              it again, and typing a contract fills the rest in from the chain.
              A blank date means
              &ldquo;not announced&rdquo; — the same as answering TBA in the bot
              — and dates are read the way you would type them: <code>1.9</code>,{" "}
              <code>01.09.2026</code>, either with <code>18:00</code> after it.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button type="submit" disabled={addBusy || !base || !token}>
                {addBusy ? <span className="spin">ADDING</span> : "add to watchlist"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAdding(false);
                  setAddError(null);
                }}
              >
                cancel
              </button>
            </div>
          </form>
        ) : null}

        <div
          style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}
        >
          {!adding ? (
            <button
              className="secondary"
              onClick={() => setAdding(true)}
              disabled={!base || !token}
            >
              + add a drop
            </button>
          ) : null}
          <button
            className="secondary"
            onClick={() => void store.run()}
            disabled={busy || !base || !token}
          >
            {busy ? <span className="spin">BUSY</span> : list ? "refresh" : "load"}
          </button>
          {list ? (
            <span className="pill ok">
              {dated} scheduled
              {undated ? ` · ${undated} undated` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <StaleServer version={serverVersion} />

        {list && list.length > 0 ? (
          <DropTable
            rows={rows}
            info={info}
            reports={reports}
            ownerCounts={ownerCounts}
            related={related}
            twitterRelated={twitterRelated}
            openSeaSlug={slug}
            now={now}
            sort={sort}
            desc={desc}
            onSort={(key) => {
              if (sort === key) setDesc(!desc);
              else {
                setSort(key);
                setDesc(key === "supply" || key === "price" || key === "twitter");
              }
            }}
            linkOf={(d) =>
              isReal(d.contract) ? openSeaCollectionUrlBySlug(slug, d.contract) : null
            }
            rowTint={(d) => {
              const m = entryFor(d.contract);
              return isPickable(m?.color) ? m.color : undefined;
            }}
            detailExtra={(d) => {
              const m = entryFor(d.contract);
              if (!m) return null;
              return (
                <div className="row-note">
                  <ColorPicker
                    value={isPickable(m.color) ? m.color : "auto"}
                    onPick={(c) => void annotate(m, { color: c })}
                  />
                  <NoteBox value={m.note} onSave={(note) => annotate(m, { note })} />
                  {/* Removal lives here rather than in the row.
                      Two words do not fit the 132px the actions column has —
                      "remove" was being clipped mid-letter — and the one
                      action that loses data is better a click in than a
                      mis-tap away. */}
                  <button
                    className="secondary danger-btn note-btn"
                    disabled={busy}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void remove(m);
                    }}
                  >
                    remove
                  </button>
                </div>
              );
            }}
            actions={(d) => (isReal(d.contract) ? <SnipeButton contract={d.contract} /> : null)}
          />
        ) : null}

        {list && list.length === 0 ? (
          <div className="empty-state">
            NOTHING ON THE WATCHLIST — <span className="es-action">ADD ONE ABOVE, OR /ADD IN THE BOT</span>
          </div>
        ) : null}

        <p className="dim hint" style={{ marginBottom: 0 }}>
          <b>In the bot:</b> <code>/add</code> walks through name → Twitter →
          supply → date, where the date can be <code>1.9</code>,{" "}
          <code>01.09.2026</code>, <code>1.9 18:00</code>, or a button for
          &ldquo;not announced&rdquo;. <code>/list</code> shows everything with a
          remove button beside each one.
        </p>
      </div>
    </div>
  );
}
