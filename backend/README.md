# OPES backend

NestJS API and persistent worker for tenant policy, Circle wallets, verified contract execution, crosschain liquidity, reconciliation, and ledger/audit reads.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm start:dev
```

The API defaults to port 3004 through `.env.example`. Run `pnpm start:worker` in a second terminal. Production uses the API and worker as separate Railway services from the same Docker image and `railway.json`; set `OPES_PROCESS=worker` only on the worker. See `RUNBOOK.md`.

The production API is [opes.up.railway.app](https://opes.up.railway.app). Its public checks are `/health` and `/ready`; the production browser origin is `https://opes.maylord.xyz`.

Accounting connectors are created through `POST /organizations/:organizationId/accounting-connectors`. Odoo 19 uses the tenant root URL, database name, and one JSON-2 API key; ERPNext uses the site root URL plus an API key and API secret. Setup and request bodies are documented in [RUNBOOK.md](RUNBOOK.md#accounting-sandboxes).
