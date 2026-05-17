# OracleDesk Smart Contracts

> Autonomous prediction market creation and intelligent trading infrastructure across Arc Testnet and Polygon Mainnet.
> Built for the **Agora Hackathon** — RFB 02 (Trader Intelligence) + RFB 03 (Market Verticals).

---

## Overview

OracleDesk is a two-chain autonomous trading system. It creates prediction markets on Arc Testnet, finds mispriced bets on Polymarket (Polygon), executes Kelly-sized positions, and publishes every decision as a tamper-evident on-chain reasoning trace.

```
ARC TESTNET (intelligence + treasury layer)
├── MarketFactory.sol       ← deploys new prediction markets
├── PredictionMarket.sol    ← one instance per event (YES/NO AMM)
├── TreasuryManager.sol     ← controls USDC capital, enforces Kelly limits
├── PositionLedger.sol      ← on-chain audit trail for all Polymarket bets
└── ReasoningPublished      ← event emitted on every agent decision (tamper-evident)
        │
        │  Circle CCTP (depositForBurn → attestation → receiveMessage)
        │  Arc Domain 26 → Polygon Domain 7 — ~20 second Fast Transfer
        ▼
POLYGON MAINNET (execution layer — existing Polymarket contracts)
├── CTF Exchange V2         ← Polymarket's contract — agent signs orders, never deploys
├── Conditional Tokens      ← ERC-1155 YES/NO shares
└── USDC.e                  ← collateral for all Polymarket bets
```

**Two chains, one agent.** Capital lives on Arc. When a bet is identified on Polymarket, CCTP moves the required USDC to Polygon in ~20 seconds. Builder fees earned on Polygon sweep back to Arc every 6 hours.

---

## Repository Structure

```
oracledesk-contracts/
├── src/
│   ├── MarketFactory.sol           # Layer 1 — deploys PredictionMarket instances
│   ├── PredictionMarket.sol        # Layer 1 — AMM market with YES/NO shares
│   ├── TreasuryManager.sol         # Layer 2 — Arc treasury + CCTP bridge
│   ├── PositionLedger.sol          # Layer 2 — on-chain position audit trail
│   └── interfaces/
│       └── IPolymarket.sol         # Reference types for Polymarket order signing
├── test/
│   ├── PredictionMarket.t.sol      # Layer 1 tests (12 tests)
│   └── TreasuryManager.t.sol       # Layer 2 tests (7 tests)
├── script/
│   ├── DeployLayer2.s.sol          # Foundry deployment script for Arc
│   └── DeployLayer1.s.sol          # Foundry deployment script for Arc
├── scripts/                        # TypeScript agent scripts
│   ├── deploy-factory.ts           # Deploy MarketFactory via Circle Wallets API
│   ├── deploy-layer2.ts            # Deploy TreasuryManager + PositionLedger
│   ├── test-scan.ts                # Verify scanner reads Arc markets
│   ├── test-create-market.ts       # End-to-end market creation test
│   └── test-polymarket-signing.ts  # Verify EIP-712 order signing
├── foundry.toml
├── package.json
└── .env                            # Never commit this
```

---

## Contract Architecture

### Layer 1 — Market Creation (Arc Testnet)

#### `MarketFactory.sol`

Deployed once. The agent backend calls `createMarket()` for every event the LLM decision engine approves. Acts as a registry of all OracleDesk markets.

```
Agent backend
    │
    │  createMarket(question, oracle, expiry, initialYesPrice, seed, ...)
    ▼
MarketFactory
    ├── validates: no duplicate question, sufficient USDC seed
    ├── deploys: new PredictionMarket instance
    ├── registers: allMarkets[], marketByQuestion mapping
    └── emits: MarketDeployed event (indexed by Trader Agent scanner)
```

**Key functions:**

| Function | Who calls it | What it does |
|---|---|---|
| `createMarket()` | Agent backend (onlyOwner) | Deploys a PredictionMarket, bootstraps liquidity, emits MarketDeployed |
| `getAllMarkets()` | Trader Agent scanner | Returns all deployed market addresses |
| `marketExists()` | Agent backend | Checks if a question already has a market |
| `depositLiquidity()` | Agent backend | Deposits USDC into factory before createMarket |
| `publishReasoning()` | Reasoning Layer | Emits ReasoningPublished on an existing market |

---

#### `PredictionMarket.sol`

