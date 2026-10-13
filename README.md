# OPES

OPES is an AI treasury operator for businesses. It ingests invoice evidence, applies tenant policy, records the decision trail, and moves USDC through organization-specific wallets and verified Arc contracts.

## Verified release scope

- Privy email authentication and isolated organization workspaces
- Circle developer-controlled operator wallets
- Verified Arc Testnet organization factory, policy vault, and milestone escrow
- Invoice extraction, duplicate controls, approval expiry/revocation, payment execution, reconciliation, and a balanced audit ledger
- Arc Testnet to Base Sepolia USDC liquidity through the CCTP and Gateway adapters

All six requested chain families remain in the registry. Routes other than the verified Arc Testnet/Base Sepolia corridor are visible as rollout targets and fail closed. Mainnet execution requires a separate authorization and evidence pass. Base USDC to USDT remains disabled unless all swap bindings are configured.

## Run locally

Requirements: Node.js 22, pnpm 10.25, Docker, and Foundry 1.5.1.

```sh
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
scripts/dev.sh --worker
```

The frontend runs at `http://localhost:3005`; the API runs at `http://localhost:3004`. Docker provides PostgreSQL and the local S3-compatible MinIO service only.

## Verify

```sh
pnpm --dir backend lint
pnpm --dir backend build
pnpm --dir backend test --runInBand
pnpm --dir backend test:e2e --runInBand
pnpm --dir frontend lint
pnpm --dir frontend test
pnpm --dir frontend build
pnpm --dir frontend test:e2e
pnpm --dir frontend test:e2e:fullstack
scripts/check-secrets.sh
```

Contract checks run from `contracts/` with `forge fmt --check`, `forge build --sizes`, `node script/ExportAbis.mjs --check`, and `forge test -vvv`. Application ABIs are generated into `backend/src/abi/` and `frontend/abi/`; no inline ABI is maintained.

## Deployment

- Vercel project root: `frontend`; configure only `NEXT_PUBLIC_OPES_API_URL` and `NEXT_PUBLIC_PRIVY_APP_ID`.
- Railway API project root: `backend`; use `railway.api.json` and expose the generated domain.
- Railway worker project root: `backend`; use `railway.worker.json` without a public domain.
- Attach Railway PostgreSQL to both backend services. Attach one private Railway Storage Bucket and its S3-compatible variables to the API and worker only where document processing needs them.
- Put Circle, DeepSeek, Privy secret, RPC, signer, webhook, and operations credentials only on backend services that consume them. Set `OPES_ALLOWED_ORIGINS` to the exact Vercel production and preview origins.

The API configuration runs migrations once before deployment and checks `/ready`. Operational recovery and alert procedures are in [backend/RUNBOOK.md](backend/RUNBOOK.md). The release evidence and remaining external gates are in [RELEASE.md](RELEASE.md).

## Verified Arc contracts

- OrganizationFactory: [`0x6b3aa0d68fba3ff8add42071ba82e714b5a6a488`](https://explorer.testnet.arc.io/address/0x6b3aa0d68fba3ff8add42071ba82e714b5a6a488)
- VaultDeployer: [`0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8`](https://explorer.testnet.arc.io/address/0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8)

Deployment manifests under `contracts/deployments/5042002/` contain the verification evidence and tenant smoke-test transactions.
