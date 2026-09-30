# OPES contracts

C0 establishes the local test harness. Vault and escrow implementation follow separately.

## Build and test

Pinned settings: Foundry v1.5.1, Solidity 0.8.30, Cancun EVM, optimizer enabled with 200 runs. forge-std v1.17.0 is vendored with its revision in `foundry.lock`.

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
