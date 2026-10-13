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

`MIGRATION_DATABASE_URL` belongs only on the API pre-deploy environment and uses the Railway database owner. `DATABASE_URL` on both running services must use a separate `opes_runtime` login created with `NOSUPERUSER NOBYPASSRLS`. Before the first deploy, create that login with a generated password; the migration runner grants its table, sequence, function, and default privileges after each rollout. Never run the application with the Railway database owner URL because PostgreSQL superusers bypass tenant RLS.

## Required live services

The API and worker are separate Railway services from the same `backend/` root:

- API: `pnpm start:prod`
- Worker: `pnpm start:worker:prod`

Use `railway.api.json` as the API service config path and `railway.worker.json` as the worker config path. Both services use `backend/` as their repository root and the same Dockerfile. Only the API gets a public domain. The API must return HTTP 200 from `/ready` before Railway cuts traffic over.

Required Railway resources:

- PostgreSQL for `DATABASE_URL`
- Redis only when a later queue feature uses it
- Railway Storage Bucket for invoice/evidence bytes
- Private environment variables from `backend/.env.example`

The frontend is a separate Vercel project rooted at `frontend/`. Set `NEXT_PUBLIC_OPES_API_URL` to the Railway API origin, set the public Privy app ID, and add the exact Vercel production/preview origins to both `OPES_ALLOWED_ORIGINS` and the Privy application settings.

## Service variable boundaries

- Vercel: `NEXT_PUBLIC_OPES_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`
- API: runtime database URL, migration database URL, Privy server secret, operations token, storage credentials, DeepSeek key, allowed origins
- Worker: runtime database URL, Circle credentials, RPC/provider/signer credentials, storage credentials when extraction jobs consume them
- PostgreSQL: no application or provider secrets

Generate independent high-entropy values for the runtime database password, operations token, signer token, and webhook secret. Rotate one credential at a time, redeploy the consuming service, verify `/ready` and `/operations/outbox`, then revoke the old value. Circle entity-secret recovery material stays outside Railway and the repository.

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

Alert when `/ready` fails, when a worker deployment exits repeatedly, or when `/operations/outbox` reports `failed > 0`, `staleProcessing > 0`, or an increasing `oldestPendingSeconds`. Use the hosting monitor or an external HTTPS monitor; the operations bearer token must be stored as its secret header.

## Backup and restore drill

Enable scheduled Railway volume backups and PITR before production money movement. At every release candidate, also test a logical dump against a disposable database:

```sh
railway connect postgres --tunnel-only
pg_dump "$DATABASE_PUBLIC_URL" --format=custom --no-owner --file=/tmp/opes-release.dump
createdb opes_restore_check
pg_restore --no-owner --dbname=opes_restore_check /tmp/opes-release.dump
psql opes_restore_check -c 'SELECT count(*) FROM opes.schema_migrations'
dropdb opes_restore_check
```

Use the Railway tunnel instead of the public URL when available. A successful dump is not evidence until the restore and migration count succeed.

## Restart and recovery drill

1. Create a low-value testnet payment and wait until its outbox item is `PENDING` or `PROCESSING`.
2. Restart the worker without editing the row.
3. Confirm the worker reclaims stale `PROCESSING` work after five minutes or consumes the pending row once.
4. Confirm one provider submission, one transaction identity, one final settlement, and balanced ledger postings.
5. Repeat an API restart while the worker continues; the browser must reload the same execution state.

Do not recover by deleting an outbox, execution, ledger, or chain-movement row. Preserve the original failure and append the explicit retry/recovery evidence.

## Safe demo reset

Create a new organization and new idempotency keys for each rehearsal. The fixture cleanup command may remove only records whose identifiers it created in a local or CI database. Never run fixture cleanup against Railway, delete financial evidence, reuse an obligation key, or rewind a reconciliation cursor to make a demo appear successful.

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
