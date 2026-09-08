import { http, createConfig, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import type { Chain } from "viem";
import { CHAINS } from "./chains";

const chains = CHAINS.map((c) => c.chain) as [Chain, ...Chain[]];
const transports = Object.fromEntries(CHAINS.map((c) => [c.id, http()]));

/**
 * WalletConnect turns a phone into a wallet: the site shows a QR (or a deep
 * link on mobile) and any WalletConnect wallet approves from there. It only
 * exists when a project id is baked in at build (VITE_WC_PROJECT_ID) — without
 * one the connector cannot start, so the app falls back to injected only, which
 * is exactly today's behaviour.
 */
const WC_PROJECT_ID = (
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WC_PROJECT_ID ?? ""
).trim();

const connectors: CreateConnectorFn[] = [injected()];
if (WC_PROJECT_ID) {
  connectors.push(
    walletConnect({
      projectId: WC_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name: "Orvex",
        description: "NFT drop launcher & sniper",
        url: "https://app.orvex.cash",
        icons: ["https://app.orvex.cash/favicon.svg"],
      },
    }),
  );
}

export const wagmiConfig = createConfig({
  chains,
  connectors,
  transports,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
