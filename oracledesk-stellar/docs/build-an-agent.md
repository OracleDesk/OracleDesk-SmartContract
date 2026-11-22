# Building a Third-Party Agent on OracleDesk

This guide walks you through building an autonomous agent that creates markets on OracleDesk, trades them, and publishes trading reasoning as a sellable x402 trace.

**Time to completion:** ~1 hour on a local Stellar network.

**Prerequisites:**
- Node.js 16+ and npm
- Stellar CLI (v20+)
- A code editor and git
- Basic familiarity with async/await (TypeScript)

---

## Concepts and Trust Model

OracleDesk's core idea is that autonomous agents are the market creators and traders. An agent:

1. **Commits** to a resolution rule (signer set or price threshold) before the market opens (ADR 0001: commit/reveal).
2. **Creates** a market with capital and a resolution commitment hash.
3. **Trades** the market within treasury caps, building up reasoning traces.
4. **Publishes** traces (the rationale for each trade) before executing the trade.
5. **Sells** traces over x402: a buyer pays and receives the trace hash, proof, and content.
6. **Resolves** the market and **redeems** winnings.

The trust model:
- **Agent key security:** If your agent's key is compromised, an attacker can trade within your caps but cannot withdraw treasury funds (transfers require admin auth).
- **Treasury caps:** You declare `max_trade`, `max_market`, and `max_daily` caps per agent. The treasury enforces these.
- **Collateral custody:** Your capital sits in the treasury until you explicitly withdraw it.
- **Resolution honesty:** Your agent commits to a resolution rule before trading begins, preventing front-running.

---

## Part 1: Local Network Setup

### 1.1 Start the Stellar Quickstart

```bash
stellar container start local
```

This runs a local Stellar network on `http://localhost:8000` with a built-in friendbot for account funding.

### 1.2 Generate Keys and Fund Accounts

```bash
# Generate a key for your agent
stellar keys generate --fund --network local agent

# Generate admin and treasury keys (for this example; production uses timelocks)
stellar keys generate --fund --network local admin
stellar keys generate --fund --network local treasury
```

The `--fund` flag asks friendbot to give each account 100 test stroops (10,000 test drops of native currency). Save the account addresses; you'll use them next.

---

## Part 2: Deploy Contracts

The contracts are already built as WASM in `oracledesk-stellar/contracts/**/target/wasm32-unknown-unknown/release/*.wasm`. Deployment is scripted, but you'll parameterize it:

```bash
cd oracledesk-stellar

# Set deployment environment
export NETWORK=local
export ADMIN_ACCOUNT=<admin_public_address>
export TREASURY_ACCOUNT=<treasury_public_address>
export AGENT_ACCOUNT=<agent_public_address>

# Run the deployment script
# Note: script/deploy-testnet.sh is hardcoded for testnet; use a local variant or manual deployment
./scripts/deploy-local.sh  # (hypothetical; you may need to adapt)
```

For a local network, consider using `stellar contract deploy` directly or adapting the deployment script.

**Key outputs** (save these):
- `contracts/market-core` address
- `contracts/resolver` address
- `contracts/treasury` address
- `contracts/reasoning-registry` address
- Collateral token (usually a local test USDC)

---

## Part 3: Treasury Configuration

The treasury enforces risk limits per agent. Configure your agent:

```bash
# Example: 10,000 USDC max trade, 50,000 max exposure per market, 100,000 max daily
soroban contract invoke \
  --network local \
  --id <treasury_contract_id> \
  -- register_agent \
  --agent <agent_address> \
  --max_trade 1000000000 \
  --max_market 5000000000 \
  --max_daily 10000000000
```

(Amounts in stroops: 1 USDC = 10^7 stroops.)

Deposit collateral into the treasury:

```bash
soroban contract invoke \
  --network local \
  --id <treasury_contract_id> \
  -- deposit \
  --amount 10000000000  # 1,000 USDC
```

---

## Part 4: Resolution Commitment (Commit/Reveal)

Before creating a market, you must commit to a resolution rule. OracleDesk uses a **hash commitment** to prevent front-running.

### 4.1 Define Your Resolution Spec

For a **signer-based** resolution (threshold of signers attesting an outcome):

```typescript
// In your agent code
const resolutionSpec = {
  tag: 'Signers',
  values: [{
    signers: [<signer1_addr>, <signer2_addr>, ...],
    threshold: 2,            // Need 2 of 3
    dispute_window: 604800,  // 7 days
  }],
};
```

For a **price-based** resolution (oracle price vs. threshold):

```typescript
const resolutionSpec = {
  tag: 'Price',
  values: [{
    feed: <reflector_contract_id>,
    threshold: 1500000000,  // 150 USD in Reflector's decimal scale
  }],
};
```

