/**
 * A one-line way for any panel to switch the top-level tab — used by upsell
 * buttons that need to send someone to PRICING or PROFILE. App listens for the
 * event and sets the tab; keeping it an event avoids threading a setter through
 * every component.
 */
export function goTab(tab: string): void {
  window.dispatchEvent(new CustomEvent("lp-nav", { detail: tab }));
}
