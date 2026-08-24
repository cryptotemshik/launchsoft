import { defineChain, type Chain } from "viem";

/**
 * ── Multi-chain registry ─────────────────────────────────────────────────────
 * Every OpenSea-supported EVM mainnet where the canonical SeaDrop is deployed.
 * Presence of SeaDrop, Seaport 1.6, and the transfer validator was verified
 * on-chain (eth_getCode) 2026-08-19 — not taken from docs.
 *
 * These three are the SAME deterministic address on every chain here:
 *   SeaDrop            0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
 *   Seaport 1.6        0x0000000000000068F116a894984e2DB1123eB395
 *   OpenSea fee recip. 0x0000a26b00c1F0DF003000390027140000fAa719
 *   transfer validator 0xA000027A9B2802E1ddf7000061001e5c005A0000 (all except Abstract)
 */
export const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5" as const;
export const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395" as const;
export const OPENSEA_FEE_RECIPIENT =
  "0x0000a26b00c1F0DF003000390027140000fAa719" as const;
export const TRANSFER_VALIDATOR =
  "0xA000027A9B2802E1ddf7000061001e5c005A0000" as const;
/** OpenSea drop fee (basis points). Verified 1000 (10%) on live drops. */
export const DEFAULT_FEE_BPS = 1000;

export interface ChainInfo {
  id: number;
  label: string;
  chain: Chain;
  /** OpenSea chain slug for opensea.io/assets/<slug>/<addr>. */
  openSeaSlug: string;
  seaDrop: `0x${string}`;
  seaport: `0x${string}`;
  feeRecipient: `0x${string}`;
  feeBps: number;
  /** Set only where the transfer validator is deployed (enforced royalties). */
  transferValidator?: `0x${string}`;
  explorerUrl: string;
  /** Blockscout v2 API base — enables full profit (royalties, USD). */
  blockscoutApi?: string;
  /**
   * Canonical WETH, where verified on-chain. Secondary sales on OpenSea settle
   * in WETH (offers always do), so this is what a seller approves to Seaport.
   * Set only where the address was checked — a wrong token address here would
   * send an approval to a scam contract.
   */
  weth?: `0x${string}`;
  /**
   * Extra endpoints that accept `eth_sendRawTransaction` — the chain's own
   * sequencer, where it exposes one. These are the shortest path into the
   * ordering queue: an L2 sequencer orders by arrival time, so submitting
   * straight to it skips the forwarding hop a public RPC adds.
   *
   * Send-only by design: several reject reads (`eth_chainId` answers "method
   * not allowed"), so they're used for broadcasting only, never for reading.
   * Every entry here was probed directly — it must accept a raw transaction.
   */
  submitRpcs?: string[];
}

/** OP-stack predeploy WETH — same address on every OP-stack chain (verified). */
const OP_WETH = "0x4200000000000000000000000000000000000006" as const;

function make(params: {
  id: number;
  label: string;
  symbol: string;
  rpc: string;
  explorerUrl: string;
  openSeaSlug: string;
  explorerName?: string;
  hasValidator?: boolean;
  blockscoutApi?: string;
  currencyName?: string;
  weth?: `0x${string}`;
  submitRpcs?: string[];
}): ChainInfo {
  const chain = defineChain({
    id: params.id,
    name: params.label,
    nativeCurrency: {
      name: params.currencyName ?? params.symbol,
      symbol: params.symbol,
      decimals: 18,
    },
    rpcUrls: { default: { http: [params.rpc] } },
    blockExplorers: {
      default: { name: params.explorerName ?? "Explorer", url: params.explorerUrl },
    },
  });
  return {
    id: params.id,
    label: params.label,
    chain,
    openSeaSlug: params.openSeaSlug,
    seaDrop: SEADROP,
    seaport: SEAPORT,
    feeRecipient: OPENSEA_FEE_RECIPIENT,
    feeBps: DEFAULT_FEE_BPS,
    transferValidator: params.hasValidator === false ? undefined : TRANSFER_VALIDATOR,
    explorerUrl: params.explorerUrl,
    blockscoutApi: params.blockscoutApi,
    weth: params.weth,
    submitRpcs: params.submitRpcs,
  };
}

