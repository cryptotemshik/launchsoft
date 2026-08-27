/**
 * Who has launched what, remembered across scans.
 *
 * The single most useful thing to know about a drop is whether the wallet
 * behind it has done this before — measured on this chain, one address had
 * twelve collections inside a day. But that count is only as good as the
 * history it is drawn from, and a scan is a window: six hours of it shows one
 * collection for an address that has launched forty this year.
 *
 * So this accumulates. Every scan and every lookup adds what it saw, and
 * nothing is ever removed — "this contract was launched by that address" does
 * not stop being true, so an index of it can only get better the longer the
 * server runs. It is deliberately not persisted: a restart costs a few scans
 * of history, and a file of it would be one more thing to keep correct.
 *
 * The same structure answers the same question about a Twitter handle, which
 * is the other half of what a person wants here — a handle reused across four
 * collections is four chances to notice.
 */

export interface IndexedCollection {
  contract: `0x${string}`;
  name?: string;
  /** Unix seconds of the public stage's start, when it is known. */
  startTime?: number;
}

interface Entry extends IndexedCollection {
  owner?: string;
  twitter?: string;
}

/** What a badge needs: the count, and the collections behind it. */
export interface Related {
  /** Collections sharing this owner or handle, newest first. */
  collections: IndexedCollection[];
}

export class CreatorIndex {
  private byContract = new Map<string, Entry>();
  private owners = new Map<string, Set<string>>();
  private handles = new Map<string, Set<string>>();

  /**
   * Add or update what is known about a collection.
   *
   * Fields arrive from different places at different times — the owner and
   * name from a scan's enrichment, the handle from the marketplace lookup —
   * so an update merges rather than replaces. A later call that knows only the
   * handle must not erase the owner learned earlier.
   */
  remember(c: {
    contract: string;
    name?: string;
    startTime?: number;
    owner?: string;
    twitter?: string | null;
  }): void {
    const key = c.contract.toLowerCase();
    const prev = this.byContract.get(key);
    const next: Entry = {
      contract: c.contract as `0x${string}`,
      name: c.name ?? prev?.name,
      startTime: c.startTime ?? prev?.startTime,
      owner: c.owner ?? prev?.owner,
      twitter: c.twitter ?? prev?.twitter,
    };
    this.byContract.set(key, next);

    if (next.owner) this.add(this.owners, next.owner.toLowerCase(), key);
    if (next.twitter) this.add(this.handles, next.twitter.toLowerCase(), key);
  }

  private add(index: Map<string, Set<string>>, k: string, contract: string): void {
    const set = index.get(k);
    if (set) set.add(contract);
    else index.set(k, new Set([contract]));
  }

  /** Everything this address has launched, newest start first. */
  byOwner(owner: string): IndexedCollection[] {
    return this.resolve(this.owners.get(owner.toLowerCase()));
  }

  /** Everything launched under this handle, newest start first. */
  byTwitter(handle: string): IndexedCollection[] {
    return this.resolve(this.handles.get(handle.toLowerCase()));
  }

  private resolve(keys: Set<string> | undefined): IndexedCollection[] {
    if (!keys) return [];
    const out: IndexedCollection[] = [];
    for (const k of keys) {
      const e = this.byContract.get(k);
      if (e) out.push({ contract: e.contract, name: e.name, startTime: e.startTime });
    }
    // Newest first, and a collection with no date sorts last rather than
    // pretending to be from 1970.
    return out.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  }

  /**
   * The related lists for a set of collections, keyed the way a table needs
   * them. Only owners and handles actually present are included, so the
   * payload stays proportional to what is on screen.
   */
  relatedFor(contracts: readonly string[]): {
    owners: Record<string, IndexedCollection[]>;
    twitters: Record<string, IndexedCollection[]>;
  } {
    const owners: Record<string, IndexedCollection[]> = {};
    const twitters: Record<string, IndexedCollection[]> = {};
    for (const c of contracts) {
      const e = this.byContract.get(c.toLowerCase());
      if (!e) continue;
      if (e.owner) {
        const k = e.owner.toLowerCase();
        if (!(k in owners)) owners[k] = this.byOwner(k);
      }
      if (e.twitter) {
        const k = e.twitter.toLowerCase();
        if (!(k in twitters)) twitters[k] = this.byTwitter(k);
      }
    }
    return { owners, twitters };
  }

  get size(): number {
    return this.byContract.size;
  }

  clear(): void {
    this.byContract.clear();
    this.owners.clear();
    this.handles.clear();
  }
}

/**
 * How loudly to say it.
 *
 * One collection is not a finding — everyone's first drop is their first
 * drop. Two is worth a glance, four is a production line.
 */
export function reuseBand(count: number): "none" | "warn" | "bad" {
  if (count <= 1) return "none";
  return count >= 4 ? "bad" : "warn";
}
