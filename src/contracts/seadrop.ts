import artifact from "./ERC721SeaDrop.json";
import factoryArtifact from "./PaidSeaDropCloneFactory.json";

/** PaidSeaDropCloneFactory — LaunchPad's on-chain launch-fee wrapper. */
export const launchFactoryAbi = factoryArtifact.abi;
export const launchFactoryBytecode = factoryArtifact.bytecode as `0x${string}`;

/**
 * Stock ERC721SeaDrop from ProjectOpenSea/seadrop (src/ERC721SeaDrop.sol,
 * commit 6ab8b2c), compiled with the repo's pinned solc 0.8.17, optimizer
 * enabled at 1,000,000 runs, bytecode_hash = "none" (per the repo's
 * foundry.toml). Mint logic untouched — OpenSea compatibility depends on it.
 */
export const erc721SeaDropAbi = artifact.abi;
export const erc721SeaDropBytecode = artifact.bytecode as `0x${string}`;

/** Minimal ABI for the read/write calls LaunchPad makes on the token. */
export const tokenAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "baseURI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "contractURI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "provenanceHash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "setBaseURI",
    stateMutability: "nonpayable",
    inputs: [{ name: "newBaseURI", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setMaxSupply",
    stateMutability: "nonpayable",
    inputs: [{ name: "newMaxSupply", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setRoyaltyInfo",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "newInfo",
        type: "tuple",
        components: [
          { name: "royaltyAddress", type: "address" },
          { name: "royaltyBps", type: "uint96" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "royaltyInfo",
    stateMutability: "view",
    inputs: [
      { name: "_tokenId", type: "uint256" },
      { name: "_salePrice", type: "uint256" },
    ],
    outputs: [
      { name: "receiver", type: "address" },
      { name: "royaltyAmount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "updateDropURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seaDropImpl", type: "address" },
      { name: "dropURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setTransferValidator",
    stateMutability: "nonpayable",
    inputs: [{ name: "newValidator", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getTransferValidator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "updatePublicDrop",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seaDropImpl", type: "address" },
      {
        name: "publicDrop",
        type: "tuple",
        components: [
          { name: "mintPrice", type: "uint80" },
          { name: "startTime", type: "uint48" },
          { name: "endTime", type: "uint48" },
          { name: "maxTotalMintableByWallet", type: "uint16" },
          { name: "feeBps", type: "uint16" },
          { name: "restrictFeeRecipients", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** Minimal ABI for the canonical SeaDrop contract (reads + public mint). */
export const seaDropAbi = [
  {
    type: "function",
    name: "mintPublic",
    stateMutability: "payable",
    inputs: [
      { name: "nftContract", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "minterIfNotPayer", type: "address" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getPublicDrop",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "mintPrice", type: "uint80" },
          { name: "startTime", type: "uint48" },
          { name: "endTime", type: "uint48" },
          { name: "maxTotalMintableByWallet", type: "uint16" },
          { name: "feeBps", type: "uint16" },
          { name: "restrictFeeRecipients", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getAllowListMerkleRoot",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "mintAllowList",
    stateMutability: "payable",
    inputs: [
      { name: "nftContract", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "minterIfNotPayer", type: "address" },
      { name: "quantity", type: "uint256" },
      {
        name: "mintParams",
        type: "tuple",
        components: [
          { name: "mintPrice", type: "uint256" },
          { name: "maxTotalMintableByWallet", type: "uint256" },
          { name: "startTime", type: "uint256" },
          { name: "endTime", type: "uint256" },
          { name: "dropStageIndex", type: "uint256" },
          { name: "maxTokenSupplyForStage", type: "uint256" },
          { name: "feeBps", type: "uint256" },
          { name: "restrictFeeRecipients", type: "bool" },
        ],
      },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSigners",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getTokenGatedAllowedTokens",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getCreatorPayoutAddress",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getAllowedFeeRecipients",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

/** Minimal ERC-20 surface for the WETH approval helper (allowance/approve). */
export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;
