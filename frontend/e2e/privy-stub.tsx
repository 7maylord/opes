import { useSyncExternalStore, type ReactNode } from "react";

export const SUPPORTED_CHAINS: never[] = [];

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
  const created = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("opes-e2e-wallet", onChange);
      return () => window.removeEventListener("opes-e2e-wallet", onChange);
    },
    () => localStorage.getItem("opes:e2e-wallet-created") === "1",
    () => false,
  );
  return {
    ready: true,
    wallets: created
      ? [{
          address: "0x5000000000000000000000000000000000000005",
          type: "ethereum",
          walletClientType: "privy",
        }]
      : [],
  };
}

export function useCreateWallet() {
  return {
    createWallet: async () => {
      localStorage.setItem("opes:e2e-wallet-created", "1");
      window.dispatchEvent(new Event("opes-e2e-wallet"));
    },
  };
}

export function useSignTransaction() {
  return {
    signTransaction: async () => ({ signature: "0x02" }),
  };
}

export function useSendTransaction() {
  return {
    sendTransaction: async () => ({ hash: `0x${"1".repeat(64)}` }),
  };
}
