# Hackathon release gate

Checked against the organizer page on 2026-10-12. Submission closes October 17, 2026 at 11:59 PM ET and requires a public GitHub repository plus a recorded demo under three minutes. A deployed URL is encouraged.

## Capability statement

| Capability | Release status | Evidence |
|---|---|---|
| Arc Testnet tenant contracts | Verified | Sanitized factory and tenant manifests in `contracts/deployments/5042002/` |
| Arc same-chain USDC policy, payment, recurring, escrow, recovery | Implemented | Contract, API, database, and browser gates |
| Arc Testnet → Base Sepolia USDC | Implemented; live release receipt required | CCTP/Gateway worker and per-leg reconciliation tests |
| Base Sepolia USDC → USDT | Disabled by default | Requires verified token, provider, router, pool/liquidity, and live swap receipt |
| Arbitrum, Celo, Ethereum, Monad | Registry targets only | Exact routes remain blocked pending wallet, gas, RPC, provider, and receipt evidence |
| Any mainnet route | Disabled | Separate owner authorization and rollout required |

Fixtures, sandbox actions, and testnet volume must not be reported as customer traction.

## External release evidence still required

- Railway and Vercel infrastructure were observed live on 2026-10-15: `opes-api`, `opes-worker`, `PostgresOpes`, and `opesbucket` exist; `/health`, `/ready`, and `https://opes.maylord.xyz` return HTTP 200; production CORS permits the frontend origin.
- Push and deploy the six commits after hosted commit `bdb8a17`; the live API and worker do not yet contain the current local `main`.
- Add `OPES_RESEND_API_KEY` and the Resend-generated `OPES_RESEND_WEBHOOK_SECRET` to `opes-api`, then record a signed `email.received` ingestion.
- Add the Circle, RPC, CCTP/Gateway, DeepSeek, and signer variables required by its jobs to `opes-worker`; only database and bucket variables were present when checked.
- Complete one Odoo or ERPNext sandbox synchronization and settlement writeback.
- Authenticated two-tenant production run with isolation proof
- Arc payment and matching ledger transaction evidence
- Arc Testnet → Base Sepolia receipt, reconciliation, and worker restart proof
- Railway backup/PITR configuration and restore drill against the hosted database
- Public repository URL, real business/adoption metrics, and the recorded demo URL

Record each live item with timestamp, environment, organization identifier, transaction/explorer link, ledger event identifier, and redacted provider reference. Never paste a secret, private key, bearer token, or signed transaction payload into this file.
