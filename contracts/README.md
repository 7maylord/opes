# OPES contracts

C0 establishes the local test harness. C1 implements vault policy and owner controls; C2 adds authorized direct payments; C3 adds recurring mandates; C4 adds escrow agreements and funding; C5 adds milestone release, disputes and refunds. C6 adds financial sequence, reentrancy and boundary checks. Deployment gates remain pending.

## Organization factory

`OrganizationFactory` creates a full, separate vault and escrow for each nonzero organization domain. Only a platform account with `PROVISIONER_ROLE` can create a pair, preventing outsiders from reserving another tenant's identity. The provisioning service must derive the domain from the immutable organization ID/environment and authenticate the requested roles. Factory admin can rotate provisioners; it has no tenant custody authority. Tenant ownership is assigned directly in constructors, never temporarily to the factory.

The provisioner sends and pays for the creation transaction, so tenant wallets need no deployment gas balance. An identical request returns the registered pair without changing its state; changed initial configuration for the same domain fails. An initial operator cannot be registered for another organization in this factory. Initial configuration hashes and operator reservations remain historical; backend role-rotation/resource-binding checks must enforce ongoing uniqueness. Any deployment failure rolls back the entire pair and registration.

Escrow starts with the supplied owner as admin/approver and the supplied operator/pauser roles. Both contracts start paused, with vault limits at zero. The owner must configure the vault's escrow allowlist, limits and vendors before activation; paying deployment gas gives the provisioner no permission to do that. Pausing both contracts remains two separate authorized calls.

One factory-owned `VaultDeployer` helper separates creation code to keep runtime sizes below 24,576 bytes. Only its immutable factory can call it. There are no proxies, upgrade hooks, arbitrary deployment bytecode or shared customer balances. Verify factory, helper and each tenant instance, recording constructor arguments and events in manifests. A factory address must be allowlisted per chain/environment by the application.

Onboarding automation is backend B2 work: create/reconcile the wallet and distinct owner/operator bindings → submit or reconcile factory creation → verify deployed source/bindings → enter `SETUP_REQUIRED`. Signup is asynchronous. If the provisioner's gas budget is insufficient, keep a visible pending reason, alert operations and retry after funding; unknown submissions must be reconciled against the registry before another attempt. Never label a tenant active before verification and configuration. Sponsorship must have authenticated signup, rate limits, per-tenant/platform budgets and balance monitoring.

