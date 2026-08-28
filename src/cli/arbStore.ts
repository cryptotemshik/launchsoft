/**
 * Where observed arbitrage lands.
 *
 * SQLite rather than the JSON files the rest of the server uses, because this
 * is the one thing here that grows without bound: the chain settles around
 * 95,000 Seaport fills a day, and even the filtered opportunities accumulate
 * faster than a file that has to be read and rewritten whole.
 *
 * Amounts are kept twice on purpose. `*_wei` is TEXT and is the truth — wei
 * does not survive a float, and 64-bit integers do not survive wei. The `_eth`
 * REAL columns exist only so SUM() and ORDER BY happen in the database instead
 * of by pulling every row into JavaScript; nothing is ever paid out of them.
 */
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { formatEther } from "viem";

export interface StoredOpportunity {
  collection: string;
  tokenId: string;
  paidWei: bigint;
  offerNetWei: bigint;
  gasWei: bigint;
  profitWei: bigint;
  buyBlock: number;
  sellBlock: number;
  /** Unix seconds, interpolated from the block. */
  at: number;
}

export interface ArbTotals {
  trades: number;
  profitEth: number;
}

export interface CollectionRow {
  collection: string;
  trades: number;
  profitEth: number;
  lastAt: number;
}

/** Next to the config, like every other piece of state this server keeps. */
export function arbDbPath(configPath: string): string {
  return join(dirname(configPath) || ".", "arb.sqlite");
}

export class ArbStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    // Survives a kill mid-write, and does not block readers behind the writer.
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opportunity (
        buy_block   INTEGER NOT NULL,
        sell_block  INTEGER NOT NULL,
        at          INTEGER NOT NULL,
        collection  TEXT    NOT NULL,
        token_id    TEXT    NOT NULL,
        paid_wei    TEXT    NOT NULL,
        offer_wei   TEXT    NOT NULL,
        gas_wei     TEXT    NOT NULL,
        profit_wei  TEXT    NOT NULL,
        profit_eth  REAL    NOT NULL,
        paid_eth    REAL    NOT NULL,
        PRIMARY KEY (buy_block, collection, token_id)
      );
      CREATE INDEX IF NOT EXISTS opportunity_at ON opportunity (at DESC);
      CREATE INDEX IF NOT EXISTS opportunity_col ON opportunity (collection, at DESC);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /**
   * Insert what was observed. The primary key makes a re-read of the same
   * blocks — which happens on every restart, deliberately, since the last
   * scanned block is only written after a batch — silently idempotent.
   */
  record(list: readonly StoredOpportunity[]): number {
    if (list.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO opportunity
        (buy_block, sell_block, at, collection, token_id,
         paid_wei, offer_wei, gas_wei, profit_wei, profit_eth, paid_eth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = this.db.transaction((rows: readonly StoredOpportunity[]) => {
      let added = 0;
      for (const o of rows) {
        const r = stmt.run(
          o.buyBlock, o.sellBlock, o.at, o.collection, o.tokenId,
          o.paidWei.toString(), o.offerNetWei.toString(), o.gasWei.toString(),
          o.profitWei.toString(), Number(formatEther(o.profitWei)), Number(formatEther(o.paidWei)),
        );
        added += r.changes;
      }
      return added;
    });
    return run(list);
  }

  totals(since: number): ArbTotals {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS trades, COALESCE(SUM(profit_eth), 0) AS profit
                FROM opportunity WHERE at >= ?`)
      .get(since) as { trades: number; profit: number };
    return { trades: r.trades, profitEth: r.profit };
  }

  byCollection(since: number, limit = 50): CollectionRow[] {
    return this.db
      .prepare(`SELECT collection, COUNT(*) AS trades,
                       COALESCE(SUM(profit_eth), 0) AS profit, MAX(at) AS last
                FROM opportunity WHERE at >= ?
                GROUP BY collection ORDER BY profit DESC LIMIT ?`)
      .all(since, limit)
      .map((r) => {
        const x = r as { collection: string; trades: number; profit: number; last: number };
        return { collection: x.collection, trades: x.trades, profitEth: x.profit, lastAt: x.last };
      });
  }

  recent(limit = 200, collection?: string): Record<string, unknown>[] {
    const sql = collection
      ? `SELECT * FROM opportunity WHERE collection = ? ORDER BY at DESC LIMIT ?`
      : `SELECT * FROM opportunity ORDER BY at DESC LIMIT ?`;
    const args = collection ? [collection.toLowerCase(), limit] : [limit];
    return this.db.prepare(sql).all(...args) as Record<string, unknown>[];
  }

  /** Per-day totals, for the table under the tiles. */
  daily(days: number): { day: string; trades: number; profitEth: number }[] {
    return this.db
      .prepare(`SELECT date(at, 'unixepoch') AS day, COUNT(*) AS trades,
                       COALESCE(SUM(profit_eth), 0) AS profit
                FROM opportunity GROUP BY day ORDER BY day DESC LIMIT ?`)
      .all(days)
      .map((r) => {
        const x = r as { day: string; trades: number; profit: number };
        return { day: x.day, trades: x.trades, profitEth: x.profit };
      });
  }

  getState(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO state (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