One deployed per event by the factory. Implements a constant-product AMM for YES/NO shares. Handles trading, liquidity, oracle resolution, and on-chain reasoning proofs.

```
PredictionMarket (one per event)
├── ShareToken YES  ← ERC-20, minted on buy, burned on sell/redeem
├── ShareToken NO   ← ERC-20, minted on buy, burned on sell/redeem
├── USDC pool       ← constant-product AMM (yesReserve * noReserve = k)
├── oracle address  ← pre-committed at creation, only address that can resolve()
└── reasoningCid    ← IPFS CID of the creation reasoning trace
```

**AMM mechanics:**

The market uses a constant-product AMM where `yesReserve × noReserve = k`.

Initial price is set from the agent's probability estimate:
```
initialYesPrice = 6800 bps (68%)
→ yesReserve = seed × 0.68
→ noReserve  = seed × 0.32
```

Buying YES shares shifts USDC into `noReserve`, reducing `yesReserve` (shares leave the pool and go to the buyer). Price moves with every trade — buying YES raises the YES price, buying NO raises the NO price.

**Key functions:**

| Function | Who calls it | What it does |
|---|---|---|
| `buy(buyYes, usdcIn, minSharesOut)` | Any trader | Buys YES or NO shares with USDC. Slippage protection via minSharesOut |
| `sell(sellYes, sharesIn, minUsdcOut)` | Any trader | Sells shares back for USDC |
| `resolve(yesWon)` | Oracle only | Resolves the market after expiry |
| `redeem()` | Winning share holders | Burns winning shares for USDC payout |
| `currentYesPrice()` | Anyone | Returns current YES price in basis points |
| `getMarketInfo()` | Trader Agent | Returns full market state in one call |
| `publishReasoning()` | Factory only | Emits ReasoningPublished for trade traces |

**Events emitted:**

```solidity
MarketCreated(address market, string question, address oracle, 
              uint256 expiry, uint256 initialYesPrice, string reasoningCid)

Trade(address trader, bool buyYes, uint256 usdcIn, uint256 sharesOut)

MarketResolved(bool yesWon)

Redeemed(address redeemer, uint256 usdcOut)

ReasoningPublished(address market, address agentWallet, 
                   string ipfsCid, bytes32 sha256Hash, uint256 blockTimestamp)
```

**Arc-specific notes:**
- USDC is at `0x3600000000000000000000000000000000000000` — always 6 decimals in ERC-20 interface
- `block.prevrandao` is always 0 on Arc — not used
- Multiple blocks can share the same timestamp — block numbers used for ordering
- Gas paid in USDC via Circle Paymaster on the agent's SCA wallet

---

### Layer 2 — Trader Agent (Arc + Polygon)

#### `TreasuryManager.sol` (Arc Testnet)

Controls all agent capital on Arc. Enforces Kelly/drawdown limits on-chain as a hard safety net. Triggers CCTP `depositForBurn()` to move USDC to Polygon when a bet fires.

```
TreasuryManager (Arc)
├── holds: USDC float (agent's bankroll)
├── enforces: max single position (2.5%), max daily drawdown (3%)
├── triggers: CCTP depositForBurn() → burns USDC on Arc
├── tracks: open positions, deployed capital, daily P&L
└── records: sweep-backs from Polygon (closes positions, updates P&L)
```

**Capital flow — Arc to Polygon:**

```
1. Agent backend calls fundBet(marketId, amount, 1000)
2. TreasuryManager validates Kelly limits on-chain
3. TreasuryManager calls CCTP TokenMessengerV2.depositForBurn()
   → USDC burned on Arc
   → Circle attestation service signs the burn message (~20s)
4. Agent backend calls CCTP MessageTransmitterV2.receiveMessage() on Polygon
   → USDC.e minted to polygonExecutionWallet
5. Agent backend places Polymarket order using minted USDC.e
```

**Capital flow — Polygon to Arc (sweep-back):**

```
1. Polymarket position resolves → USDC.e lands on Polygon wallet
2. Agent backend calls CCTP depositForBurn on Polygon (reverse direction)
3. USDC minted back on Arc to TreasuryManager
4. Agent calls recordSweepBack(marketId, usdcReturned) on TreasuryManager
5. Position closed, P&L updated, daily drawdown checked
```

**Risk parameters (adjustable by owner):**

