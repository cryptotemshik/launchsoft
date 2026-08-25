import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAccount, useChainId, useSwitchChain, useWalletClient } from "wagmi";
import {
  createWalletClient,
  fallback,
  http,
  type Account,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  CHAINS_BY_ID,
  DEFAULT_CHAIN_ID,
  getChainInfo,
  type ChainInfo,
} from "./chains";
import { normalizePrivateKey } from "./lib/convert";
import { loadCustomRpcText, parseCustomRpcs } from "./lib/customRpc";

/**
 * Where a locally-signed transaction is sent. Reads have their own client
 * (see lib/readClient); this is the write half of the same idea — the user's
 * endpoint first, the chain's own RPC as the backstop, so a provider outage
 * costs a retry rather than a failed launch.
 */
function writeTransport() {
  const custom = parseCustomRpcs(loadCustomRpcText());
  if (custom.length === 0) return http();
  return fallback([...custom.map((u) => http(u)), http()], { rank: false });
}

export type SignerMode = "wallet" | "local";

export interface LocalSigner {
  account: PrivateKeyAccount;
}

interface SignerControls {
  mode: SignerMode;
  setMode: (m: SignerMode) => void;
  /** All loaded fast-mode keys, in the order they were added. */
  locals: LocalSigner[];
  /** The key currently used for signing, or null if none loaded. */
  active: LocalSigner | null;
  /** Add a key to the list (throws on a bad key; dedupes by address). */
  addLocalKey: (raw: string) => void;
  /** Remove one loaded key by its address. */
  removeLocal: (address: string) => void;
  /** Drop every loaded key. */
  clearLocals: () => void;
  /** Make one loaded key the active signer. */
  selectLocal: (address: string) => void;
  /** Chain the user has selected in fast mode (ignored in wallet mode). */
  selectedChainId: number;
  setSelectedChainId: (id: number) => void;
}

const Ctx = createContext<SignerControls | null>(null);

export function SignerProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<SignerMode>("wallet");
  const [locals, setLocals] = useState<LocalSigner[]>([]);
  const [activeAddr, setActiveAddr] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<number>(DEFAULT_CHAIN_ID);

  function addLocalKey(raw: string) {
    const account = privateKeyToAccount(normalizePrivateKey(raw));
    const addr = account.address.toLowerCase();
    setLocals((prev) =>
      prev.some((l) => l.account.address.toLowerCase() === addr) ? prev : [...prev, { account }],
    );
    // First key added becomes the active signer automatically.
    setActiveAddr((prev) => prev ?? addr);
  }
  function removeLocal(address: string) {
    const addr = address.toLowerCase();
    setLocals((prev) => {
      const next = prev.filter((l) => l.account.address.toLowerCase() !== addr);
      setActiveAddr((cur) =>
        cur === addr ? (next[0]?.account.address.toLowerCase() ?? null) : cur,
      );
      return next;
    });
  }
  function clearLocals() {
    setLocals([]);
    setActiveAddr(null);
  }
  function selectLocal(address: string) {
    setActiveAddr(address.toLowerCase());
  }

  const active =
    locals.find((l) => l.account.address.toLowerCase() === activeAddr) ?? null;

  const value = useMemo(
    () => ({
      mode,
      setMode,
      locals,
      active,
      addLocalKey,
      removeLocal,
      clearLocals,
      selectLocal,
      selectedChainId,
      setSelectedChainId,
    }),
    [mode, locals, active, selectedChainId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSignerControls(): SignerControls {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSignerControls outside SignerProvider");
  return ctx;
}

export interface ActiveSigner {
  mode: SignerMode;
  address?: `0x${string}`;
  txAccount?: Account | `0x${string}`;
  walletClient?: WalletClient;
  chainId?: number;
  /** Registry info for the active chain, or undefined if unsupported. */
  chainInfo?: ChainInfo;
  isConnected: boolean;
  /** Connected/selected chain isn't in the supported registry. */
  wrongNetwork: boolean;
}

/**
 * The one hook every tab uses. Resolves the active chain (the wallet's chain in
 * wallet mode, the user's picked chain in fast mode) and the right signer.
 */
export function useSigner(): ActiveSigner {
  const ctx = useContext(Ctx);
  const { address: wAddr, isConnected: wConnected } = useAccount();
  const wChain = useChainId();
  const { data: wWallet } = useWalletClient();

  if (ctx?.mode === "local") {
    const info = getChainInfo(ctx.selectedChainId);
    if (!ctx.active || !info) {
      return {
        mode: "local",
        chainId: ctx.selectedChainId,
        chainInfo: info,
        isConnected: false,
        wrongNetwork: false,
      };
    }
    // Local wallet client built for the selected chain; signs locally with the
    // active key (fast mode can hold several — this is the chosen one).
    // Broadcasts through the user's own endpoint when they have set one, with
    // the chain's public RPC behind it: a launch is several transactions, and
    // the public node is the one that throttles.
    const walletClient = createWalletClient({
      account: ctx.active.account,
      chain: info.chain,
      transport: writeTransport(),
    });
    return {
      mode: "local",
      address: ctx.active.account.address,
      txAccount: ctx.active.account,
      walletClient,
      chainId: info.id,
      chainInfo: info,
      isConnected: true,
      wrongNetwork: false,
    };
  }

  // Not connected yet: let the user browse a chain of their choice so the
  // read-only tabs (Wallets, Status, Dashboard) work before connecting.
  if (!wConnected) {
    const selInfo =
      getChainInfo(ctx?.selectedChainId ?? DEFAULT_CHAIN_ID) ??
      getChainInfo(DEFAULT_CHAIN_ID);
    return {
      mode: "wallet",
      chainId: selInfo?.id,
      chainInfo: selInfo,
      isConnected: false,
      wrongNetwork: false,
    };
  }

  const info = getChainInfo(wChain);
  return {
    mode: "wallet",
    address: wAddr,
    txAccount: wAddr,
    walletClient: wWallet ?? undefined,
    chainId: wChain,
    chainInfo: info,
    isConnected: wConnected,
    wrongNetwork: wConnected && !info,
  };
}

/** Just the active ChainInfo (or undefined) — for read-only components. */
export function useActiveChain(): ChainInfo | undefined {
  return useSigner().chainInfo;
}

/**
 * Switch the active chain. In wallet mode this asks the wallet to switch; in
 * fast mode it just updates the selected chain the local signer uses.
 */
export function useChainSwitcher() {
  const ctx = useSignerControls();
  const { switchChain, isPending } = useSwitchChain();
  const active = useSigner();

  function select(id: number) {
    if (!CHAINS_BY_ID.has(id)) return;
    if (ctx.mode === "local" || !active.isConnected) {
      // Fast mode, or wallet mode before connecting — just set the browse chain.
      ctx.setSelectedChainId(id);
    } else {
      switchChain({ chainId: id });
    }
  }
  return { select, switching: isPending, activeId: active.chainId, mode: ctx.mode };
}
