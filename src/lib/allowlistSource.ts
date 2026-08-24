/**
 * Locate and load a collection's allow-list document.
 *
 * The list's URI is only ever announced in SeaDrop's `AllowListUpdated` event,
 * so it has to be read from logs — preferring an indexed RPC query, falling
 * back to the chain's Blockscout instance where the RPC refuses wide ranges.
 */
import type { PublicClient } from "viem";
import type { ChainInfo } from "../chains";
import { ipfsGatewayUrl } from "../chains";
import { seaDropAbi } from "../contracts/seadrop";
import { allowListUpdatedEvent, parseAllowList, type ParsedAllowList } from "./allowlist";

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface AllowListSource {
  /** Root as the contract has it — the only authority on what will mint. */
  root: `0x${string}`;
  uri?: string;
  list?: ParsedAllowList;
  /** Why the list couldn't be read, when it couldn't. */
  problem?: string;
  /**
   * Wallets OpenSea has authorised to sign `mintSigned` authorisations. A
   * non-empty list means the drop gates a stage behind a server signature —
   * a real allow-list, just not one whose membership anything but the signer's
   * own backend can answer.
   */
  signers?: readonly string[];
  /** NFT contracts whose holders get a token-gated stage. */
  gatedTokens?: readonly string[];
}

/** Which kind of restricted stage a drop actually uses, if any. */
export type GateKind = "none" | "merkle" | "signed" | "tokenGated";

export function gateKind(s: AllowListSource): GateKind {
  if (hasAllowList(s.root)) return "merkle";
  if (s.signers && s.signers.length > 0) return "signed";
  if (s.gatedTokens && s.gatedTokens.length > 0) return "tokenGated";
  return "none";
}

export function hasAllowList(root: string): boolean {
  return root.toLowerCase() !== ZERO_ROOT;
}

/** Newest allowListURI announced for this collection, or undefined. */
async function findAllowListUri(
  publicClient: PublicClient,
  info: ChainInfo,
  nftContract: `0x${string}`,
): Promise<string | undefined> {
  // nftContract is indexed, so this is a cheap query where the RPC allows it.
  try {
    const logs = await publicClient.getLogs({
      address: info.seaDrop,
      event: allowListUpdatedEvent,
      args: { nftContract },
      fromBlock: 0n,
      toBlock: "latest",
    });
    const last = logs[logs.length - 1];
    if (last?.args?.allowListURI) return last.args.allowListURI;
  } catch {
    // Archive-restricted RPC — fall through to the explorer.
  }

  if (!info.blockscoutApi) return undefined;
  try {
    const res = await fetch(
      `${info.blockscoutApi}/addresses/${info.seaDrop}/logs?topic=${allowListUpdatedTopic}`,
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      items?: {
        topics?: (string | null)[];
        decoded?: { parameters?: { name: string; value: unknown }[] };
      }[];
    };
    const wanted = nftContract.toLowerCase();
    for (const item of data.items ?? []) {
      const topicAddr = "0x" + (item.topics?.[1] ?? "").slice(-40).toLowerCase();
      if (topicAddr !== wanted) continue;
      const uri = item.decoded?.parameters?.find((p) => p.name === "allowListURI")
        ?.value;
      if (typeof uri === "string" && uri) return uri;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** keccak of AllowListUpdated(address,bytes32,bytes32,string[],string). */
const allowListUpdatedTopic =
  "0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5";

/** Fetch + parse the document a URI points at (http, ipfs, or inline data:). */
async function loadDocument(uri: string): Promise<{ doc?: unknown; problem?: string }> {
  try {
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      if (comma === -1) return { problem: "Malformed inline allow-list URI." };
      const payload = uri.slice(comma + 1);
      const text = uri.slice(0, comma).includes(";base64")
        ? atob(payload)
        : decodeURIComponent(payload);
      return { doc: JSON.parse(text) };
    }
    const url = uri.startsWith("ipfs://") ? ipfsGatewayUrl(uri) : uri;
    const res = await fetch(url);
    if (!res.ok) {
      return { problem: `The allow-list file is unreachable (HTTP ${res.status}).` };
    }
    const text = await res.text();
    if (text.includes("BEGIN PGP MESSAGE")) {
      return {
        problem:
          "This allow-list is PGP-encrypted — OpenSea publishes its own lists that way, so only OpenSea can check it. Mint the allow-list stage on opensea.io.",
      };
    }
    return { doc: JSON.parse(text) };
  } catch (e) {
    return {
      problem: `Couldn't read the allow-list file (${
        e instanceof Error ? e.message.split("\n")[0] : e
      }).`,
    };
  }
}

export async function fetchAllowListSource(
  publicClient: PublicClient,
  info: ChainInfo,
  nftContract: `0x${string}`,
): Promise<AllowListSource> {
  const root = (await publicClient.readContract({
    address: info.seaDrop,
    abi: seaDropAbi,
    functionName: "getAllowListMerkleRoot",
    args: [nftContract],
  })) as `0x${string}`;

  // A zero root doesn't mean "public only" — the stage may be gated by a
  // signature or by holding another NFT instead. Ask about those too.
  const [signers, gatedTokens] = await Promise.all([
    publicClient
      .readContract({
        address: info.seaDrop,
        abi: seaDropAbi,
        functionName: "getSigners",
        args: [nftContract],
      })
      .catch(() => [] as readonly string[]) as Promise<readonly string[]>,
    publicClient
      .readContract({
        address: info.seaDrop,
        abi: seaDropAbi,
        functionName: "getTokenGatedAllowedTokens",
        args: [nftContract],
      })
      .catch(() => [] as readonly string[]) as Promise<readonly string[]>,
  ]);

  if (!hasAllowList(root)) return { root, signers, gatedTokens };

  const uri = await findAllowListUri(publicClient, info, nftContract);
  if (!uri) {
    return {
      root,
      signers,
      gatedTokens,
      problem:
        "This drop has an allow-list, but its published location couldn't be found in the chain's logs.",
    };
  }

  const { doc, problem } = await loadDocument(uri);
  if (problem) return { root, uri, problem, signers, gatedTokens };
  return { root, uri, list: parseAllowList(doc), signers, gatedTokens };
}
