# OracleDesk Smart Contracts

> Autonomous prediction market creation, intelligent cross-chain trading, and
> tamper-evident on-chain reasoning across Arc Testnet and Polygon Mainnet.
> Built for the **Agora Hackathon** — RFB 02 (Trader Intelligence) + RFB 03 (Market Verticals).

---

## System Architecture

```
ARC TESTNET — intelligence, treasury, and reasoning layer
│
├── Layer 1: Market Creation
│   ├── MarketFactory.sol       ← deploys PredictionMarket instances on demand
│   └── PredictionMarket.sol    ← AMM market (dynamic spreads, liquidity rebalancing)
│       ├── ShareToken YES      ← ERC-20 outcome share
│       └── ShareToken NO       ← ERC-20 outcome share
│
├── Layer 2: Trader Agent
│   ├── TreasuryManager.sol     ← USDC bankroll, Kelly limits, CCTP bridge trigger
│   ├── PositionLedger.sol      ← audit trail for all Polymarket bets
│   └── MultiSigOracle.sol      ← 2-of-3 multisig for market resolution
│
└── Layer 3: Reasoning-as-Product
    └── ReasoningRegistry.sol   ← IPFS CID index + subscriber access ledger
        └── emits ReasoningPublished (tamper-evident pre-commitment proof)
        │
        │  Circle Gateway Nanopayments (x402 protocol)
        │  Subscriber pays $0.001 USDC per trace — gasless EIP-3009 signature
        ▼
    ReasoningFeedAPI (Express)  ← serves traces behind x402 payment gate
        │
        │  IPFS (Pinata) ← full trace JSON content
        └──────────────────────────────────────────────────────────────────
                │
                │  Circle CCTP — depositForBurn → attestation → receiveMessage
                │  Arc Domain 26 → Polygon Domain 7 — ~20 second Fast Transfer
                ▼
POLYGON MAINNET — execution layer (existing Polymarket contracts, never deployed by us)
├── CTF Exchange V2             ← agent signs EIP-712 orders, Polymarket settles
├── Conditional Tokens (CTF)    ← ERC-1155 YES/NO outcome shares
└── USDC.e                      ← collateral (funded from Arc via CCTP)
```

**Two chains, one agent.** Capital lives on Arc. CCTP moves USDC to Polygon
in ~20 seconds when a bet fires. Builder fees sweep back to Arc every 6 hours.
Reasoning traces are timestamped on Arc — provably before market resolution.

---

## Repository Structure

```
oracledesk-contracts/
│
├── src/
│   ├── MarketFactory.sol           # Layer 1 — market factory + registry
│   ├── PredictionMarket.sol        # Layer 1 — AMM with dynamic spreads
│   ├── TreasuryManager.sol         # Layer 2 — capital management + CCTP
│   ├── PositionLedger.sol          # Layer 2 — Polymarket position audit trail
│   ├── ReasoningRegistry.sol       # Layer 3 — IPFS index + subscriber ledger
│   ├── MultiSigOracle.sol          # Oracle — 2-of-3 multisig market resolution
│   └── interfaces/
│       └── IPolymarket.sol         # Reference types for EIP-712 order signing
│
├── test/
│   ├── PredictionMarket.t.sol      # Layer 1 tests (AMM, spreads, rebalancing)
│   ├── TreasuryManager.t.sol       # Layer 2 tests (Kelly limits, CCTP, drawdown)
│   └── ReasoningRegistry.t.sol     # Layer 3 tests (publish, access, pagination)
│
├── script/
│   ├── DeployOracle.s.sol          # Deploys MultiSigOracle
│   ├── DeployLayer1.s.sol          # Deploys MarketFactory
│   ├── DeployLayer2.s.sol          # Deploys TreasuryManager + PositionLedger
│   └── DeployLayer3.s.sol          # Deploys ReasoningRegistry
│
├── scripts/                        # TypeScript tooling
│   ├── deploy.ts                   # ← ONE COMMAND: deploys all contracts in order
│   ├── verify.ts                   # Post-deployment health checks
│   ├── export-abis.ts              # Standalone ABI export after forge build
│   ├── test-scan.ts                # Verify market scanner reads Arc
│   ├── test-create-market.ts       # End-to-end market creation test
│   └── test-polymarket-signing.ts  # Verify EIP-712 order signing
│
├── artifacts/                      # Generated — do not edit manually
│   ├── latest.json                 # ← Always points to most recent deployment
│   └── arc-testnet-<timestamp>/
│       ├── addresses.json          # All contract addresses (import in frontend)
│       ├── deployment.json         # Full deployment manifest
│       └── abis/
│           ├── MarketFactory.json
│           ├── PredictionMarket.json
│           ├── TreasuryManager.json
│           ├── PositionLedger.json
│           ├── ReasoningRegistry.json
│           ├── MultiSigOracle.json
│           └── index.json          # Combined ABI index (import all at once)
│
├── foundry.toml
├── package.json
├── .env                            # Never commit — use .env.example as template
└── .env.example
```

