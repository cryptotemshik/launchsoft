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

export type SignerMode = "wallet" | "local";

interface LocalSigner {
  account: PrivateKeyAccount;
}

interface SignerControls {
  mode: SignerMode;
  setMode: (m: SignerMode) => void;
  local: LocalSigner | null;
  setLocalKey: (raw: string) => void;
  clearLocal: () => void;
  /** Chain the user has selected in fast mode (ignored in wallet mode). */
  selectedChainId: number;
  setSelectedChainId: (id: number) => void;
}

const Ctx = createContext<SignerControls | null>(null);

export function SignerProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<SignerMode>("wallet");
  const [local, setLocal] = useState<LocalSigner | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<number>(DEFAULT_CHAIN_ID);

  function setLocalKey(raw: string) {
    const key = normalizePrivateKey(raw);
    setLocal({ account: privateKeyToAccount(key) });
  }
  function clearLocal() {
    setLocal(null);
  }

  const value = useMemo(
    () => ({ mode, setMode, local, setLocalKey, clearLocal, selectedChainId, setSelectedChainId }),
    [mode, local, selectedChainId],
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
    if (!ctx.local || !info) {
      return {
        mode: "local",
        chainId: ctx.selectedChainId,
        chainInfo: info,
        isConnected: false,
        wrongNetwork: false,
      };
    }
    // Local wallet client built for the selected chain; signs locally.
    const walletClient = createWalletClient({
      account: ctx.local.account,
      chain: info.chain,
      transport: http(),
    });
    return {
      mode: "local",
      address: ctx.local.account.address,
      txAccount: ctx.local.account,
      walletClient,
      chainId: info.id,
      chainInfo: info,
      isConnected: true,
      wrongNetwork: false,
    };
  }

  // Not connected yet: let the user browse a chain of their choice so the
  // read-only tabs (Live, Wallets, Status, Dashboard) work before connecting.
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
