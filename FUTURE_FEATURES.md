# Future features

## Contract-enforced multichain payouts

Status: deferred. The current MVP uses the verified Arc tenant factory and same-chain vault/escrow contracts, then controls multichain payout routes in the backend and wallet layer. This keeps implementation moving while preserving the user requirement that OPES can route Base USDC to an approved destination token such as Arbitrum USDT without manual bridge/swap steps.

The deferred onchain version is still useful, but it is not required before backend work continues. When this is promoted, build it as a new verified contract version, not a mutation of the deployed Arc testnet factory.

Required future work:

- Add source-chain spending contracts only on chains where OPES needs contract-level custody and replay enforcement beyond wallet/provider restrictions.
- Add destination executors that authenticate CCTP messages, hold minted USDC, perform approved exact-output swaps, deliver the requested token, and recover leftovers.
- Bind each route to organization, obligation, source chain/token/account, destination chain/token/recipient, exact payout, maximum source debit, fees, slippage, expiry and refund destination.
- Keep CCTP as USDC transport only. Token conversion remains a separate approved swap step; a bridge mint is not vendor settlement.
- Export every new ABI through the existing ABI exporter into both `backend/src/abi/` and `frontend/abi/`; never use inline ABI fragments.
- Deploy and source-verify every new factory/executor version before activation, with manifests keyed by environment and chain ID.
- Add tests for replay, changed recipients, wrong token variants, domain 0, mainnet/testnet separation, duplicate messages, swap failure after mint, leftover recovery and recurring-payout boundaries.

Backend and wallet controls remain mandatory even after future contracts exist: database reservations, idempotency, signer policy, route capability checks, nonce reconciliation and ledger postings are the system of record for orchestration and accounting.
