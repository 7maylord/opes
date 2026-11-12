# OPES frontend

The OPES frontend is a Next.js workspace for operating an evidence-backed USDC treasury. It combines the public product site, Privy email authentication, organization onboarding, payable workflows, agreements, owner controls, notifications, inboxes, integrations, and audit views.

See the [root README](../README.md) for the complete product and architecture.

## Workspace areas

- **Overview:** organization health, setup state, and next actions.
- **Notifications:** actionable invoice, agreement, approval, settlement, and failure events.
- **Exceptions & recovery:** tenant-scoped failures, automatic reconciliation cases, and safe recovery guidance.
- **Getting started:** Privy owner wallet, Circle operator, Arc contracts, funding, email, and integrations.
- **Invoices & vendors:** vendor identity, payout verification, evidence upload, three-way match, decisions, overrides, and payment.
- **Agreements:** recurring mandates and milestone escrow lifecycle.
- **Treasury & controls:** live balances, commitments, forecasts, limits, pause controls, authorization, recovery, and ownership.
- **Email inbox:** workspace address, Gmail forwarding instructions, messages, attachments, and processing state.
- **Integrations:** self-service Odoo and ERPNext connection and synchronization status.
- **Team:** organization members and roles.

Financial facts shown in the UI come from persisted API state or confirmed chain reads. Failed balance reads are displayed as unavailable rather than as zero.

## Authentication and signing

Privy provides passwordless email login and the embedded Ethereum owner wallet. The frontend exchanges the Privy access token with the OPES API, then uses the resulting OPES session for tenant requests. Owner-only contract actions request explicit wallet signatures; backend operator payments use the organization’s separate Circle wallet.

Arc Testnet is declared directly in the Privy provider configuration. `NEXT_PUBLIC_OPES_ARC_TESTNET_RPC_URL` controls browser reads and owner transaction submission.

## Local setup

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev --webpack --hostname 127.0.0.1 --port 3005
```

Required public configuration:

```dotenv
NEXT_PUBLIC_OPES_API_URL=http://localhost:3004
NEXT_PUBLIC_OPES_ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io
NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id
```

Privy must allow `http://localhost:3005` as an application origin. Never place the Privy app secret, Circle credentials, database URL, or provider tokens in the frontend environment.

To start the entire local application from the repository root:

```sh
./scripts/dev.sh --worker
```

## API and contract data

API calls live in `lib/api.ts`; generated workspace response types come from the backend OpenAPI document. Refresh them with:

```sh
pnpm api:generate
```

Contract calls import generated JSON from `abi/`. Regenerate all consumer ABIs from the repository root with `node contracts/script/ExportAbis.mjs`; do not add inline ABI fragments.

## Validation

```sh
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm test:e2e:fullstack` runs browser journeys against the real local API and database. The regular Playwright suite uses controlled test state for fast UI coverage.

## Vercel

Create the Vercel project with `frontend` as its root. [vercel.json](vercel.json) selects Next.js. Configure the three public variables above for Production and Preview, set `NEXT_PUBLIC_OPES_API_URL=https://opes.up.railway.app`, and allow the deployed origins in both Privy and backend CORS.

Production is available at [opes.maylord.xyz](https://opes.maylord.xyz).
