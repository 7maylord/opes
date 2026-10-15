import type { NextConfig } from "next";
import path from "node:path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  webpack(config) {
    if (process.env.OPES_E2E_AUTH_STUB === "1") {
      config.resolve.alias["@privy-io/react-auth"] = path.resolve(
        process.cwd(),
        "e2e/privy-stub.tsx",
      );
    }
    return config;
  },
};

export default function config(phase: string): NextConfig {
  return {
    ...nextConfig,
    distDir: phase === PHASE_DEVELOPMENT_SERVER
      ? process.env.OPES_E2E_AUTH_STUB === "1" ? ".next-e2e" : ".next-local"
      : ".next",
  };
}
