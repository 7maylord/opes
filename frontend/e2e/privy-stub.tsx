import type { ReactNode } from "react";

export function PrivyProvider({ children }: { children: ReactNode }) {
  return children;
}

export function usePrivy() {
  return {
    ready: true,
    authenticated: false,
    getAccessToken: async () => null,
    login: () => undefined,
    logout: async () => undefined,
  };
}

export function useSendTransaction() {
  return {
    sendTransaction: async () => ({ hash: `0x${"1".repeat(64)}` }),
  };
}