### 4.2 Compute the Resolution Hash

The hash is `sha256(XDR_ENCODE(ResolutionSpec))`. The XDR encoding must follow Soroban's struct-to-map serialization (structs serialize as maps sorted by key name).

Using the `@stellar/stellar-sdk`:

```typescript
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

function resolutionSpecHash(spec) {
  const scval = nativeToScVal(spec);
  const xdrBytes = scval.toXDR('base64');  // Get raw bytes
  return crypto.createHash('sha256').update(Buffer.from(xdrBytes, 'base64')).digest();
}

const hash = resolutionSpecHash(resolutionSpec);
console.log('Resolution Hash:', hash.toString('hex'));
```

**Important:** The hash commits you to this rule. It cannot be changed. Store it safely.

### 4.3 Reveal the Spec

After the market is created and trading begins, call the resolver to reveal your spec:

```typescript
// Wait until trading is active, then reveal
await resolver.register_signer_spec({
  market_id: marketId,
  config: resolutionSpec.values[0],
  // The resolver will re-hash and verify it matches the commitment
});
```

If the hash doesn't match, the reveal fails with `SpecHashMismatch`.

---

## Part 5: Creating a Market

```typescript
const question = "Will ETH close above $3,000 on 2024-12-31?";
const questionHash = sha256(JSON.stringify({ question }));
const closeTime = Math.floor(Date.now() / 1000) + 86400 * 2;  // 2 days

const marketId = await treasury.agent_create_market({
  agent: agentAddress,
  seed_amount: 100e7,                   // 100 USDC
  question_hash: questionHash,
  resolution_hash: resolutionSpecHash,
  close_time: closeTime,
});

console.log('Market created:', marketId);
```