---

## Contract Architecture

### Layer 1 — Market Creation (Arc Testnet)

#### `MarketFactory.sol`

Deployed once. Entry point the agent calls to create prediction markets.
Registry of all OracleDesk markets on Arc.

```
Agent backend
    │
    │  createMarket(question, oracle, expiry, initialYesPrice, seed,
    │               confidenceIntervalBps, reasoningCid, sha256Hash)
    ▼
MarketFactory
    ├── validates: no duplicate question, sufficient USDC seed in factory
    ├── deploys: new PredictionMarket with dynamic AMM parameters
    ├── registers: allMarkets[], marketByQuestion mapping
    └── emits: MarketDeployed event (indexed by Trader Agent scanner)

Agent update loop (every 15 minutes):
    ├── updateMarketProbability(market, newProbBps, newConfIntervalBps)
    └── rebalanceMarket(market)  ← if drift > rebalanceThresholdBps
```

| Function | Caller | Purpose |
|---|---|---|
| `createMarket()` | Agent (onlyOwner) | Deploys PredictionMarket, bootstraps AMM liquidity |
| `updateMarketProbability()` | Agent (onlyOwner) | Updates agent estimate → narrows/widens spread |
| `rebalanceMarket()` | Agent (onlyOwner) | Re-anchors AMM price to agent estimate |
| `getAllMarkets()` | Trader Agent scanner | Returns all deployed market addresses |
| `depositLiquidity()` | Agent (onlyOwner) | Deposits USDC seed before createMarket |
| `publishReasoning()` | Agent (onlyOwner) | Emits ReasoningPublished on an existing market |

---

#### `PredictionMarket.sol`

One instance per event. Constant-product AMM with dynamic spread overlay
and agent-driven liquidity rebalancing.

```
PredictionMarket (one per event)
│
├── ShareToken YES           ← ERC-20, minted on buy, burned on sell/redeem
├── ShareToken NO            ← ERC-20, minted on buy, burned on sell/redeem
│
├── AMM: x * y = k           ← constant-product pricing curve
│   yesReserve × noReserve = k (invariant)
│   currentYesPrice = noReserve / (yesReserve + noReserve)
│
├── Dynamic spread           ← applied on top of AMM price
│   spread = confidenceSpread + liquiditySpread + timeSpread
│   confidenceSpread: widens as agent confidence interval widens
│   liquiditySpread:  widens if pool < 50 USDC (prevents extraction)
│   timeSpread:       widens in last 24h before expiry
│   range: MIN_SPREAD_BPS (50) → MAX_SPREAD_BPS (1000)
│
├── Liquidity rebalancing    ← agent re-anchors reserves to its estimate
│   Triggered when: |marketPrice - agentProbability| > rebalanceThresholdBps
│   Effect: shifts yesReserve/noReserve ratio without changing total USDC
│
├── oracle address           ← pre-committed at creation, only this can resolve()
├── accumulatedFees          ← spread fees stay in pool, deepening liquidity
└── reasoningCid             ← IPFS CID of creation reasoning trace
```

**AMM + spread example:**

