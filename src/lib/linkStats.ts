/**
 * Click counters for a collection's outbound links (X/Twitter, website,
 * OpenSea), stored per contract in localStorage.
 *
 * Scope, stated plainly: this counts clicks made **through LaunchPad, in this
 * browser**. It cannot see clicks on the link as it appears on opensea.io or
 * anywhere else — a static site has no server to receive those hits. To count
 * every click from every visitor, point the collection's website/X field at a
 * redirect that keeps its own tally (a link shortener with analytics), and read
 * the numbers there.
 */

const KEY = "launchpad.linkclicks.v1";

export type LinkKind = "twitter" | "website" | "opensea";

export const LINK_LABEL: Record<LinkKind, string> = {
  twitter: "X / Twitter",
  website: "website",
  opensea: "OpenSea",
};

export interface ClickRecord {
  count: number;
  /** Unix ms of the most recent click. */
  lastAt: number;
}

/** { "<contract-lowercase>|<kind>": ClickRecord } */
type Store = Record<string, ClickRecord>;

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable — counting silently degrades to a no-op.
  }
}

const slot = (contract: string, kind: LinkKind) =>
  `${contract.toLowerCase()}|${kind}`;

export function recordClick(contract: string, kind: LinkKind): ClickRecord {
  const store = load();
  const key = slot(contract, kind);
  const next: ClickRecord = {
    count: (store[key]?.count ?? 0) + 1,
    lastAt: Date.now(),
  };
  store[key] = next;
  save(store);
  return next;
}

export function getClicks(contract: string, kind: LinkKind): ClickRecord {
  return load()[slot(contract, kind)] ?? { count: 0, lastAt: 0 };
}

/** Every counter for one collection, in a stable display order. */
export function getAllClicks(
  contract: string,
): { kind: LinkKind; record: ClickRecord }[] {
  const store = load();
  return (["twitter", "website", "opensea"] as LinkKind[]).map((kind) => ({
    kind,
    record: store[slot(contract, kind)] ?? { count: 0, lastAt: 0 },
  }));
}

export function resetClicks(contract: string): void {
  const store = load();
  for (const kind of ["twitter", "website", "opensea"] as LinkKind[]) {
    delete store[slot(contract, kind)];
  }
  save(store);
}