export const CHAINS: ChainInfo[] = [
  make({
    id: 4663,
    label: "Robinhood Chain",
    symbol: "ETH",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    openSeaSlug: "robinhood",
    blockscoutApi: "https://robinhoodchain.blockscout.com/api/v2",
    // Verified: TransparentUpgradeableProxy → aeWETH, 425k holders, Seaport settles in it.
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // Probed 2026-08-24: accepts eth_sendRawTransaction, refuses eth_chainId
    // ("method does not exist") — send-only, and the shortest path into this
    // Orbit chain's first-come-first-served sequencing queue.
    submitRpcs: ["https://sequencer.mainnet.chain.robinhood.com"],
  }),
  make({
    id: 1,
    label: "Ethereum",
    symbol: "ETH",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://etherscan.io",
    explorerName: "Etherscan",
    openSeaSlug: "ethereum",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  }),
  make({
    id: 8453,
    label: "Base",
    symbol: "ETH",
    rpc: "https://base-rpc.publicnode.com",
    explorerUrl: "https://basescan.org",
    explorerName: "Basescan",
    openSeaSlug: "base",
    blockscoutApi: "https://base.blockscout.com/api/v2",
    weth: OP_WETH,
    // Probed 2026-08-24: accepts eth_sendRawTransaction, refuses reads
    // ("rpc method is not allowed") — send-only.
    submitRpcs: ["https://mainnet-sequencer.base.org"],
  }),
  make({
    id: 42161,
    label: "Arbitrum One",
    symbol: "ETH",
    rpc: "https://arbitrum-one-rpc.publicnode.com",
    explorerUrl: "https://arbiscan.io",
    explorerName: "Arbiscan",
    openSeaSlug: "arbitrum",
  }),
  make({
    id: 42170,
    label: "Arbitrum Nova",
    symbol: "ETH",
    rpc: "https://arbitrum-nova-rpc.publicnode.com",
    explorerUrl: "https://nova.arbiscan.io",
    explorerName: "Arbiscan",
    openSeaSlug: "arbitrum_nova",
  }),
  make({
    id: 10,
    label: "Optimism",
    symbol: "ETH",
    rpc: "https://optimism-rpc.publicnode.com",
    explorerUrl: "https://optimistic.etherscan.io",
    explorerName: "Etherscan",
    openSeaSlug: "optimism",
    blockscoutApi: "https://optimism.blockscout.com/api/v2",
    weth: OP_WETH,
    // Probed 2026-08-24: accepts eth_sendRawTransaction (and reads).
    submitRpcs: ["https://mainnet-sequencer.optimism.io"],
  }),
  make({
    id: 137,
    label: "Polygon",
    symbol: "POL",
    currencyName: "Polygon Ecosystem Token",
    rpc: "https://polygon-bor-rpc.publicnode.com",
    explorerUrl: "https://polygonscan.com",
    explorerName: "Polygonscan",
    openSeaSlug: "matic",
  }),
  make({
    id: 7777777,
    label: "Zora",
    symbol: "ETH",
    rpc: "https://rpc.zora.energy",
    explorerUrl: "https://explorer.zora.energy",
    explorerName: "Blockscout",
    openSeaSlug: "zora",
    blockscoutApi: "https://explorer.zora.energy/api/v2",
    weth: OP_WETH,
  }),
  make({
    id: 81457,
    label: "Blast",
    symbol: "ETH",
    rpc: "https://blast-rpc.publicnode.com",
    explorerUrl: "https://blastscan.io",
    explorerName: "Blastscan",
    openSeaSlug: "blast",
  }),
  make({
    id: 43114,
    label: "Avalanche",
    symbol: "AVAX",
    currencyName: "Avalanche",
    rpc: "https://avalanche-c-chain-rpc.publicnode.com",
    explorerUrl: "https://snowscan.xyz",
    explorerName: "Snowscan",
    openSeaSlug: "avalanche",
  }),
  make({
    id: 1329,
    label: "Sei",
    symbol: "SEI",
    currencyName: "Sei",
    rpc: "https://evm-rpc.sei-apis.com",
    explorerUrl: "https://seitrace.com",
    explorerName: "Seitrace",
    openSeaSlug: "sei",
  }),
  make({
    id: 8333,
    label: "B3",
    symbol: "ETH",
    rpc: "https://mainnet-rpc.b3.fun",
    explorerUrl: "https://explorer.b3.fun",
    explorerName: "Blockscout",
    openSeaSlug: "b3",
    blockscoutApi: "https://explorer.b3.fun/api/v2",
    weth: OP_WETH,
  }),
  make({
    id: 2020,
    label: "Ronin",
    symbol: "RON",
    currencyName: "Ronin",
    rpc: "https://api.roninchain.com/rpc",
    explorerUrl: "https://app.roninchain.com/explorer",
    explorerName: "Ronin Explorer",
    openSeaSlug: "ronin",
  }),
  make({
    id: 33139,
    label: "ApeChain",
    symbol: "APE",
    currencyName: "ApeCoin",
    rpc: "https://rpc.apechain.com/http",
    explorerUrl: "https://apescan.io",
    explorerName: "Apescan",
    openSeaSlug: "ape_chain",
  }),
  make({
    id: 360,
    label: "Shape",
    symbol: "ETH",
    rpc: "https://mainnet.shape.network",
    explorerUrl: "https://shapescan.xyz",
    explorerName: "Blockscout",
    openSeaSlug: "shape",
    blockscoutApi: "https://shapescan.xyz/api/v2",
    weth: OP_WETH,
  }),
  make({
    id: 1868,
    label: "Soneium",
    symbol: "ETH",
    rpc: "https://rpc.soneium.org",
    explorerUrl: "https://soneium.blockscout.com",
    explorerName: "Blockscout",
    openSeaSlug: "soneium",
    blockscoutApi: "https://soneium.blockscout.com/api/v2",
    weth: OP_WETH,
  }),
  make({
    id: 130,
    label: "Unichain",
    symbol: "ETH",
    rpc: "https://mainnet.unichain.org",
    explorerUrl: "https://uniscan.xyz",
    explorerName: "Uniscan",
    openSeaSlug: "unichain",
    blockscoutApi: "https://unichain.blockscout.com/api/v2",
    weth: OP_WETH,
  }),
  make({
    id: 2741,
    label: "Abstract",
    symbol: "ETH",
    rpc: "https://api.mainnet.abs.xyz",
    explorerUrl: "https://abscan.io",
    explorerName: "Abscan",
    openSeaSlug: "abstract",
    hasValidator: false, // transfer validator not deployed here (verified)
  }),
  make({
    id: 80094,
    label: "Berachain",
    symbol: "BERA",
    currencyName: "Bera",
    rpc: "https://rpc.berachain.com",
    explorerUrl: "https://berascan.com",
    explorerName: "Berascan",
    openSeaSlug: "berachain",
  }),
  make({
    id: 747,
    label: "Flow EVM",
    symbol: "FLOW",
    currencyName: "Flow",
    rpc: "https://mainnet.evm.nodes.onflow.org",
    explorerUrl: "https://evm.flowscan.io",
    explorerName: "Blockscout",
    openSeaSlug: "flow",
    blockscoutApi: "https://evm.flowscan.io/api/v2",
  }),
];