```
Agent estimate: 68% (6800 bps)   Confidence interval: ±8% (800 bps)
Seed: 100 USDC

Initial reserves:
  yesReserve = 100 × 0.68 = 68 USDC
  noReserve  = 100 × 0.32 = 32 USDC

Trader buys 10 USDC of YES:
  spread     = 800/10 + 0 + 0 = 80 bps (confidence component only)
  spreadFee  = 10 × 0.0080 = 0.08 USDC (stays in pool)
  usdcForAMM = 9.92 USDC
  sharesOut  = k / (noReserve + 9.92) computed from yesReserve

Agent updates estimate to 74%, confidence narrows to ±5%:
  new spread = 500/10 = 50 bps → cheaper to trade
  rebalance triggered (74% vs 68% = 6% drift > 5% threshold)
```

| Function | Caller | Purpose |
|---|---|---|
| `buy(buyYes, usdcIn, minSharesOut)` | Any trader | Buy YES/NO with spread + slippage protection |
| `sell(sellYes, sharesIn, minUsdcOut)` | Any trader | Sell shares back for USDC |
| `updateAgentProbability()` | Factory only | Update estimate + confidence interval |
| `rebalanceLiquidity()` | Factory only | Re-anchor reserves to agent estimate |
| `resolve(yesWon)` | Oracle only | Resolve market after expiry |
| `redeem()` | Winning holders | Burn winning shares for USDC payout |
| `currentYesPrice()` | Anyone | YES price in basis points |
| `currentSpreadBps()` | Anyone | Current dynamic spread |
| `getMarketInfo()` | Trader Agent | Full market state in one call |

Events emitted:

```solidity
MarketCreated(address market, string question, address oracle,
              uint256 expiry, uint256 initialYesPrice, string reasoningCid)
AgentProbabilityUpdated(uint256 newProbabilityBps, uint256 newConfidenceBps, uint256 timestamp)
LiquidityRebalanced(uint256 oldYes, uint256 oldNo, uint256 newYes, uint256 newNo, uint256 agentProb)
Trade(address trader, bool buyYes, uint256 usdcIn, uint256 sharesOut)
MarketResolved(bool yesWon)
Redeemed(address redeemer, uint256 usdcOut)
ReasoningPublished(address market, address agentWallet,
                   string ipfsCid, bytes32 sha256Hash, uint256 blockTimestamp)
```

---

#### `MultiSigOracle.sol`

2-of-3 multisig for market resolution. Set as the `oracle` address at market
creation. Three team members independently verify the event outcome and sign —
resolution fires automatically when the threshold is met.

```
Signer A calls approveResolution(market, yesWon=true)   → count: 1/2
Signer B calls approveResolution(market, yesWon=true)   → count: 2/2
                                                         → calls market.resolve(true)
                                                         → MarketResolved emitted
```

> **Production oracle upgrade path:** The `oracle` address is set per-market
> at creation — no contract redeployment needed to upgrade.
> - v1: Chainlink Functions adapter (fetches BLS/Fed/AP data feeds automatically)
> - v2: UMA Optimistic Oracle (48h dispute window, used by Polymarket in production)

---

### Layer 2 — Trader Agent (Arc + Polygon)

#### `TreasuryManager.sol` (Arc Testnet)

Controls all agent capital on Arc. Enforces Kelly/drawdown limits on-chain
as a hard safety net. Triggers CCTP to move USDC to Polygon when a bet fires.

```
TreasuryManager (Arc)
│
├── holds: USDC float (agent bankroll)
│
├── enforces on-chain:
│   maxSinglePositionBps   = 250  (2.5% per market)
│   maxCorrelatedExposureBps = 500 (5% correlated total)
│   maxDailyDrawdownBps    = 300  (agent pauses at 3% daily loss)
│
├── fundBet(marketId, amount, finalityThreshold):
│   1. validates Kelly limits → reverts if exceeded
│   2. calls CCTP depositForBurn() → burns USDC on Arc
│   3. Circle attestation service signs burn (~20s)
│   4. Agent calls receiveMessage() on Polygon → USDC.e minted
│   5. Agent places Polymarket bet with USDC.e
│
└── recordSweepBack(marketId, usdcReturned):
    1. closes position
    2. computes P&L
    3. checks daily drawdown → pauses if breached
```