For now the intended deployment sponsor is an OPES-funded provisioner. [Circle Gas Station](https://developers.circle.com/wallets/gas-station) also documents Arc support for compatible ERC-4337 Circle wallets; validate account type and sponsorship policy during wallet integration. Neither mechanism supplies customer invoice funds. Later owner/operator actions also need funded gas or compatible sponsorship. The factory and helper are deployed and source-verified on Arc testnet; backend signup wiring and sponsored tenant provisioning remain pending.

## Milestone release and refunds (C5)

Approvers record a nonzero decision/evidence commitment against an agreement and milestone with an exclusive expiry no later than its completion deadline. Operators release the immutable allocation to the immutable payee. Approval must remain live, its approver must still hold the role, and sequential agreements require prior allocations released. Operators cannot hold admin or approver roles; payees cannot approve their own milestones. The initial admin also holds the approver role; role rotation must explicitly revoke old approvers. Admin renunciation is disabled.

Evidence interpretation and decision-hash validation belong to the deterministic backend, never an LLM signer. Resubmission must confirm `invalidateMilestoneApproval` before queuing a replacement decision; the contract cannot observe offchain evidence changes. Release reads only the stored acceptance and cannot substitute its amount, payee or evidence. Approval and completion expiry both block release.

Payees or admins may dispute pending/accepted milestones, holding the allocation. Admin resolution either makes it refundable or resets it to pending for fresh approval. Cancellation makes pending/accepted allocations refundable while preserving disputes and completed transfers. Refunds require cancellation and return only explicitly refundable allocations to the bound vault; resolving a hold later allows another refund with a new key. Cancelled agreements cannot resume releases. Global and agreement pauses block funding, release and refund; dispute, cancellation and approval invalidation remain available. Transfer failure rolls back state, totals and replay keys atomically. Funding alone consumes vault spending limits; releases/refunds do not charge them again or replenish them.

Held/refundable balances and terminal status derive from the at-most-five milestone states and fixed amounts. Backend reconciliation must separately confirm cancellation and resolve pending/unknown submissions before refund execution.

## Escrow funding (C4)

Each escrow binds to one vault and inherits its token and organization domain. Its initial admin must be that vault's owner. Admin-created agreements have 1–5 positive milestone allocations, immutable criteria/terms/payee and refund-to-vault destination, and ordered future funding/completion deadlines. Funding must arrive strictly before the funding deadline; releases must precede the completion deadline.

The vault owner allowlists matching escrow instances and approves each exact funding decision, including amounts within the autonomous limit. Hash schema 1 uses action `uint8(3)`, recipient = escrow, and the agreement ID; mandate/cycle fields are zero. Spending limits apply to the stored payee. The escrow pulls exactly the approved total; balance-delta validation, replay state, approval consumption and both contracts' accounting roll back together on failure. Allowance is cleared after success. A vault-wide agreement ID cannot fund twice, even through another escrow. `PaymentExecuted` identifies the beneficiary; `EscrowFunded` identifies the actual custody destination. Funding is restricted-asset movement, not vendor settlement or expense.

## Recurring mandates (C3)

Owners register immutable schedules of 1–24 strictly increasing UTC due timestamps and unique stable obligation keys. The backend calculates calendar/timezone periods; the contract enforces stored timestamps, per-cycle and total caps. Payment is allowed at the due timestamp and strictly before the mandate end. Owners can pause/resume or permanently cancel. Replacing a schedule requires cancellation and a new ID; only unpaid keys can be reused. Registered recurring keys cannot execute through the direct-payment route.

Recurring hashes use schema 1 with action `uint8(2)`, the stored vendor/key, mandate ID and cycle index; the agreement field stays zero. Recurring and direct payments share daily/vendor accounting, replay protection, exceptional approvals and token transfer logic. Mandate approval does not waive the exact-decision approval required above the autonomous threshold. Financial failure rolls back mandate totals as well as shared payment state.

`OWNER_ROLE` aliases OpenZeppelin's `DEFAULT_ADMIN_ROLE`: one owner, two-step acceptance, initially zero transfer delay. Owner renunciation is disabled to preserve recovery access. Operators cannot hold owner authority, including after owner transfer. Owners manage vendor policies and limits, can pause/unpause, and can recover only while paused to the immutable destination. Pausers can stop execution but cannot resume it. Limits start at zero; no vendor starts allowlisted. Deployment configuration must verify the official USDC/network and organization bindings; a six-decimal check alone cannot establish token identity. Recovery reconciliation remains a backend responsibility.

## Build and test

Pinned settings: Foundry v1.5.1, Solidity 0.8.30, Cancun EVM, optimizer enabled with 200 runs and IR compilation. IR compilation accommodates the full decision-binding payload; use the same setting during source verification. forge-std v1.17.0 is vendored with its revision in `foundry.lock`.

## Direct payments (C2)

Only operators execute, only when unpaused. Owner approval above the autonomous limit does not bypass single, vendor-daily or organization-daily caps. Days are UTC (`timestamp / 86400`); expiry is exclusive. Approval records bind the approving owner and expire; owner transfer invalidates previous-owner approvals. Execution consumes the stable obligation key and approval before transfer, with atomic rollback on failure. The backend must derive that key from the genuine obligation: the contract cannot recognize two arbitrary keys as the same invoice.

Decision hash schema 1 is `keccak256(abi.encode(...))` with these ordered types/values: `uint256(1), uint256(chainId), address(vault), bytes32(organizationDomain), address(token), uint8(1), bytes32(obligationKey), address(vendor), uint256(amount), uint64(expiresAt), bytes32(0), bytes32(0), uint32(0), bytes32(contextHash)`. The three zero fields reserve agreement, mandate and cycle identifiers. No packed encoding. The test independently encodes this payload; backend parity vectors are required at B6. `idempotencyKey` must equal `obligationKey`. Evidence/policy-context validation stays in the backend; the contract verifies the commitment and current onchain policy.

OpenZeppelin v5.7.0 is pinned as a Git submodule. After cloning, initialize it from the repository root:

```sh
git submodule update --init --recursive
```

The gitlink and `foundry.lock` pin revision `cab19933c33c2ad1d4c7a84864a3601dddfd16f3`. No implicit upgrades.

Run from the repository root:

```sh
forge fmt --root contracts --check
forge build --root contracts
FOUNDRY_PROFILE=ci forge test --root contracts -vv
```

CI lives in the root `.github/workflows/` so GitHub discovers it.

## Fixtures

`MockUSDC` extends OpenZeppelin ERC20 with six decimals, test-only minting and false-return/revert failures for both transfer methods. `OrganizationFixture` supplies distinct owners/operators and balances. These tests verify token behavior, not yet vault authorization or application tenant isolation. Mocks remain under `test/`; never deploy them as USDC.

## Financial security checks (C6)

`FinancialSequencesTest` fuzzes 64-action histories spanning funding, direct/recurring payments, milestone decisions, disputes, cancellation, refunds, pause, recovery and time advancement. Independent totals check conservation and payee/recovery attribution after each action; wrong-tenant calls must fail, repeated movement keys cannot succeed, and reverted calls preserve balances, approval and replay state. CI runs 1,000 histories. This bounded test uses one agreement, two recurring cycles and one UTC day; separate boundary tests cover funding, approval/completion expiry, recurring due/end times and daily rollover. `ReentrancyTest` uses a hostile callback token to test direct, recurring, funding, release, refund and recovery paths. Callbacks hold execution authority (or owner authority for recovery), and assertions require the exact reentrancy-guard error. The funding callback also checks the escrow guard before its vault-only body check. These local tests are bounded checks, not a formal proof or live-token compatibility test.

## Arc runtime gate

Prepare the deployment configuration from the repository root:

```sh
cp -n contracts/.env.example contracts/.env
```

The template contains the factory deployment signer, fixed USDC token, platform factory admin/provisioner and public RPC/verification defaults. Organization domains and tenant role addresses are per-signup factory arguments, not global environment variables. Circle application credentials are not required for direct Foundry deployment or public Blockscout verification. Defaults follow the [official deployment guide](https://docs.arc.io/arc/tutorials/deploy-on-arc) and [USDC interface reference](https://docs.arc.io/integrate/infrastructure/indexing-events). Deployment manifests record factory/helper addresses and each tenant pair.

`script/DeployFactory.s.sol` rejects any chain except Arc testnet (5042002), any token except its official USDC, and missing platform roles. It reads the signer internally from the environment. From `contracts/`, load your trusted `.env`, then simulate:

```sh
set -a
source .env
set +a
forge script script/DeployFactory.s.sol:DeployFactory --rpc-url "$ARC_TESTNET_RPC_URL"
```

Before broadcasting, check the signer balance/nonce and ask Arc RPC `eth_estimateGas` and `eth_call` to simulate the exact creation bytecode with encoded constructor arguments. Append `--broadcast` only for the intended deployment. Save the receipt immediately; if submission times out, reconcile its hash and signer nonce before retrying. `broadcast/` and `cache/` are ignored and may contain sensitive signing data; never commit them. Verify factory and helper separately using `forge verify-contract --chain-id 5042002 --verifier blockscout --verifier-url "$ARC_VERIFIER_URL" --watch`, their source identifiers and encoded constructor arguments. Factory arguments are `(token, admin, provisioner)`; helper arguments are `(token)`.

Current contracts settle USDC on their deployed chain. They do not execute CCTP transfers or token swaps. The user requires autonomous Base USDC → Arbitrum USDT payouts; PRD v1.5 §11.8.1 now supersedes the earlier inbound-only CCTP scope. The agent selects an allowed route, source/destination contracts enforce authorization and execute transfers/swaps, and the Railway worker handles quotes, attestations, transaction submission and resumable reconciliation. Existing CCTP and swap infrastructure supply those operations; OPES does not build a bridge or DEX. An Arc custody hop is not inherently required for this route.

Crosschain authorization must bind the organization/obligation, chain/token/recipient, exact payout, maximum spend and fees, expiry and permitted executors. A completed burn or mint is not a completed vendor payment. A failed destination swap leaves controlled destination funds to reconcile/retry/recover, never a reason to burn again. C7a is specified in [the crosschain design](CROSSCHAIN_DESIGN.md), with [read-only provider evidence](references/crosschain-route-check.json). The [required network matrix](NETWORK_SUPPORT.md) expands scope to Arbitrum, Base, Arc, Celo, Ethereum and Monad plus their testnets. CCTP V2 covers five chain families; Celo transport remains a required open integration. Direct/recurring routes use plain USDC delivery or verified exact-output swaps, with explicit token acceptance and labeled testnet assets; crosschain milestones remain disabled. C7b–C7c must implement/test this design before new versions are deployed and source-verified. Existing ABIs and tests cover the same-chain implementation only.

Cancun is an explicit compiler target, not proof of Arc compatibility. Standard Foundry can deploy and verify on Arc. Arc Foundry's `arc-forge test --network arc` additionally runs the local suite under Arc execution rules; it is not installed here. For this testnet deployment, use standard Foundry tests plus live Arc-node creation simulation, gas estimation and post-deployment checks. This replaces the earlier mandatory installation gate; it does not claim that the Arc-specific local suite ran. Tenant payment/escrow smoke tests and source verification remain separate checks.

Both deployed contracts must be source-verified before activation; see `docs/IMPLEMENTATION_PLAN.md`.

## Application ABI exports (C7)

Run from the repository root with Node.js and Foundry already installed:

```sh
node contracts/script/ExportAbis.mjs
node contracts/script/ExportAbis.mjs --check
```

The script compiles first, then exports the complete ABI arrays for `BusinessPolicyVault`, `MilestoneEscrow`, `OrganizationFactory` and OpenZeppelin's `IERC20Metadata` (ERC-20 transfers, balances, allowances and metadata). Identical JSON files live in `frontend/abi/` and `backend/src/abi/`, including compiled events and errors. Commit regenerated files alongside contract changes. `--check` is read-only for exports and fails on any missing or stale file; CI runs it. No packages are required for export.

Frontend consumers import, for example, `vaultAbi` from `@/abi/BusinessPolicyVault.json`; backend services under `src/` import it from `./abi/BusinessPolicyVault.json` (adjust the relative path for nested services). Both TypeScript configurations support JSON imports. Use these files for contract calls and event/error decoding; never write inline ABI fragments. Contract addresses come from verified deployment bindings, separately from ABIs. Consumer wrappers and their function/event checks are implemented with the backend/frontend features.

## Arc testnet deployment — 2026-10-02

Factory: [`0x6B3aa0d68Fba3Ff8add42071ba82E714b5a6a488`](https://explorer.testnet.arc.io/address/0x6B3aa0d68Fba3Ff8add42071ba82E714b5a6a488). Helper: [`0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8`](https://explorer.testnet.arc.io/address/0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8). Both are fully source-verified. [Manifest](deployments/5042002/factory.json) records constructor inputs, source commit, compiler settings, ABI/runtime hashes and receipt evidence.

Transaction `0xebab0843affef9717dbe32cfaf3b17187456272208fdd1ba9f5fb5be7a5e881e` succeeded in block 65091595, consuming 7,382,296 gas (0.23992462 test USDC). Factory/helper bytecode and immutable/platform-role bindings were checked against the compiled artifacts and deployment configuration. This deploys the same-chain factory only; tenant provisioning/payment/escrow smoke tests and crosschain executors remain pending.
