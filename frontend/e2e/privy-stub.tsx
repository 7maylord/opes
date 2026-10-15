import { useSyncExternalStore, type ReactNode } from "react";

export function PrivyProvider({ children }: { children: ReactNode }) {
  return children;
}

export function usePrivy() {
  const authenticated = useSyncExternalStore(
    () => () => undefined,
    () => new URLSearchParams(window.location.search).has("privy-auth"),
    () => false,
  );
  return {
    ready: true,
    authenticated,
    getAccessToken: async () => "privy-access-token",
    login: () => localStorage.setItem("opes:e2e-login-opened", "1"),
    logout: async () => undefined,
  };
}

export function useWallets() {
  return { ready: true, wallets: [] };
}

export function useCreateWallet() {
  return {
    createWallet: async () => {
      localStorage.setItem("opes:e2e-wallet-created", "1");
    },
  };
}

export function useSendTransaction() {
  return {
    sendTransaction: async () => ({ hash: `0x${"1".repeat(64)}` }),
  };
}