| Function | Caller | Purpose |
|---|---|---|
| `fundBet(marketId, amount, threshold)` | Agent (onlyOwner) | Validate limits + trigger CCTP to Polygon |
| `recordSweepBack(marketId, returned)` | Agent (onlyOwner) | Close position, update P&L, check drawdown |
| `deposit(amount)` | Agent (onlyOwner) | Add USDC to treasury |
| `maxBetAllowed()` | Agent | Current max position size (2.5% of bankroll) |
| `totalBankroll()` | Anyone | On-hand USDC + deployed capital on Polygon |
| `resumeAgent()` | Owner only | Unpause after drawdown investigation |

---

#### `PositionLedger.sol` (Arc Testnet)

On-chain audit trail for every Polymarket bet. Deployed on Arc so reasoning
traces get Arc's immutable timestamps — not Polygon's. Every field from the
Trader Agent's decision is stored here, including the IPFS CID of the
reasoning trace and the SHA-256 hash for tamper verification.

```
Position record (one per Polymarket bet):
  polymarketConditionId   ← Polymarket's conditionId
  polymarketTokenId       ← CTF ERC-1155 tokenId (YES or NO share)
  side                    ← YES or NO
  usdcSpent               ← USDC sent to Polygon (6 decimals)
  sharesReceived          ← CTF shares received
  entryPriceBps           ← 6800 = 68%
  kellyFractionBps        ← Half-Kelly fraction used
  edgeBps                 ← agent P(event) - market P(event) in bps
  openedAt                ← Arc block timestamp (proves pre-commitment)
  reasoningCid            ← IPFS CID of reasoning trace JSON
  sha256Hash              ← SHA-256 of reasoning trace (tamper detection)
  state                   ← OPEN | CLOSED_WIN | CLOSED_LOSS | CLOSED_HEDGE
  realisedPnl             ← final P&L (signed, 6 decimals)
  polygonTxHash           ← Polygon tx where the bet executed
  cctpNonce               ← CCTP transfer nonce that funded this bet
```

Events: `PositionOpened`, `PositionClosed`, `ReasoningPublished`

---

### Layer 3 — Reasoning-as-Product (Arc Testnet + Express Backend)

#### `ReasoningRegistry.sol` (Arc Testnet)

On-chain index of all published reasoning traces. Every IPFS CID is stored
with its SHA-256 hash and Arc block timestamp — creating an immutable,
tamper-evident pre-commitment proof that reasoning existed before market
resolution.

```
ReasoningRegistry
│
├── publishTrace(ipfsCid, sha256Hash, traceType, relatedId)
│   → traceId = keccak256(ipfsCid)  ← deterministic, reproducible off-chain
│   → stores TraceRecord on-chain
│   → emits ReasoningPublished (Arc block timestamp = proof of pre-commitment)
│
├── recordAccess(traceId, subscriber, amountPaidUsdc)
│   → called by API server after x402 payment verified
│   → on-chain subscriber audit trail
│
└── verifyTrace(ipfsCid, sha256Hash)
    → returns (valid: bool, publishedAt: uint256)
    → anyone can verify without paying
```

**Tamper detection:** `traceId = keccak256(cid)`. Anyone can:
1. Fetch content from IPFS at the CID
2. SHA-256 hash the raw JSON
3. Compare against `sha256Hash` stored in the Arc `ReasoningPublished` event

If they match → trace is authentic and was published at Arc block timestamp,
before the market resolved. If they don't match → content was altered after
publication. This is cryptographically unforgeable.

---

## Deployed Contract Addresses

### Arc Testnet