| Parameter | Default | Meaning |
|---|---|---|
| `maxSinglePositionBps` | 250 | Max 2.5% of bankroll per market |
| `maxCorrelatedExposureBps` | 500 | Max 5% in correlated positions |
| `maxDailyDrawdownBps` | 300 | Agent pauses if daily loss exceeds 3% |

**Key functions:**

| Function | Who calls it | What it does |
|---|---|---|
| `fundBet(marketId, amount, finalityThreshold)` | Agent backend (onlyOwner) | Validates limits, triggers CCTP burn to Polygon |
| `recordSweepBack(marketId, usdcReturned)` | Agent backend (onlyOwner) | Closes position, updates P&L, checks drawdown |
| `deposit(amount)` | Agent backend (onlyOwner) | Adds USDC to treasury |
| `totalBankroll()` | Anyone | On-hand USDC + deployed capital |
| `maxBetAllowed()` | Agent backend | Current max position size |
| `resumeAgent()` | Owner only | Unpauses after drawdown breach investigation |

---

#### `PositionLedger.sol` (Arc Testnet)

The on-chain audit trail for every Polymarket bet. Deployed on Arc so reasoning traces are timestamped on Arc's immutable ledger — not Polygon. This is what gives the Reasoning Layer its tamper-evident pre-commitment proofs.

```
PositionLedger (Arc)
├── openPosition()  ← called immediately after Polymarket bet confirmed on Polygon
│     emits: PositionOpened (full trade details)
│     emits: ReasoningPublished (IPFS CID + SHA-256 hash, Arc block timestamp)
└── closePosition() ← called when market resolves or position hedged
      emits: PositionClosed (outcome, realised P&L)
```

**Why reasoning lives on Arc, not Polygon:**

The Polymarket bet executes on Polygon. But the *reasoning* why the agent bet, what data it used, what probability it estimated is logged on Arc. The Arc block timestamp proves the reasoning was committed **before** the market resolved. This is cryptographically verifiable by anyone.

**Position struct every field recorded on-chain:**

```solidity
struct Position {
    bytes32 polymarketConditionId;  // Polymarket's conditionId
    uint256 polymarketTokenId;      // CTF ERC-1155 tokenId (YES or NO share)
    Side    side;                   // YES or NO
    uint256 usdcSpent;             // USDC spent on Polygon (6 decimals)
    uint256 sharesReceived;        // CTF shares received
    uint256 entryPriceBps;         // Entry price (6800 = 68%)
    uint256 kellyFractionBps;      // Half-Kelly fraction used
    uint256 edgeBps;               // Detected edge in basis points
    uint256 openedAt;              // Arc block timestamp
    uint256 closedAt;              // 0 if still open
    string  reasoningCid;          // IPFS CID of reasoning trace JSON
    bytes32 sha256Hash;            // SHA-256 of reasoning JSON (tamper proof)
    PositionState state;           // OPEN / CLOSED_WIN / CLOSED_LOSS / CLOSED_HEDGE
    int256  realisedPnl;           // Final P&L in USDC (6 decimals, signed)
    string  polygonTxHash;         // Polygon tx where the bet was placed
    uint64  cctpNonce;             // CCTP transfer nonce that funded this bet
}
```

**Key functions:**

| Function | Who calls it | What it does |
|---|---|---|
| `openPosition(...)` | Agent backend (onlyOwner) | Records bet details + emits ReasoningPublished on Arc |
| `closePosition(positionId, state, usdcReturned)` | Agent backend (onlyOwner) | Closes position, records P&L |
| `getPosition(positionId)` | Reasoning Layer frontend | Returns full position struct |
| `getOpenPositionIds()` | Hedge engine | Returns all currently open position IDs |
| `totalRealisedPnl()` | Frontend dashboard | Sum of all closed position P&L |

---

### Polymarket Integration (No Deployment)

You do not deploy any Polymarket contracts. The integration is pure TypeScript - EIP-712 order signing + Polymarket CLOB API.

**Order signing flow:**

```
1. Agent identifies mispriced market via probability engine
2. Agent builds Order struct with:
   - tokenId    (CTF ERC-1155 token from Polymarket API)
   - makerAmount (USDC to spend, 6 decimals)
   - takerAmount (shares expected = makerAmount / price)
   - salt        (random uint256 for uniqueness)
   - expiration  (Unix timestamp, typically +1 hour)
3. Agent signs order using EIP-712 with:
   - domain: { name: "CTF Exchange", version: "1", chainId: 137 }
   - types: Order struct (12 fields)
4. Signed order + signature POSTed to:
   POST https://clob.polymarket.com/order?builderCode=YOUR_CODE
5. Polymarket matching engine matches the order
6. CTF Exchange V2 settles on-chain (agent never calls this directly)
7. OrderFilled event emitted on Polygon
8. Agent backend detects fill - calls openPosition() on PositionLedger (Arc)
```

