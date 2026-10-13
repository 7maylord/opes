import type { NextConfig } from "next";
import path from "node:path";

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

export default nextConfig;
