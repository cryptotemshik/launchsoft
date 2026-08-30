/**
 * Every drop the scanner has seen, kept on disk.
 *
 * The scanner used to answer each question by re-reading the chain: open the
 * tab, wait while the server pulls three days of logs — six million blocks —
 * and enriches every collection it found. That is the heaviest thing the
 * server does, it happens again on every visit, and it puts a ceiling on how
 * far back you can look: thirty days would take around ninety seconds, which
 * is where a Cloudflare tunnel gives up on a request.
 *
 * So the reading moves off the request path. A worker keeps this table current
 * by reading only the blocks since last time — around 850,000 a day against
 * 25 million for a thirty-day sweep — and the tab answers from here, at once,
 * however far back it asks.
 *
 * A rolling window keeps it honest about size: a drop whose stage opened more
 * than `keepDays` ago is dropped on the next pass. At the measured rate of
 * ~1,700 new collections a day, thirty days is about 52,000 rows.
 */
import { DatabaseSync } from "./nodeSqlite";
import type { ScannedDrop } from "../lib/dropScan";

export interface IndexedDrop extends ScannedDrop {
  /** Unix seconds when this row was last written. */
  seenAt: number;
}

export interface DropIndex {
  /** Insert or refresh a batch, in one transaction. */
  put(drops: readonly ScannedDrop[], at: number): void;
  /**
   * Drops whose stage was last configured at or after `fromBlock`.
   *
   * By block rather than by start time, because that is what a scan window
   * means: "collections someone touched in the last N hours". A drop
   * configured today for next month belongs in today's scan.
   */
  sinceBlock(fromBlock: number, limit?: number): IndexedDrop[];
  /** How many rows are held. */
  count(): number;
  /** Forget everything whose stage opened before `beforeTime`. */
  prune(beforeTime: number): number;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drops (
  contract       TEXT PRIMARY KEY,
  name           TEXT,
  price_wei      TEXT NOT NULL,
  start_time     INTEGER NOT NULL,
  end_time       INTEGER NOT NULL,
  max_per_wallet INTEGER NOT NULL,
  max_supply     INTEGER,
  minted         INTEGER,
  fee_bps        INTEGER NOT NULL,
  owner          TEXT,
  block          INTEGER NOT NULL,
  seen_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drops_start ON drops(start_time);
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** Where the index lives — beside the config, like every other piece of state. */
export function indexDbPath(configPath: string): string {
  return `${configPath}.drops.db`;
}

export function openDropIndex(path: string): DropIndex {
  const db = new DatabaseSync(path);
  // Write-ahead logging: the worker writes every minute while requests read.
  // Without it a read blocks behind a write and the tab stalls for no reason.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO drops (contract, name, price_wei, start_time, end_time,
                       max_per_wallet, max_supply, minted, fee_bps, owner, block, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract) DO UPDATE SET
      name = excluded.name,
      price_wei = excluded.price_wei,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      max_per_wallet = excluded.max_per_wallet,
      max_supply = excluded.max_supply,
      minted = excluded.minted,
      fee_bps = excluded.fee_bps,
      owner = excluded.owner,
      block = excluded.block,
      seen_at = excluded.seen_at
  `);
  const selectSince = db.prepare(
    "SELECT * FROM drops WHERE block >= ? ORDER BY start_time ASC LIMIT ?",
  );
  const countAll = db.prepare("SELECT COUNT(*) AS n FROM drops");
  const deleteBefore = db.prepare("DELETE FROM drops WHERE start_time < ?");
  const getState = db.prepare("SELECT v FROM state WHERE k = ?");
  const setState = db.prepare(
    "INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  );

  const row = (r: Record<string, unknown>): IndexedDrop => ({
    contract: r.contract as `0x${string}`,
    name: (r.name as string | null) ?? undefined,
    priceWei: r.price_wei as string,
    startTime: Number(r.start_time),
    endTime: Number(r.end_time),
    maxPerWallet: Number(r.max_per_wallet),
    maxSupply: r.max_supply === null ? undefined : Number(r.max_supply),
    minted: r.minted === null ? undefined : Number(r.minted),
    feeBps: Number(r.fee_bps),
    owner: (r.owner as string | null) ?? undefined,
    block: Number(r.block),
    seenAt: Number(r.seen_at),
  });

  return {
    put(drops, at) {
      if (drops.length === 0) return;
      // node:sqlite has no db.transaction() helper, so the statements are
      // wrapped by hand — a partial batch would leave the index claiming
      // blocks it never actually stored.
      db.exec("BEGIN");
      try {
        for (const d of drops) {
          upsert.run(
            d.contract,
            d.name ?? null,
            d.priceWei,
            d.startTime,
            d.endTime,
            d.maxPerWallet,
            d.maxSupply ?? null,
            d.minted ?? null,
            d.feeBps,
            d.owner ?? null,
            d.block,
            at,
          );
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    sinceBlock(fromBlock, limit = 20_000) {
      return (selectSince.all(fromBlock, limit) as Record<string, unknown>[]).map(row);
    },
    count() {
      return Number((countAll.get() as { n: number }).n);
    },
    prune(beforeTime) {
      const before = Number((countAll.get() as { n: number }).n);
      deleteBefore.run(beforeTime);
      return before - Number((countAll.get() as { n: number }).n);
    },
    get(key) {
      const r = getState.get(key) as { v: string } | undefined;
      return r?.v;
    },
    set(key, value) {
      setState.run(key, value);
    },
    close() {
      db.close();
    },
  };
}