**Builder code** — every order includes OracleDesk's builder code as a query parameter. Polymarket pays a percentage of fees back to the builder for every fill routed through the code, including subscriber copy-trades.

---

## Deployed Contract Addresses

### Arc Testnet

| Contract | Address | Explorer |
|---|---|---|
| MarketFactory | `0xf5b7e790168af77418ab9ec37cb7eb7851e4a36a` | [View](https://testnet.arcscan.app/address/0xf5b7e790168af77418ab9ec37cb7eb7851e4a36a) |
| TreasuryManager | `0xb326E280D2e115B6BEC25154142970a90074e7F8` |  [View](https://testnet.arcscan.app/address/0xb326E280D2e115B6BEC25154142970a90074e7F8) |
| PositionLedger | `0x4ac9c8A1F68c6d8979343746825Df09DD1907b44` | [View](https://testnet.arcscan.app/address/0x4ac9c8A1F68c6d8979343746825Df09DD1907b44) |

### Arc Testnet — Infrastructure (fixed, never change)

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
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| NegRisk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| USDC.e (collateral) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
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

# Solidity dependencies
forge install OpenZeppelin/openzeppelin-contracts --no-git

# TypeScript dependencies
npm install
```

### Environment variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

```bash
# Arc Testnet (Canteen node)
RPC=https://rpc.testnet.arc-node.thecanteenapp.com/v1/YOUR_KEY

# Circle — developer-controlled wallets
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_WALLET_ID=
AGENT_WALLET_ADDRESS=         # your Circle SCA wallet address on Arc

# Deployer (throwaway EOA — only used for forge script)
DEPLOYER_PRIVATE_KEY=         # generate with: cast wallet new
DEPLOYER_ADDRESS=

# Polygon
POLYGON_RPC=https://polygon-rpc.com
POLYGON_EXECUTION_WALLET=     # EOA that receives CCTP funds, signs Polymarket orders
POLYGON_PRIVATE_KEY=          # private key for POLYGON_EXECUTION_WALLET

# Arc contracts (fill after deployment)
MARKET_FACTORY_ADDRESS=
TREASURY_MANAGER_ADDRESS=
POSITION_LEDGER_ADDRESS=

# Fixed Arc addresses (do not change)
USDC_ADDRESS=0x3600000000000000000000000000000000000000

# Polygon — Polymarket
POLYGON_USDC=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
POLYGON_CTF_EXCHANGE=0xE111180000d2663C0091e4f400237545B87B996B

# CCTP
CCTP_TOKEN_MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
CCTP_MESSAGE_TRANSMITTER=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
CCTP_ATTESTATION_API=https://iris-api-sandbox.circle.com

# Polymarket
POLYMARKET_BUILDER_CODE=
POLYMARKET_API_KEY=
```

---

## Build and Test

```bash
# Compile all contracts
forge build

# Run all tests
forge test -vvv

# Run a specific test file
forge test --match-path test/TreasuryManager.t.sol -vvv

# Run a specific test
forge test --match-test test_FundBet -vvv
```

**Test coverage:**

| Test file | Tests | What it covers |
|---|---|---|
| `PredictionMarket.t.sol` | 12 | Market creation, AMM pricing, buy/sell, resolution, redemption, duplicate prevention, USDC decimal handling |
| `TreasuryManager.t.sol` | 7 | Initial state, Kelly limit enforcement, CCTP funding, duplicate position rejection, drawdown pause, PositionLedger open/close with P&L |

---

## Deployment

### Layer 1 — Market Factory (Arc)

```bash
source ~/.arc-canteen/env   # sets $RPC

forge script script/DeployLayer1.s.sol \
  --rpc-url $RPC \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api \
  -vvvv
```

### Layer 2 — Treasury + Position Ledger (Arc)

```bash
forge script script/DeployLayer2.s.sol \
  --rpc-url $RPC \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api \
  -vvvv
```

After deployment, transfer ownership to your Circle agent wallet:

```bash
export TREASURY_MANAGER_ADDRESS=0x...
export POSITION_LEDGER_ADDRESS=0x...

cast send $TREASURY_MANAGER_ADDRESS "transferOwnership(address)" $AGENT_WALLET_ADDRESS --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY
cast send $POSITION_LEDGER_ADDRESS "transferOwnership(address)" $AGENT_WALLET_ADDRESS --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY
```

Verify:

```bash
cast call $TREASURY_MANAGER_ADDRESS "owner()(address)" --rpc-url $RPC
cast call $POSITION_LEDGER_ADDRESS "owner()(address)" --rpc-url $RPC
# Both should return AGENT_WALLET_ADDRESS
```

---

## Verification Scripts

Run these in order to verify each layer is working end-to-end:

```bash
# 1. Verify scanner reads Arc markets correctly (read-only, safe to run anytime)
npx tsx --env-file=.env scripts/test-scan.ts

# 2. Create a test market on Arc (spends ~50 USDC testnet)
npx tsx --env-file=.env scripts/test-create-market.ts

# 3. Verify Polymarket EIP-712 order signing is correct
npx tsx --env-file=.env scripts/test-polymarket-signing.ts
```

---

## Security Notes

**What is enforced on-chain (cannot be bypassed):**
- Max single position size — `TreasuryManager.maxSinglePositionBps`
- No duplicate open positions per market — `positions[marketId].open` check
- Daily drawdown auto-pause — `TreasuryManager._checkDrawdown()`
- Oracle-only resolution — `PredictionMarket.onlyOracle` modifier
- Owner-only market creation and bet funding — `onlyOwner` on all write functions
- Reasoning tamper detection — SHA-256 hash on Arc cannot be altered after publication

**What is enforced off-chain (agent backend):**
- Kelly Criterion sizing — agent computes before calling `fundBet()`
- Correlated position limits — agent checks before calling `fundBet()`
- Source credibility weighting — LLM probability estimation
- Hedge triggers — position monitor recalculates every 15 minutes

**Private keys:**
- `DEPLOYER_PRIVATE_KEY` — throwaway EOA, used only for `forge script`. Has no ongoing role after `transferOwnership`.
- `POLYGON_PRIVATE_KEY` — signs Polymarket orders. Keep secure. Never commit.
- Circle agent wallet — developer-controlled SCA wallet. Signing goes through Circle API, no raw private key exposure.

---

## Architecture Decision Log

**Why Arc for treasury, not Polygon?**
Arc transactions cost ~$0.01 and settle in sub-seconds. Storing reasoning hashes on Polygon would cost significantly more and reasoning publication would compete with bet execution for gas. Arc keeps the intelligence layer economically viable at high frequency.

**Why not deploy on Arc and avoid CCTP entirely?**
Polymarket operates exclusively on Polygon mainnet. The liquidity and market infrastructure cannot be replicated — it must be used where it lives. CCTP is the correct answer for moving capital between chains without wrapping or custodial bridges.

**Why constant-product AMM instead of an order book for Arc markets?**
An AMM requires no off-chain operator and bootstraps liquidity automatically from the seed deposit. An order book would require the agent to continuously post limit orders. The AMM is simpler, more robust, and sufficient for the market sizes in this hackathon.

**Why is `ReasoningPublished` emitted from both Layer 1 and Layer 2 contracts?**
The frontend and Reasoning Layer subscribe to a single event signature across all Arc contracts. Both market creation decisions (Layer 1) and trading decisions (Layer 2) emit the same event, giving a unified on-chain log of all agent reasoning regardless of which contract handles the action.

---

## Built With

- [Foundry](https://book.getfoundry.sh/) — Solidity development and testing
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) — ERC-20, Ownable, ReentrancyGuard
- [Circle Developer Controlled Wallets](https://developers.circle.com/wallets) — Agent wallet management
- [Circle CCTP](https://developers.circle.com/cctp) — Cross-chain USDC transfer Arc ↔ Polygon
- [Arc Testnet](https://docs.arc.io) — Settlement layer for treasury and reasoning hashes
- [Polymarket](https://polymarket.com) — Prediction market execution on Polygon
- [viem](https://viem.sh) — TypeScript chain interactions
- [ethers.js](https://docs.ethers.org) — EIP-712 order signing

---

*OracleDesk — Agora Hackathon 2026*
