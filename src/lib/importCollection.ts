/**
 * Copy the settings of an existing collection into the launch form.
 *
 * Everything comes from public reads: the contract itself (name, symbol,
 * supply, royalties, drop params) plus its contractURI JSON on IPFS/HTTP
 * (description, website, image). Art is deliberately NOT copied — reusing
 * someone else's images would be plagiarism; only the pre-reveal placeholder
 * is offered, and only when the user explicitly asks for it.
 */
import type { PublicClient } from "viem";
import type { ChainInfo } from "../chains";
import { ipfsGatewayUrl } from "../chains";
import { seaDropAbi, tokenAbi } from "../contracts/seadrop";
import { weiToEth } from "./convert";

export interface ImportedCollection {
  name: string;
  symbol: string;
  description: string;
  websiteUrl: string;
  supply: number;
  mintPriceEth: string;
  perWalletLimit: number;
  royaltyPercent: string;
  /** Category from the source contractURI, if it carried one. */
  category: string;
  /** Resolved http(s) URL of the collection image, if the metadata had one. */
  imageUrl?: string;
  /** Human-readable notes about what could and couldn't be copied. */
  notes: string[];
}

/** Turn ipfs:// (or a bare CID) into something fetch() can actually load. */
function toHttp(uri: string): string | null {
  const s = uri.trim();
  if (!s) return null;
  if (s.startsWith("ipfs://")) return ipfsGatewayUrl(s);
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (/^[A-Za-z0-9]{46,}$/.test(s)) return ipfsGatewayUrl(s);
  return null;
}

/** Read a contractURI payload, whether it's a URL or an inline data: JSON. */
async function readContractUri(
  uri: string,
): Promise<Record<string, unknown> | null> {
  const s = uri.trim();
  if (!s) return null;
  try {
    if (s.startsWith("data:")) {
      const comma = s.indexOf(",");
      if (comma === -1) return null;
      const payload = s.slice(comma + 1);
      const json = s.slice(0, comma).includes(";base64")
        ? atob(payload)
        : decodeURIComponent(payload);
      return JSON.parse(json) as Record<string, unknown>;
    }
    const url = toHttp(s);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function importCollection(
  publicClient: PublicClient,
  target: `0x${string}`,
  info: ChainInfo,
): Promise<ImportedCollection> {
  const notes: string[] = [];

  const read = <T,>(functionName: string): Promise<T> =>
    publicClient.readContract({
      address: target,
      abi: tokenAbi,
      functionName,
    } as never) as Promise<T>;

  const [name, symbol] = await Promise.all([
    read<string>("name"),
    read<string>("symbol"),
  ]);

  // Supply / contractURI / royalties are best-effort: a non-SeaDrop ERC-721
  // may not implement them, and that shouldn't sink the whole import.
  let supply = 0;
  try {
    supply = Number(await read<bigint>("maxSupply"));
  } catch {
    notes.push("maxSupply isn't readable on this contract — set the supply yourself.");
  }

  let contractUri = "";
  try {
    contractUri = await read<string>("contractURI");
  } catch {
    /* handled below via the empty string */
  }

  let royaltyPercent = "";
  try {
    const [, amount] = (await publicClient.readContract({
      address: target,
      abi: tokenAbi,
      functionName: "royaltyInfo",
      args: [1n, 10_000n],
    })) as readonly [string, bigint];
    const bps = Number(amount);
    if (bps > 0) royaltyPercent = String(bps / 100);
  } catch {
    notes.push("Royalties aren't readable on this contract (no ERC-2981).");
  }

  // Public drop params, if this collection is a SeaDrop drop on this chain.
  let mintPriceEth = "";
  let perWalletLimit = 0;
  try {
    const drop = await publicClient.readContract({
      address: info.seaDrop,
      abi: seaDropAbi,
      functionName: "getPublicDrop",
      args: [target],
    });
    if (drop.startTime > 0) {
      mintPriceEth = weiToEth(drop.mintPrice);
      perWalletLimit = Number(drop.maxTotalMintableByWallet);
    } else {
      notes.push("No SeaDrop public drop configured there — price/limit not copied.");
    }
  } catch {
    notes.push("Couldn't read SeaDrop drop params for that contract.");
  }

  const meta = await readContractUri(contractUri);
  if (!meta && contractUri) {
    notes.push("contractURI couldn't be fetched — description/website not copied.");
  } else if (!contractUri) {
    notes.push("This contract has no contractURI — description/website not copied.");
  }

  const imageUrl = meta ? toHttp(str(meta.image)) ?? undefined : undefined;

  notes.push(
    "Artwork is never copied — upload your own pre-reveal image and your own art at reveal.",
  );

  return {
    name,
    symbol,
    description: meta ? str(meta.description) : "",
    websiteUrl: meta ? str(meta.external_link) || str(meta.external_url) : "",
    supply,
    mintPriceEth,
    perWalletLimit,
    royaltyPercent,
    category: meta ? str(meta.category) : "",
    imageUrl,
    notes,
  };
}