| Contract | Address | Explorer |
|---|---|---|
| MarketFactory | `0xA24BB6956D722Ed0dc67D2Bd9f0b67C3A02A838a` | [View](https://testnet.arcscan.app/address/0xA24BB6956D722Ed0dc67D2Bd9f0b67C3A02A838a) |
| TreasuryManager | `0xb326E280D2e115B6BEC25154142970a90074e7F8` | [View](https://testnet.arcscan.app/address/0xb326E280D2e115B6BEC25154142970a90074e7F8) |
| PositionLedger | `0x4ac9c8A1F68c6d8979343746825Df09DD1907b44` | [View](https://testnet.arcscan.app/address/0x4ac9c8A1F68c6d8979343746825Df09DD1907b44) |
| ReasoningRegistry | `0xE3188B3b4E14d74E6110137FF91f12B981A82257` | [View](https://testnet.arcscan.app/address/0xE3188B3b4E14d74E6110137FF91f12B981A82257) |
| MultiSigOracle | `0xD21251d0f66245C1B259d720F3795633a803b8B9` | [View](https://testnet.arcscan.app/address/0xD21251d0f66245C1B259d720F3795633a803b8B9) |

### Arc Testnet — Fixed Infrastructure

| Contract | Address |
|---|---|
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` |
| EURC ERC-20 | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| CCTP TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Arc CCTP Domain | `26` |

### Polygon Mainnet — Polymarket (existing, never deployed by us)

| Contract | Address |
|---|---|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Polygon CCTP Domain | `7` |

---

## Setup

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node.js v22+
- A Circle developer account ([console.circle.com](https://console.circle.com))

### Install

```bash
git clone https://github.com/your-org/oracledesk-contracts
cd oracledesk-contracts

forge install OpenZeppelin/openzeppelin-contracts --no-git
npm install
```

### Environment variables

```bash
cp .env.example .env
# Fill in all values — see .env.example for descriptions
```

```bash
# Arc Testnet
RPC=https://rpc.testnet.arc-node.thecanteenapp.com/v1/YOUR_KEY

# Circle
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_WALLET_ID=
AGENT_WALLET_ADDRESS=

# Deployer (throwaway EOA — generate with: cast wallet new)
DEPLOYER_PRIVATE_KEY=
DEPLOYER_ADDRESS=

# Polygon
POLYGON_RPC=https://polygon-rpc.com
POLYGON_EXECUTION_WALLET=
POLYGON_PRIVATE_KEY=

# MultiSig oracle signers (optional — defaults to AGENT_WALLET_ADDRESS if unset)
TEAM_MEMBER_2=
TEAM_MEMBER_3=

# Polymarket
POLYMARKET_BUILDER_CODE=
POLYMARKET_API_KEY=

# Fixed Arc addresses — do not change
USDC_ADDRESS=0x3600000000000000000000000000000000000000
CCTP_TOKEN_MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
CCTP_MESSAGE_TRANSMITTER=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275

# Filled automatically by deploy.ts — leave blank before first deploy
ORACLE_ADDRESS=
MARKET_FACTORY_ADDRESS=
TREASURY_MANAGER_ADDRESS=
POSITION_LEDGER_ADDRESS=
REASONING_REGISTRY_ADDRESS=
```

---

## Build and Test

```bash
# Compile all contracts
forge build

# Run all tests (19 total across 3 test files)
forge test -vvv

# Run tests by layer
forge test --match-path test/PredictionMarket.t.sol -vvv    # Layer 1 (12 tests)
forge test --match-path test/TreasuryManager.t.sol -vvv     # Layer 2 (7 tests)
forge test --match-path test/ReasoningRegistry.t.sol -vvv   # Layer 3 (5 tests)

# Run a single test by name
forge test --match-test test_DynamicSpread -vvv
```

| Test file | Tests | What it covers |
|---|---|---|
| `PredictionMarket.t.sol` | 12 | AMM pricing, dynamic spreads, time spread, liquidity rebalancing, spread fee accumulation, resolution, redemption |
| `TreasuryManager.t.sol` | 7 | Initial state, Kelly limits, CCTP funding, duplicate position rejection, drawdown pause and resume |
| `ReasoningRegistry.t.sol` | 5 | Publish trace, duplicate CID rejection, record access, pagination, tamper verification |

---

## Deployment

### One-command full deployment

Deploys all five contracts in dependency order, runs all tests first,
verifies on the Arc explorer, and outputs a versioned artifacts folder.

```bash
source ~/.arc-canteen/env   # sets $RPC

npx tsx --env-file=.env scripts/deploy.ts
# or with explicit network:
npx tsx --env-file=.env scripts/deploy.ts --network=arc-testnet
```

**What it does:**

```
1. forge build              ← compile all contracts
2. forge test               ← run all 19 tests (fail fast if any fail)
3. Deploy MultiSigOracle    ← no dependencies
4. Deploy MarketFactory     ← needs oracle address
5. Deploy TreasuryManager   ← needs polygon wallet
6. Deploy PositionLedger    ← no dependencies
7. Deploy ReasoningRegistry ← no dependencies
8. Verify on Arc explorer   ← all five contracts
9. Export artifacts/        ← addresses.json + all ABIs
10. Print .env additions    ← copy-paste ready
```

**Output structure:**

```
artifacts/
├── latest.json                        ← always points to most recent deployment
└── arc-testnet-2026-05-19T12-00-00/
    ├── addresses.json                 ← import this in your frontend/backend
    ├── deployment.json                ← full record with tx hashes + block numbers
    └── abis/
        ├── MarketFactory.json
        ├── PredictionMarket.json
        ├── TreasuryManager.json
        ├── PositionLedger.json
        ├── ReasoningRegistry.json
        ├── MultiSigOracle.json
        └── index.json                 ← combined: import abis from './index.json'
```

### After deployment — copy addresses to `.env`

The deploy script prints these at the end. Copy them into `.env`:

```bash
ORACLE_ADDRESS=0x...
MARKET_FACTORY_ADDRESS=0x...
TREASURY_MANAGER_ADDRESS=0x...
POSITION_LEDGER_ADDRESS=0x...
REASONING_REGISTRY_ADDRESS=0x...
```

### Post-deployment health check

```bash
npx tsx --env-file=.env scripts/verify.ts
```

Checks every contract has code at its address and is owned by `AGENT_WALLET_ADDRESS`.

### Export ABIs only (after contract updates)

```bash
forge build
npx tsx scripts/export-abis.ts
# Writes to artifacts/abis/ without a full redeployment
```

### Using the artifacts in your frontend/backend

```typescript
// Import all addresses
import addresses from './artifacts/latest.json';
const factoryAddress = addresses.MarketFactory;

// Import a single ABI
import MarketFactoryAbi from './artifacts/abis/MarketFactory.json';

// Import combined index (all ABIs at once)
import abis from './artifacts/abis/index.json';
const { MarketFactory, TreasuryManager } = abis;
```

### Individual layer deployment (if needed)

```bash
# Layer 1 only
forge script script/DeployLayer1.s.sol --rpc-url $RPC --broadcast \
  --verify --verifier blockscout --verifier-url https://testnet.arcscan.app/api -vvvv

# Layer 2 only
forge script script/DeployLayer2.s.sol --rpc-url $RPC --broadcast \
  --verify --verifier blockscout --verifier-url https://testnet.arcscan.app/api -vvvv

# Layer 3 only
forge script script/DeployLayer3.s.sol --rpc-url $RPC --broadcast \
  --verify --verifier blockscout --verifier-url https://testnet.arcscan.app/api -vvvv
```

---

## Verification Scripts

Run these to validate each layer end-to-end after deployment:

```bash
# 1. Read-only chain connectivity check
npx tsx --env-file=.env scripts/verify.ts

# 2. Verify scanner reads Arc markets (read-only)
npx tsx --env-file=.env scripts/test-scan.ts

# 3. Create a test market (spends ~50 USDC testnet)
npx tsx --env-file=.env scripts/test-create-market.ts

# 4. Verify Polymarket EIP-712 order signing
npx tsx --env-file=.env scripts/test-polymarket-signing.ts

# 5. Publish a reasoning trace (Layer 3 — needs API server running)
npx tsx --env-file=.env scripts/test-publish-trace.ts

# 6. Subscribe and read a trace via x402 (Layer 3)
npx tsx --env-file=.env scripts/test-subscribe.ts
```

---

## Security Notes

**Enforced on-chain (cannot be bypassed by agent bugs):**
- Max single position: `TreasuryManager.maxSinglePositionBps` (2.5%)
- Daily drawdown auto-pause: `TreasuryManager._checkDrawdown()` (3%)
- No duplicate open positions: `positions[marketId].open` guard
- Oracle-only resolution: `PredictionMarket.onlyOracle` modifier
- Minimum dynamic spread: `PredictionMarket.MIN_SPREAD_BPS` (50 bps)
- Reasoning tamper detection: SHA-256 hash on Arc immutable after publish
- Subscriber access audit: `ReasoningRegistry.traceAccess` mapping

**Enforced off-chain (agent backend):**
- Kelly Criterion sizing — computed before calling `fundBet()`
- Correlated position limits — checked before calling `fundBet()`
- Source credibility weighting — LLM probability estimation
- Hedge triggers — position monitor every 15 minutes
- Rebalance triggers — market drift monitor every 15 minutes

**Private key model:**
- `DEPLOYER_PRIVATE_KEY` — throwaway EOA. Used only for `forge script`. No ongoing role after deployment.
- `POLYGON_PRIVATE_KEY` — signs Polymarket EIP-712 orders. Never exposed to Arc contracts. Never commit.
- Circle agent wallet (SCA) — owns all Arc contracts. Signing via Circle API — no raw private key on disk.

---

## Architecture Decision Log

**Why Arc for treasury, not Polygon?**
Arc transactions cost ~$0.01 and settle in sub-seconds. Reasoning hashes
published on Arc are economically viable at high frequency. On Polygon, gas
costs would compete with bet execution and make sub-cent reasoning publication
uneconomical.

**Why two chains instead of deploying everything on Arc?**
Polymarket operates exclusively on Polygon mainnet. The liquidity, order book,
and settlement infrastructure cannot be replicated. OracleDesk uses Arc as the
intelligence layer and Polygon as the execution layer — each doing what it
does best.

**Why constant-product AMM instead of LMSR?**
LMSR (Logarithmic Market Scoring Rule) is academically correct for prediction
markets but requires `log` and `exp` in Solidity with fixed-point arithmetic —
a known source of precision bugs and overflow vulnerabilities. The constant-
product AMM with dynamic spread overlay achieves similar price anchoring
behaviour without the implementation risk. LMSR is documented as the
production v2 upgrade path.

**Why dynamic spreads instead of fixed fees?**
Fixed fees treat a 95%-confident market the same as a 51%-confident one. Dynamic
spreads that widen with the agent's confidence interval make informed traders
pay more when the agent is uncertain — correctly pricing the information
asymmetry risk.

**Why x402 Nanopayments for reasoning traces?**
At $0.001 per read, traditional payment rails are uneconomical (gas alone
exceeds the payment value on most chains). Circle Gateway's batched settlement
amortizes gas across thousands of authorizations, making sub-cent payments
viable for the first time. The x402 protocol integrates natively into HTTP —
one middleware line gates any Express route.

**Why `ReasoningPublished` is the same event signature across all three layers?**
The frontend subscribes to a single event signature across all Arc contracts.
Both market creation (Layer 1) and trading decisions (Layer 2, 3) emit the
same event — giving a unified tamper-evident timeline of all agent reasoning
regardless of which contract handles the action.

---

## Built With

- [Foundry](https://book.getfoundry.sh/) — Solidity development, testing, deployment
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) — ERC-20, Ownable, ReentrancyGuard
- [Circle Developer Controlled Wallets](https://developers.circle.com/wallets) — Agent wallet (SCA)
- [Circle CCTP](https://developers.circle.com/cctp) — Cross-chain USDC transfer Arc ↔ Polygon
- [Circle Gateway Nanopayments](https://developers.circle.com/gateway/nanopayments) — x402 per-trace billing
- [Arc Testnet](https://docs.arc.io) — Intelligence and treasury layer
- [Polymarket](https://polymarket.com) — Prediction market execution on Polygon
- [Pinata](https://pinata.cloud) — IPFS reasoning trace storage
- [viem](https://viem.sh) — TypeScript chain interactions
- [ethers.js](https://docs.ethers.org) — EIP-712 order signing

---

*OracleDesk — Agora Hackathon 2026*