Or, **with a bounty** (Issue #149, if implemented):

```typescript
const marketId = await treasury.agent_create_market_with_bounty({
  agent: agentAddress,
  seed_amount: 100e7,
  bounty_amount: 10e7,  // 10 USDC bounty for permissionless resolvers
  question_hash: questionHash,
  resolution_hash: resolutionSpecHash,
  close_time: closeTime,
});
```

---

## Part 6: Trading and Trace Publishing

### 6.1 Build Your Trading Reasoning

A **trace** is a JSON object that records your decision rationale for each action:

```typescript
const traceStep = {
  timestamp: new Date().toISOString(),
  action: 'buy',
  market_id: marketId,
  outcome: 'Yes',
  reasoning: 'Model predicts 72% probability; current market is 60%.',
  collateral_in: 50e7,
  expected_value: 'Positive under my forecast.',
};
```

### 6.2 Publish the Trace Before Trading

**Critical:** Publish the trace *before* you execute the trade. This proves you decided based on the reasoning, not the outcome.

```typescript
const traceHash = sha256(JSON.stringify(traceStep));

await reasoningRegistry.publish_trace({
  reasoner: agentAddress,
  content: JSON.stringify(traceStep),
});

console.log('Trace published:', traceHash.toString('hex'));
```

### 6.3 Execute the Trade

```typescript
const result = await marketCore.buy({
  trader: agentAddress,
  market_id: marketId,
  outcome: 'Yes',
  collateral_in: 50e7,
  min_shares_out: 40e7,  // Slippage protection; never 0
});

console.log('Bought shares:', result.shares_out);
```

### 6.4 Repeat: Publish, Then Trade

For every action (buy, sell, merge), follow the publish-then-trade pattern. This builds a verifiable reasoning transcript.

---

## Part 7: Resolving and Redeeming

### 7.1 Wait for Close Time

Your market's `close_time` is fixed at creation. After it passes, the market is closed to trading.

### 7.2 Reveal the Resolution Spec

```typescript
await resolver.register_signer_spec({
  market_id: marketId,
  config: resolutionSpec.values[0],
});
```

The resolver checks that `sha256(config) == market.resolution_hash`. If it matches, the spec is registered.

### 7.3 Finalize the Market

For signer-based resolution:

```typescript
// Signers attest (or timeout passes after dispute_window)
// Then:
const bountyPaid = await resolver.finalize_signers_for({
  caller: agentAddress,
  market_id: marketId,
});
```

For price-based:

```typescript
const bountyPaid = await resolver.resolve_price_for({
  caller: agentAddress,
  market_id: marketId,
});
```

### 7.4 Redeem Your Winnings

```typescript
const payout = await marketCore.redeem({
  holder: agentAddress,
  market_id: marketId,
});

console.log('Redeemed:', payout);
```

### 7.5 Claim Pool Remainder (If Creator)

If your agent created the market, you can also claim LP fees:

```typescript
const remainder = await marketCore.claim_pool_remainder({
  market_id: marketId,
});

console.log('LP remainder:', remainder);
```

---

## Part 8: Selling Traces over x402

The x402 protocol lets you sell access to your traces. A buyer sends a payment and receives the trace content and a verification proof.

### 8.1 Set Up an x402 Server

Deploy the x402 server (usually hosted separately) with your reasoning registry contract address and pricing:

```env
REASONING_REGISTRY_CONTRACT_ID=<contract_id>
TRACE_PRICE_USDC=1000  # 0.0001 USDC per trace (micro-pricing)
```

### 8.2 Publish a Trace with x402

When you publish a trace to the registry, it becomes available for sale:

```typescript
const traceId = await reasoningRegistry.publish_trace({
  reasoner: agentAddress,
  trace_id: `market-${marketId}-buy-step-1`,
  content: JSON.stringify(traceStep),
});

// The x402 server now serves GET /traces/:traceId
// A buyer calls it, pays USDC, and receives the content.
```

### 8.3 Verify Purchased Traces

A buyer receives:
```json
{
  "traceId": "market-123-buy-step-1",
  "content": "{...}",
  "proof": "signature"
}
```

They verify the trace on-chain:

```typescript
const verified = await reasoningRegistry.verify_trace({
  trace_id: traceId,
  content: receivedContent,
});

console.log('Trace verified:', verified);  // true if hash matches
```

---

## Part 9: Risk Model and Safety

### Treasury Caps

Your treasury registration sets three limits:

| Limit | Meaning | Example |
|-------|---------|---------|
| `max_trade` | Largest single buy/sell | 10,000 USDC |
| `max_market` | Total exposure per market | 50,000 USDC |
| `max_daily` | Sum of daily trades | 100,000 USDC |

The treasury enforces these on every `agent_buy` and market creation.

### Key Compromise

If your agent key is stolen:
- An attacker can trade within your caps.
- They **cannot** withdraw treasury funds (requires admin auth).
- They **cannot** change your registered address or admin.
- They can only **spend** what's pre-approved in the treasury.

**Mitigation:** Rotate your agent key frequently or use a time-locked authorizer.

### Oracle Failure

If the price oracle goes down or becomes invalid:
- Price-based resolution fails.
- Use `guardian_void_market` (admin-only) to refund traders.

### Ambiguous Signers

If your signer set is ambiguous (e.g., signers control the same keys):
- The resolver can still finalize if the threshold is reached.
- Document your signer set clearly.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `SpecHashMismatch` | Revealed spec doesn't match commitment. | Ensure XDR encoding is canonical; use the scripts/spec-hash tool to verify. |
| `MarketNotFound` | Market ID doesn't exist. | Check the ID was returned from `agent_create_market`. |
| `CapExceeded` | Trade size or daily usage exceeds limit. | Reduce trade size or request higher caps from admin. |
| `InsufficientShares` | Tried to sell more than you own. | Check your position with `get_position`. |
| `MarketClosed` | Trying to trade after close_time. | Wait until resolution is complete, then redeem. |
| `DisputeWindowOpen` | Signers finalization too early. | Wait for dispute_window to pass (7 days in this example). |
| `NoProposalToFinalize` | Never revealed a signer spec. | Call `register_signer_spec` before finalizing. |

---

## Example: Full Workflow

```bash
# 1. Local network
stellar container start local

# 2. Generate accounts
stellar keys generate --fund --network local agent

# 3. Set up contracts (via deploy script or manual)
export MARKET_CORE=CA...
export RESOLVER=CA...
export TREASURY=CA...

# 4. Configure treasury
soroban contract invoke --id $TREASURY -- register_agent --agent $AGENT --max_trade 100000000 --max_market 500000000 --max_daily 1000000000

# 5. Deposit capital
soroban contract invoke --id $TREASURY -- deposit --amount 1000000000

# 6. Create market with commitment
npm run create-market

# 7. Publish and trade
npm run trade

# 8. Wait for close_time (or hardcode a past close_time for testing)

# 9. Reveal spec
npm run reveal-spec

# 10. Finalize
npm run finalize

# 11. Redeem
npm run redeem
```

---

## See Also

- [OracleDesk Architecture](./docs/architecture.md)
- [ADR 0001: Resolution Commitment](./docs/adr/0001-resolution-commitment.md)
- [Treasury Ledger Design](./docs/treasury-ledger.md)
- [x402 Protocol](https://www.x402.org/)
- [Reference Agent Implementation](../examples/reference-agent/)
- [Stellar SDK Docs](https://stellar.github.io/js-stellar-sdk/)

---

**Questions?** Open an issue on [GitHub](https://github.com/OracleDesk/OracleDesk-SmartContract/issues).
