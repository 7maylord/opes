# OPES contracts

C0 establishes the local test harness. C1 implements vault policy and owner controls; C2 adds authorized direct payments; C3 adds recurring mandates; C4 adds escrow agreements and funding; C5 adds milestone release, disputes and refunds. C6 adds financial sequence, reentrancy and boundary checks. Deployment gates remain pending.

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

The template contains only a direct-deployment signer, the existing vault constructor inputs, and public RPC/token/verification defaults from the [official deployment guide](https://docs.arc.io/arc/tutorials/deploy-on-arc) and [USDC interface reference](https://docs.arc.io/integrate/infrastructure/indexing-events). Owner, pauser and recovery may share the owner address for test deployment; the operator must be separate. Circle application credentials are not required to deploy with Foundry or verify on Blockscout. Deployment addresses belong in the generated manifest. This template does not choose the production wallet/provider architecture; deployment scripts, Arc runtime checks and source verification remain pending.

Current contracts settle USDC on their deployed chain. They do not execute CCTP transfers or token swaps. The user requires autonomous Base USDC → Arbitrum USDT payouts; PRD v1.5 §11.8.1 now supersedes the earlier inbound-only CCTP scope. The agent selects an allowed route, source/destination contracts enforce authorization and execute transfers/swaps, and the Railway worker handles quotes, attestations, transaction submission and resumable reconciliation. Existing CCTP and swap infrastructure supply those operations; OPES does not build a bridge or DEX. An Arc custody hop is not inherently required for this route.

Crosschain authorization must bind the organization/obligation, chain/token/recipient, exact payout, maximum spend and fees, expiry and permitted executors. A completed burn or mint is not a completed vendor payment. A failed destination swap leaves controlled destination funds to reconcile/retry/recover, never a reason to burn again. Concrete provider/token support, authenticated source-to-destination execution, arrangement compatibility and per-asset accounting must be specified in C7a, implemented/tested in C7b–C7c, then deployed and source-verified. Existing ABIs and tests cover the same-chain implementation only.

Cancun is an explicit local target, not proof of Arc compatibility. Before deployment, confirm settings for the actual target network and run the Arc runtime suite. The [Arc deployment guide](https://docs.arc.network/arc/tutorials/deploy-on-arc) specifies `arc-forge test --network arc`; Arc Foundry is not installed here. Installation and runtime checks remain deployment prerequisites. Local tests do not establish live compatibility or source verification.

Both deployed contracts must be source-verified before activation; see `docs/IMPLEMENTATION_PLAN.md`.

## Application ABI exports (C7)

Run from the repository root with Node.js and Foundry already installed:

```sh
node contracts/script/ExportAbis.mjs
node contracts/script/ExportAbis.mjs --check
```

The script compiles first, then exports the complete ABI arrays for `BusinessPolicyVault`, `MilestoneEscrow` and OpenZeppelin's `IERC20Metadata` (ERC-20 transfers, balances, allowances and metadata). Identical JSON files live in `frontend/abi/` and `backend/src/abi/`, including compiled events and errors. Commit regenerated files alongside contract changes. `--check` is read-only for exports and fails on any missing or stale file; CI runs it. No packages are required for export.

Frontend consumers import, for example, `vaultAbi` from `@/abi/BusinessPolicyVault.json`; backend services under `src/` import it from `./abi/BusinessPolicyVault.json` (adjust the relative path for nested services). Both TypeScript configurations support JSON imports. Use these files for contract calls and event/error decoding; never write inline ABI fragments. Contract addresses come from verified deployment bindings, separately from ABIs. Consumer wrappers and their function/event checks are implemented with the backend/frontend features.
