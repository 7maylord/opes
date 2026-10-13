# OPES backend

NestJS API and persistent worker for tenant policy, Circle wallets, verified contract execution, crosschain liquidity, reconciliation, and ledger/audit reads.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm start:dev
```

The API defaults to port 3004 through `.env.example`. Run `pnpm start:worker` in a second terminal. Production uses the API and worker as separate Railway services from the same Docker image; see `railway.api.json`, `railway.worker.json`, and `RUNBOOK.md`.
