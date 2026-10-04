# OPES backend operations runbook

## Release checks

Run these before a Railway/Vercel release:

```sh
pnpm --dir backend lint
pnpm --dir backend build
pnpm --dir backend test --runInBand
pnpm --dir backend test:e2e
DATABASE_URL=<release-database-url> pnpm --dir backend db:migrate
```

Run migrations once as a controlled release step. Do not run migrations from every API or worker replica.

## Required live services

The API and worker are separate Railway services from the same `backend/` root:

- API: `pnpm start:prod`
- Worker: `pnpm start:worker:prod`

Required Railway resources:

- PostgreSQL for `DATABASE_URL`
- Redis only when a later queue feature uses it
- Railway Storage Bucket for invoice/evidence bytes
- Private environment variables from `backend/.env.example`

## Worker queues and dead letters

Workers poll `opes.outbox_events`. A job is recoverable when it is `PENDING`, or when it has been `PROCESSING` for more than five minutes. This protects against worker crashes after claim but before completion.

Check queue health:

```sh
curl -H "Authorization: Bearer $OPES_OPERATIONS_TOKEN" \
  https://<api-host>/operations/outbox
```

Investigate any queue with:

- `failed > 0`
- `staleProcessing > 0` for more than one worker poll interval
- `oldestPendingSeconds` increasing while the worker is healthy

Failed rows keep `payload.failureReason`. Do not manually mark failed money movement rows as processed; repair the missing signer/RPC/provider configuration, then create an explicit recovery migration or replay command for the affected aggregate.

## Financial workflow evidence

Local tests and fixtures prove deterministic backend behavior only. Live proof must be labeled separately and include:

- organization id and environment
- relevant action/execution ids
- transaction hashes and explorer links
- ledger event ids
- signer/provider references, redacted where needed

CCTP/Gateway delivery or Base swaps are not vendor payment by themselves. A payable is settled only after the payment execution or later payout flow records final recipient settlement and balanced ledger entries.

## Common failures

- `Payment signer adapter is not configured`: set `OPES_PAYMENT_SIGNER_URL` and token if required.
- `OPES_RPC_<ENVIRONMENT> is not configured`: add the chain RPC URL used for receipt reconciliation.
- `Base USDC to USDT swap route is not configured`: set the Base token/router/provider variables and minimum-output bps.
- Gateway jobs stay pending: verify the external signer implements Circle Gateway intent submission and status lookup.
