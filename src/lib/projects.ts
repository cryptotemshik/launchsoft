/**
 * Dashboard project registry — contract addresses only, persisted locally.
 * Launches made from this browser register themselves; anything else can be
 * added by address. No secrets in here.
 */
import { loadLaunchState } from "./launchState";

const KEY = "launchpad.projects.v1";

export interface ProjectEntry {
  address: string;
  /** Cached display bits so the table paints instantly on revisit. */
  name?: string;
  createdAt?: number;
  /**
   * User-set OpenSea URL. OpenSea assigns its own slug once it indexes the
   * collection (opensea.io/collection/<slug>), which no contract field
   * predicts — so the address-based link is only a fallback until the real
   * one is pasted here.
   */
  openSeaUrl?: string;
  source: "launch" | "manual";
  addedAt: number;
}

/** The OpenSea link for a contract: the user's override, else the fallback. */
export function collectionOpenSeaUrl(address: string, fallback: string): string {
  const custom = loadProjects().find(
    (p) => p.address.toLowerCase() === address.toLowerCase(),
  )?.openSeaUrl;
  return custom?.trim() ? custom.trim() : fallback;
}

export function setOpenSeaUrl(address: string, url: string): ProjectEntry[] {
  const projects = loadProjects();
  const existing = projects.find(
    (p) => p.address.toLowerCase() === address.toLowerCase(),
  );
  const trimmed = url.trim();
  if (existing) {
    existing.openSeaUrl = trimmed || undefined;
  } else {
    projects.push({
      address,
      openSeaUrl: trimmed || undefined,
      source: "manual",
      addedAt: Date.now(),
    });
  }
  save(projects);
  return projects;
}

export function loadProjects(): ProjectEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProjectEntry[]) : [];
  } catch {
    return [];
  }
}

function save(projects: ProjectEntry[]): void {
  localStorage.setItem(KEY, JSON.stringify(projects));
}

export function upsertProject(entry: Omit<ProjectEntry, "addedAt">): ProjectEntry[] {
  const projects = loadProjects();
  const existing = projects.find(
    (p) => p.address.toLowerCase() === entry.address.toLowerCase(),
  );
  if (existing) {
    Object.assign(existing, entry);
  } else {
    projects.push({ ...entry, addedAt: Date.now() });
  }
  save(projects);
  return projects;
}

export function removeProject(address: string): ProjectEntry[] {
  const projects = loadProjects().filter(
    (p) => p.address.toLowerCase() !== address.toLowerCase(),
  );
  save(projects);
  return projects;
}

/** Pull a completed launch from the single-launch state into the registry. */
export function syncLaunchIntoRegistry(): ProjectEntry[] {
  const launch = loadLaunchState();
  if (launch?.contractAddress && launch.completedAt) {
    return upsertProject({
      address: launch.contractAddress,
      name: launch.form?.name,
      source: "launch",
    });
  }
  return loadProjects();
}
