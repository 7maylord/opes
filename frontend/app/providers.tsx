"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <main className="p-8">Privy authentication is not configured.</main>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      {children}
      <Toaster richColors position="top-right" />
    </PrivyProvider>
  );
}
