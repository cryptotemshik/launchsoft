import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Chain } from "viem";
import { CHAINS } from "./chains";

const chains = CHAINS.map((c) => c.chain) as [Chain, ...Chain[]];
const transports = Object.fromEntries(CHAINS.map((c) => [c.id, http()]));

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
