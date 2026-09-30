# OPES contracts

C0 establishes the local test harness. C1 implements vault policy and owner controls; C2 adds authorized direct payments; recurring payments and escrow follow separately.

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

## Arc runtime gate

Cancun is an explicit local target, not proof of Arc compatibility. Before deployment, confirm settings for the actual target network and run the Arc runtime suite. The [Arc deployment guide](https://docs.arc.network/arc/tutorials/deploy-on-arc) specifies `arc-forge test --network arc`; Arc Foundry is not installed here. Installation and runtime checks remain deployment prerequisites. Local tests do not establish live compatibility or source verification.

Deployment and ABI export are later checkpoints. Both deployed contracts must be source-verified before activation; see `docs/IMPLEMENTATION_PLAN.md`.
