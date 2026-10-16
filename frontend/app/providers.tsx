"use client";

import { PrivyProvider, SUPPORTED_CHAINS } from "@privy-io/react-auth";
import { Toaster } from "sonner";

const arcTestnet = {
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
} as const;

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <main className="p-8">Privy authentication is not configured.</main>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        supportedChains: [arcTestnet, ...SUPPORTED_CHAINS],
        defaultChain: arcTestnet,
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      {children}
      <Toaster richColors position="top-right" />
    </PrivyProvider>
  );
}
