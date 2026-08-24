/**
 * Launch progress persisted to localStorage so a failure mid-launch (e.g.
 * deploy succeeded, multiConfigure rejected) can resume against the saved
 * contract address instead of deploying twice. No secrets in here — the
 * Pinata JWT is deliberately NOT part of this state.
 */

const KEY = "launchpad.launch.v1";

export interface LaunchFormValues {
  name: string;
  symbol: string;
  description: string;
  /** Optional collection website → contractURI external_link on OpenSea. */
  websiteUrl: string;
  /** OpenSea collection category, e.g. "PFPs". Written into contractURI. */
  category: string;
  /** Item name shown before reveal. Empty → "<collection> (unrevealed)". */
  prerevealName: string;
  /** Item description shown before reveal. Empty → the collection description. */
  prerevealDescription: string;
  supply: number;
  /** ETH string as typed, e.g. "0.02"; wei is derived at tx time. */
  mintPriceEth: string;
  perWalletLimit: number;
  /** datetime-local string (local wall-clock). Ignored when startNow is set. */
  startLocal: string;
  /** Open the drop the moment the configure tx lands. */
  startNow: boolean;
  /**
   * How long the drop stays open, counted from its start. SeaDrop stores an
   * absolute endTime — this is what it gets derived from, and it's the same
   * number OpenSea's stage dialog calls "Duration".
   */
  durationDays: number;
  durationHours: number;
  durationMins: number;
  provenanceHash: string;
  /** Royalty percent as typed, e.g. "5" → 500 bps. Empty = skip royalties. */
  royaltyPercent: string;
  /** true → extra tx sets OpenSea's transfer validator (enforced royalties). */
  enforcedRoyalties: boolean;
  creatorPayoutAddress: string;
}

export interface LaunchState {
  form: LaunchFormValues;
  /** Derived at confirm time so resume uses identical params. */
  startTime: number;
  endTime: number;
  // IPFS steps
  prerevealImageCid?: string;
  /** Collection picture (OpenSea logo). Falls back to the pre-reveal image. */
  collectionImageCid?: string;
  prerevealMetadataCid?: string;
  contractUriCid?: string;
  // Chain steps
  deployTxHash?: string;
  contractAddress?: string;
  configureTxHash?: string;
  royaltyTxHash?: string;
  validatorTxHash?: string;
  // Reveal (filled in by the Reveal tab)
  revealImagesCid?: string;
  revealMetadataCid?: string;
  revealTxHash?: string;
  completedAt?: number;
}

export function loadLaunchState(): LaunchState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LaunchState) : null;
  } catch {
    return null;
  }
}

export function saveLaunchState(state: LaunchState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function updateLaunchState(patch: Partial<LaunchState>): LaunchState {
  const current = loadLaunchState();
  if (!current) throw new Error("No launch in progress");
  const next = { ...current, ...patch };
  saveLaunchState(next);
  return next;
}

export function clearLaunchState(): void {
  localStorage.removeItem(KEY);
}
