# OPES frontend

Next.js workspace for Privy email sign-in, tenant setup, evidence, payable decisions, owner controls, liquidity, ledger history, and audit timelines.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev --hostname 127.0.0.1 --port 3005
```

Set `NEXT_PUBLIC_OPES_API_URL=http://localhost:3004` and the public Privy app ID. For Vercel, choose `frontend` as the project root; `vercel.json` selects the Next.js framework.
