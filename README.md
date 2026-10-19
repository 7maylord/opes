# OPES

**The evidence and treasury authorization layer for autonomous business payments.**

OPES turns invoices, purchase records, delivery evidence, treasury policy, and live balances into controlled USDC payments. It gives a business an AI operator that can understand financial documents and recommend what to do, while deterministic services and organization-owned smart contracts decide what is actually allowed.

[Open OPES](https://opes.maylord.xyz) · [Product requirements](docs/OPES_PRD_TRD.md) · [Implementation status](docs/IMPLEMENTATION_PLAN.md) · [Operations runbook](backend/RUNBOOK.md)

## Why OPES exists

Paying an invoice safely requires more than extracting an amount and sending money. A business must know that the vendor is real, the payout address is verified, the purchase was authorized, the goods or work arrived, the invoice is not a duplicate, cash remains available, and the payment settled exactly once.

OPES joins those checks into one operating loop:

> Ingest → verify → match → decide → authorize → pay → reconcile → account

The model handles judgment-heavy work such as document extraction and advisory recommendations. Code handles matching, limits, routing, retries, and accounting. Arc contracts enforce the final onchain authority. Every result remains linked to its source evidence.

## What OPES ships

### One payable inbox, several intake paths

- Upload invoices, purchase orders, receipts, contracts, and milestone evidence.
- Receive invoice email and attachments through a workspace inbox backed by signed Resend webhooks.
- Give each vendor a scoped portal to submit or correct evidence, track invoices, request payout-address re-verification, and download confirmed payment advice.
- Watch an object-storage folder for new financial evidence.
- Import suppliers, purchase orders, receipts, and vendor bills from **Odoo 19 JSON-2** or **ERPNext REST**.
- Store immutable document hashes and extraction provenance in private object storage.

### Evidence before money

- Extract structured fields from PDF, text, and supported business documents with DeepSeek.
- Require a human confirmation boundary for extracted financial facts.
- Maintain a verified vendor master and payout-address history.
- Detect exact and semantic invoice duplicates.
- Perform deterministic three-way matching across invoice, purchase order or contract, and delivery receipt or accepted milestone.
- Block overbilling, delivery shortfalls, revoked evidence, vendor mismatches, and unverified payout changes with explicit reasons.

### A treasury agent with bounded authority

- Produce `PAY`, `DELAY`, `ESCALATE`, or `REJECT` recommendations.
- Re-evaluate every executable action through deterministic policy checks.
- Protect operating buffers, single-payment limits, vendor daily limits, organization daily limits, and monthly budgets.
- Track verified, restricted, reserved, committed, incoming, in-transit, and available liquidity.
- Forecast 30-day and 90-day commitments from invoices and agreements.
- Let owners override, reschedule, reject, pause, recover, or transfer control with a recorded reason and audit trail.
- Notify the workspace when evidence needs review, approval is required, agreements change, or a payment settles or fails.

### Three payment arrangements

| Arrangement | Use case | Control model |
|---|---|---|
| Direct payment | A verified one-time invoice | Exact obligation, vendor, amount, expiry, policy snapshot, and replay key |
| Recurring mandate | Subscriptions and repeat vendor payments | Fixed schedule, per-cycle amount, total cap, pause/resume/cancel, and one obligation per cycle |
| Milestone escrow | Work delivered in stages | Prefunded immutable allocations, evidence-bound approvals, disputes, releases, cancellation, and refunds |

All three arrangements share the same vendor controls, evidence lineage, tenant policy, reconciliation, and ledger.

### Wallets and contracts per organization

- Privy email login creates the user-facing embedded owner wallet.
- Circle developer-controlled wallets give each organization a backend operator identity.
- A sponsored Arc factory deploys a separate `BusinessPolicyVault` and `MilestoneEscrow` for each organization, so the customer does not need deployment gas.
- Contracts begin paused with zero limits. The owner explicitly configures policy before money can move.
- Operators can execute approved actions but cannot change ownership or expand their own authority.
- Contract calls are verified against transaction input, receipts, events, bindings, and expected state before OPES accepts settlement.

### Execution that survives retries

- Persisted outbox jobs and idempotency keys make worker restarts safe.
- Unknown provider states are reconciled before any resubmission.
- Circle transaction results are checked against authoritative chain RPC evidence.
- Successful payments create balanced, document-linked ledger postings.
- Supplier payment advice includes the paid invoice, amount, network, transaction, and explorer link.
- Accounting connectors can write settlement references back to the source system without duplicating the writeback.

### Multi-tenant by construction

Every request, document, wallet, contract binding, job, decision, and ledger entry belongs to exactly one organization. PostgreSQL row-level security reinforces application authorization. Owners can invite members and assign workspace roles; users who belong to several businesses switch organizations explicitly.

## Product flow

```mermaid
flowchart LR
    A[Email, upload, portal, bucket, ERP] --> B[Immutable evidence]
    B --> C[Extraction and confirmation]
    C --> D[Vendor and three-way match]
    D --> E[Agent recommendation]
    E --> F[Deterministic treasury policy]
    F --> G[Circle operator wallet]
    G --> H[Arc policy vault or escrow]
    H --> I[Receipt reconciliation]
    I --> J[Balanced ledger and payment advice]
```

## Workspace

The web application separates the operating surface into focused views:

- **Overview** — organization status, live setup state, and immediate next actions.
- **Notifications** — invoice, approval, agreement, settlement, and failure events.
- **Approval inbox** — payment-limit exceptions, payout-wallet changes, and milestone evidence with exact role and expiry context.
- **Exceptions & recovery** — payment, liquidity, agreement, reconciliation, intake, provisioning, and worker failures with safe next actions.
- **Payment calendar** — unpaid invoices, recurring renewals, and escrow milestones with schedule explanations and projected operating liquidity.
- **Getting started** — owner wallet, Circle operator, contract deployment, funding, inbox, and integration setup.
- **Invoices & vendors** — vendor records, payout verification, evidence intake, matching, decisions, overrides, and execution.
- **Agreements** — recurring mandates and milestone escrow from draft through completion.
- **Treasury & controls** — balances, commitments, forecasts, policy limits, pause controls, vendor authorization, and recovery.
- **Email inbox** — configured address, forwarding guidance, received messages, attachments, and processing state.
- **Integrations** — self-service Odoo and ERPNext connection tests, standard evidence mapping, sync status, imported records, audited disconnects, and settlement writeback.
- **Team** — organization membership and roles.

## Architecture

| Layer | Technology | Responsibility |
|---|---|---|
| Web | Next.js 16, React 19, Privy | Authentication, onboarding, finance workspace, owner signing |
| API | NestJS 11 on Express | Tenant APIs, evidence, policy, decisions, audit reads |
| Worker | Nest application context | Provisioning, extraction, payment, liquidity, reconciliation, email delivery |
| Data | PostgreSQL 17 with RLS | Source-of-truth state, idempotency, outbox, lineage, ledger |
| Documents | Railway Storage Bucket / local MinIO | Private evidence objects and watched-folder intake |
| Wallets | Circle Developer-Controlled Wallets | Organization operator wallets and restricted transaction submission |
| Contracts | Solidity 0.8.30, Foundry, OpenZeppelin | Tenant vault policy, recurring mandates, direct payments, milestone escrow |
| Networks | Arc Testnet with Circle CCTP/Gateway adapters | Primary execution and controlled liquidity movement |

The API and worker use the same domain rules and database. There is no privileged AI-only write path.

## Network scope

Arc Testnet is the authoritative contract and treasury network for the current release. The factory, deployer, and tenant contract path are deployed and source-verified.

The backend includes restricted adapters and reconciliation for Arc Testnet → Base Sepolia USDC liquidity using Circle Gateway or CCTP. Base Sepolia USDC → USDT remains disabled unless verified token, router, provider, signer, and minimum-output bindings are supplied. Arbitrum, Celo, Ethereum, Monad, their testnets, and all mainnets remain fail-closed rollout targets. See [the network matrix](contracts/NETWORK_SUPPORT.md) and [future contract-enforced crosschain work](docs/FUTURE_FEATURES.md).

## Run locally

Requirements: Node.js 22, pnpm 10.25, Docker, and Foundry 1.5.1.

```sh
git submodule update --init --recursive
pnpm --dir backend install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
./scripts/dev.sh --worker
```

This starts PostgreSQL, Redis, and MinIO in Docker, then runs the applications directly for readable logs:

- Frontend: `http://localhost:3005`
- API: `http://localhost:3004`
- MinIO console: `http://localhost:9001`

Use `./scripts/dev.sh --skip-docker --worker` when the local services and migrations are already running. Provider-backed flows require the corresponding values described in [backend/.env.example](backend/.env.example); basic UI and deterministic tests do not require every external provider.

## Repository map

```text
backend/     NestJS API, worker, migrations, provider adapters, and runbook
contracts/   Foundry contracts, tests, deployment scripts, ABI exporter, manifests
frontend/    Next.js landing page and authenticated OPES workspace
docs/        PRD/TRD, implementation plan, future scope, demo, and test evidence
scripts/     Local development and repository safety checks
```

Application code imports generated JSON ABIs from `backend/src/abi/` and `frontend/abi/`. The project does not maintain inline ABI fragments.

## Verify the repository

```sh
pnpm --dir backend lint
pnpm --dir backend build
pnpm --dir backend test --runInBand
pnpm --dir backend test:e2e --runInBand

pnpm --dir frontend lint
pnpm --dir frontend test
pnpm --dir frontend build
pnpm --dir frontend test:e2e

forge fmt --root contracts --check
forge build --root contracts --sizes
forge test --root contracts -vvv
node contracts/script/ExportAbis.mjs --check

./scripts/check-secrets.sh
```

Full-stack browser tests use `pnpm --dir frontend test:e2e:fullstack`. Some suites require local services and configured provider test credentials; their setup and evidence requirements are documented in [RELEASE.md](RELEASE.md).

## Deployment

- **Frontend:** Vercel project rooted at `frontend/`, deployed at [opes.maylord.xyz](https://opes.maylord.xyz).
- **API:** Railway service rooted at `backend/`, deployed at [opes.up.railway.app](https://opes.up.railway.app). Public probes are `/health` and `/ready`.
- **Worker:** a second private Railway service from the same backend image with `OPES_PROCESS=worker`.
- **Data:** Railway PostgreSQL attached to both backend services; a private Railway Storage Bucket attached where document jobs need it.
- **Inbound mail:** one signed Resend `email.received` webhook at `/webhooks/resend/inbound`; workspaces configure addresses under the approved inbound domain.

Exact service variables, least-privilege placement, backups, recovery, Resend, Odoo, and ERPNext setup are in the [backend runbook](backend/RUNBOOK.md).

The backend serves interactive API documentation at [`/docs`](https://opes.up.railway.app/docs) and machine-readable OpenAPI JSON at [`/docs/openapi.json`](https://opes.up.railway.app/docs/openapi.json) after this release is deployed.

## Verified Arc deployment

- [`OrganizationFactory` — `0x6B3a…a488`](https://explorer.testnet.arc.io/address/0x6B3aa0d68Fba3Ff8add42071ba82E714b5a6a488)
- [`VaultDeployer` — `0x0E44…74D8`](https://explorer.testnet.arc.io/address/0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8)

The [deployment manifest](contracts/deployments/5042002/factory.json) records constructor inputs, compiler settings, bytecode hashes, and verification evidence. The [tenant smoke manifest](contracts/deployments/5042002/tenant-smoke-2026-10-04-1791147064.json) records a factory deployment, direct payment, escrow funding, milestone approval, release, and final balances.

## Security model

- The model never signs or authorizes a financial transaction.
- Money is represented in integer atomic units.
- Contracts start paused and deny spending until the owner configures explicit limits.
- Payee, amount, obligation, expiry, evidence context, and replay identifiers are bound into authorization hashes.
- Every provider submission is idempotent and reconciled before retry.
- Tenant isolation is enforced in request context, queries, row-level security, storage keys, jobs, wallets, and contract bindings.
- Mainnet and unverified routes fail closed.

This repository is testnet software. Current live-proof gaps and external deployment gates are listed without inflation in [RELEASE.md](RELEASE.md).