export const CHAINS_BY_ID = new Map(CHAINS.map((c) => [c.id, c]));
export const DEFAULT_CHAIN_ID = 4663;

export function getChainInfo(id: number | undefined): ChainInfo | undefined {
  return id === undefined ? undefined : CHAINS_BY_ID.get(id);
}

// ── Explorer / OpenSea link helpers (chain-aware) ────────────────────────────

export function openSeaCollectionUrl(info: ChainInfo, contract: string): string {
  return `https://opensea.io/assets/${info.openSeaSlug}/${contract}`;
}

export function openSeaItemUrl(
  info: ChainInfo,
  contract: string,
  tokenId: string | number | bigint,
): string {
  return `https://opensea.io/item/${info.openSeaSlug}/${contract}/${tokenId}`;
}

export function explorerAddressUrl(info: ChainInfo, address: string): string {
  return `${info.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(info: ChainInfo, hash: string): string {
  return `${info.explorerUrl}/tx/${hash}`;
}

/**
 * IPFS gateways in fallback order. A single gateway rate-limits and stalls, so
 * images/metadata try these in turn (see `ipfsUrl` + the `IpfsImg` component).
 */
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
] as const;

/** Strip the ipfs:// (or bare ipfs/) prefix to a raw path. */
export function ipfsPath(uri: string): string {
  return uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

/** Resolve an ipfs:// URI through the Nth gateway; pass http(s) URIs through. */
export function ipfsUrl(uri: string, gateway = 0): string {
  if (!uri.startsWith("ipfs://")) return uri;
  const g = IPFS_GATEWAYS[gateway % IPFS_GATEWAYS.length];
  return `${g}${ipfsPath(uri)}`;
}

/** Back-compat single-gateway helper (first gateway in the list). */
export function ipfsGatewayUrl(ipfsUri: string): string {
  return ipfsUrl(ipfsUri, 0);
}

/** A wallet's OpenSea profile page. */
export function openSeaProfileUrl(address: string): string {
  return `https://opensea.io/${address}`;
}
