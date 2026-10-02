# Required network support

Updated 2026-10-02 following the user's six-chain requirement. All twelve environments below are product targets. This is a requirements/provider matrix, not a claim that OPES has deployed or enabled every route. The only recorded OPES deployment is the Arc testnet same-chain factory/helper.

## Network identities

| Network | Environment | Chain ID | Gas token | CCTP domain | Official USDC |
|---|---|---:|---|---|---|
| Arbitrum One | mainnet | 42161 | ETH | 3 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Arbitrum Sepolia | testnet | 421614 | ETH | 3 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Base | mainnet | 8453 | ETH | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia | testnet | 84532 | ETH | 6 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Arc | mainnet | 5042 | USDC | 26 | `0x3600000000000000000000000000000000000000` |
| Arc Testnet | testnet | 5042002 | USDC | 26 | `0x3600000000000000000000000000000000000000` |
| Celo | mainnet | 42220 | CELO | unavailable | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` |
| Celo Sepolia | testnet | 11142220 | CELO | unavailable | `0x01C5C0122039549AD1493B8220cABEdD739BC44E` |
| Ethereum | mainnet | 1 | ETH | 0 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Ethereum Sepolia | testnet | 11155111 | ETH | 0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Monad | mainnet | 143 | MON | 15 | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| Monad Testnet | testnet | 10143 | MON | 15 | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |

USDC addresses are from [Circle's token registry](https://developers.circle.com/stablecoins/usdc-contract-addresses). Network references: [Arc](https://docs.arc.io/arc/references/connect-to-arc), [Celo](https://docs.celo.org/build-on-celo/network-overview), [Monad](https://docs.monad.xyz/ai/current-facts), [Base](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments), [Arbitrum](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments), [Ethereum/Sepolia](https://ethereum.org/en/developers/docs/networks/). Recheck chain ID and token decimals/code through each configured RPC before activation. Celo Sepolia replaces Alfajores; do not copy Alfajores addresses into it. Ethereum Sepolia is the application testnet target, not a validator testnet.

CCTP domains follow [Circle's support table](https://developers.circle.com/cctp/concepts/supported-chains-and-domains). Domain **0 is Ethereum**, not an unavailable-provider sentinel. Model unavailable CCTP as null/absent capability. Domains and even contract addresses repeat between mainnet and testnet, so neither is an environment identifier. Reject every route whose source and destination environments differ.

## Required capabilities and provider gaps

Same-chain tenant custody, policy, direct/recurring USDC payments and escrow are required on all twelve environments. Crosschain USDC funding/payouts in both directions are required across the six-chain set, with a compatible verified transport for each route. Token conversion is a separate capability per destination token, router and pool; chain support does not imply support for every token.

| Chain family | USDC crosschain transport | Destination swap evidence / activation work |
|---|---|---|
| Arbitrum | CCTP V2 documented for mainnet/testnet | V3 router published for both; existing read-only quote evidence covers Arbitrum One USDC→USDT0 only. Testnet target/pool still needed. |
| Base | CCTP V2 documented for mainnet/testnet | V3 router published for Base and Base Sepolia; token acceptance, pool/liquidity and execution checks still required. |
| Arc | CCTP V2 documented for mainnet/testnet | No Arc V3 deployment established from the reviewed Uniswap list. USDC payout mode must work without a swap; conversion stays pending provider/pool verification. |
| Celo | **Not listed by CCTP** for either environment | V3 mainnet listed; published testnet table is Alfajores, not Celo Sepolia. Select/verify Celo Sepolia swap infrastructure separately. |
| Ethereum | CCTP V2 documented for mainnet/Sepolia | V3 router published for mainnet and Sepolia; per-token pool/liquidity and execution checks still required. |
| Monad | CCTP V2 documented for mainnet/testnet | V3 mainnet listed; testnet router/token/pool bindings not established in this review. |

Swap references: [Arbitrum](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments), [Base](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments), [Ethereum](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments), [Celo](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-celo-deployments), [Monad](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments), [deployment index](https://developers.uniswap.org/docs/protocols/v3/deployments). A published deployment is not a liquidity or successful-transaction guarantee. This review did not send transactions or perform new twelve-network RPC tests; earlier [RPC evidence](references/crosschain-route-check.json) retains its original limited scope.

For the five CCTP chain families, use V2 Standard transfers and the existing exact-message authorization design. The common provider addresses in [Circle's deployment registry](https://developers.circle.com/cctp/references/contract-addresses) must still be checked per chain/environment. Monad testnet's upfront-fee limitation does not require changing this direct Standard-transfer design; do not introduce the fee wrapper by assumption.

**Celo stays required.** Its bridge selection is a new C7a-Celo gate, not a silently dropped chain. [Celo's bridge directory](https://docs.celo.org/tooling/bridges/bridges) is a starting point, not approval of a transport. Before selecting one, establish mainnet and Celo Sepolia deployments, both-direction native-USDC compatibility, sender/message authentication, destination-call restrictions, actual token received, fees, timeout/recovery and testnet proof. A wrapped-USDC result cannot be substituted for native USDC. Do not invent a CCTP domain, reuse another chain's messenger, or accept arbitrary aggregator calldata. Freeze a transport-specific commitment/interface after this research; the CCTP `Route` schema cannot authorize an unrelated bridge. Until then show the affected routes as pending/unsupported with a reason, while same-chain Celo work can proceed.

## Application and contract changes required

- Use one reviewed registry keyed by environment and chain ID, with explicit custody, CCTP, alternative-bridge and swap capabilities. Keep token addresses/decimals, native gas units, provider bindings, RPC/verifier settings and versioned OPES deployments in it. Missing configuration fails closed. Populate runtime configuration when the owning implementation is built; this document is not executable configuration.
- Deploy an isolated tenant vault/escrow per enabled chain and a tenant destination executor where crosschain receipt is enabled. One destination executor may accept multiple explicitly approved source bindings; do not assume its source is always Base. No global factory address, shared tenant balance or implicit crosschain owner proof.
- Source bindings are immutable records keyed by source chain/domain/vault/token/messenger and organization. Owner can disable new execution for a binding but cannot rewrite or erase a binding needed to receive/recover an in-flight message. Validate against retained binding records before minting. A newly added source receives no authority over earlier intents or funds.
- Keep the destination's chain/domain, local token/transmitter/messenger and tenant identity immutable. Every route binds its specific source and destination identities. Allocate funds by the full source-vault/chain/obligation identity and CCTP nonce; test collisions across source chains and tenants. Backend obligation uniqueness still spans all selected sources.
- Include a USDC payout mode with no router call and a distinct exact-output swap mode. The chosen mode is part of the route hash. A missing swap provider must not prevent a supported plain-USDC route. A crosschain transfer whose source/destination chain is identical is invalid; use existing same-chain execution instead.
- Use ETH gas on Ethereum/Base/Arbitrum, CELO on Celo and MON on Monad; native currencies use 18-decimal atomic units. Arc gas uses 18-decimal USDC while its ERC-20 interface uses six decimals over the same balance. Sponsor funds and treasury principal must remain separate accounts; never sum Arc's native and ERC-20 balances. Initial Celo execution uses CELO gas; alternative fee currencies need their own tested signing/fee configuration.
- Keep all twelve networks visible in the planning/configuration model, but expose execution only after the exact chain/route capability is verified and funded. Tenant enablement must not automatically deploy twelve sets on signup; provision the selected chain first and additional chains when the tenant enables them, preserving the existing sponsored/idempotent flow.
- Backend jobs, transaction hashes, nonce management, cursors, cache/storage bindings, accounting assets and explorer links include environment plus chain ID. Frontend imports exported ABIs and selects addresses by deployed version/chain. Wallet provider support must be checked independently; EVM compatibility alone is not evidence that a particular wallet API supports a chain.

## Completion gates

C7a's original Base→Arbitrum design remains the reference example. The twelve-network requirement supersedes its original scope. The network matrix is documented; Celo transport and missing swap deployments remain open design work. Do not mark expanded multichain support complete merely because a chain appears in a dropdown.

C7b must implement source-binding authorization and USDC/no-swap mode before destination generalization. C7c must exercise all six testnets for same-chain flows, each enabled CCTP direction, multi-source isolation, domain 0, mainnet/testnet separation, gas-token units and missing-provider rejection. Five CCTP networks yield 20 directed chain pairs per environment; test registry coverage for all, use local/fork integration for exhaustive checks, and record live testnet evidence separately. Celo transport tests join that matrix after selection. Existing deployed Arc testnet contracts are not modified by this scope document. Mainnet deployment remains separate from the user's testnet rollout.
