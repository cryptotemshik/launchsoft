/**
 * Chain-independent config. Per-chain addresses/RPCs/slugs live in chains.ts.
 */

/** Default public-drop window length when no end time is given. */
export const DEFAULT_DROP_DAYS = 30;

/**
 * ── Launch fee factories (monetization), per chain ───────────────────────────
 * Deploy PaidSeaDropCloneFactory once per chain you want to monetize (see
 * contracts/README.md), then map the chain id → its factory address here. While
 * a chain has no factory, launches on it are a free direct deploy.
 *
 * The fee amount is read live from each factory (`launchFee()`), so change it
 * on-chain without touching this file.
 */
export const LAUNCH_FACTORIES: Record<number, `0x${string}`> = {
  // 4663: "0xYourRobinhoodChainFactory",
};

export function launchFactoryFor(chainId: number | undefined): `0x${string}` | undefined {
  return chainId === undefined ? undefined : LAUNCH_FACTORIES[chainId];
}

/**
 * Prefilled X (Twitter) post composer. Nothing is auto-posted — the user
 * reviews and edits in X's own UI.
 */
export function xShareUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params.toString()}`;
}
