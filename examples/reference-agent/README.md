# OracleDesk Reference Agent

A standalone, minimal TypeScript agent implementation for OracleDesk. This example shows how to build an autonomous agent that creates markets, trades them, publishes reasoning traces, and handles resolution—using only published bindings and public SDKs, with no imports from the repo's internal paths.

## Purpose

This reference agent serves two goals:

1. **Educational:** Walk through the full lifecycle of an OracleDesk agent (create → trade → resolve → redeem).
2. **CI/CD validation:** Runs against a local Stellar network on every PR to verify that the contract interfaces and bindings remain stable as code changes.

## Project Structure

```
examples/reference-agent/
  ├── package.json          # Dependencies: @stellar/stellar-sdk, TypeScript
  ├── tsconfig.json         # TypeScript configuration
  ├── src/
  │   ├── config.ts         # Environment loading and validation
  │   ├── spec.ts           # Resolution spec hash computation
  │   ├── trace.ts          # Reasoning trace canonicalization
  │   ├── lifecycle.ts      # Market creation, trading, resolution flow
  │   └── main.ts           # Entry point
  └── README.md             # This file
```

## Getting Started

### Prerequisites

- Node.js 16+ and npm
- Stellar CLI (v20+)
- Access to a local Stellar network (or testnet/mainnet)

### Installation

```bash
cd examples/reference-agent
npm install
```

### Configuration

Set environment variables for your network and contracts:

```bash
# Network
export STELLAR_RPC_URL="http://localhost:8000/soroban/rpc"
export STELLAR_NETWORK_PASSPHRASE="Standalone Network; February 2021"

# Contract addresses (from deployment)
export MARKET_CORE_ID="CA..."
export RESOLVER_ID="CA..."
export TREASURY_ID="CA..."
export REASONING_REGISTRY_ID="CA..."
export COLLATERAL_TOKEN="CA..."

# Agent credentials
export AGENT_SECRET="SAAA..."
export AGENT_PUBLIC_KEY="GA..."
export ADMIN_PUBLIC_KEY="GA..."

# Market parameters (optional)
export SEED_AMOUNT="1000000000"      # 100 USDC
export BOUNTY_AMOUNT="100000000"     # 10 USDC
export CLOSE_TIME="<unix-timestamp>" # Leave empty for 24h from now
```

### Run

```bash
npm start
```

This:
1. Loads configuration from environment
2. Verifies golden vector hashes against the contract spec
3. Runs the full agent lifecycle (create market → trade → resolve → redeem)

## Workflow

### Phase 1: Create Market

The agent commits to a resolution rule (signer set or price) before the market opens. The commitment is a `sha256(XDR(ResolutionSpec))` hash, stored immutably in the market.

```typescript
const spec = {
  signers: [agentAddress],
  threshold: 1,
  dispute_window: 604800,  // 7 days
};
const hash = signerSpecHash(spec);  // Commitment
// Market created with this hash
```

### Phase 2: Trade

After creating the market, the agent publishes reasoning traces *before* executing trades (proving decisions were made in advance, not based on outcomes).

```typescript
// 1. Build trace explaining the trade
const trace = buildBuyTrace(marketId, 'Yes', amount, 'Model predicts 70%');

// 2. Publish trace (hash is now immutable)
await reasoningRegistry.publish_trace({ content: JSON.stringify(trace) });

// 3. Execute trade
await marketCore.buy({ ... });
```

### Phase 3: Resolve

Once the market closes, the agent reveals the resolution spec and waits for finalization.

```typescript
// Reveal the commitment
await resolver.register_signer_spec({ market_id, config: spec });

// Wait for dispute window (7 days in this example)
// Then finalize
await resolver.finalize_signers_for({ caller: agent, market_id });
```

### Phase 4: Redeem

Claim the settlement and any LP fees.

```typescript
const payout = await marketCore.redeem({ holder: agent, market_id });
const remainder = await marketCore.claim_pool_remainder({ market_id });
```

## Key Design Points

### Canonical Traces

Traces are JSON objects that must be canonicalized (keys sorted, no extra whitespace) before hashing. This ensures that the same trace always hashes to the same value, even if encoded differently elsewhere.

```typescript
// Golden vector test
const trace = { action: 'buy', amount: '100', market_id: 1 };
const canonical = canonicalizeTrace(trace);  // Keys sorted, predictable
const hash = traceHash(trace);               // Always same value
```

### Resolution Commitment

The XDR encoding of the resolution spec must match Soroban's struct-to-map serialization (structs as maps, keys sorted alphabetically). The golden vectors in `src/spec.ts` are pre-computed and verified against `scripts/spec-hash` output in CI.

```typescript
const spec = { signers: [...], threshold: 2, dispute_window: 604800 };
const hash = signerSpecHash(spec);  // Must match Soroban's hash
```

### Pre-auth Transfers (Treasury)

When the treasury creates a market, it must pre-authorize the transfer of seed capital to market-core. This is done via `authorize_as_current_contract`, a Soroban auth feature that lets the treasury sign multiple nested transfers in one approval.

```rust
// In treasury (Rust pseudocode):
authorize_as_current_contract(vec![
  transfer(treasury, market_core, seed),
  transfer(treasury, resolver, bounty),  // If bounties enabled
]);
market_core.create_market(...);
resolver.fund_bounty(...);
```

## Testing

```bash
# Unit tests (if added)
npm test

# End-to-end on local network
stellar container start local
npm run e2e
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `SpecHashMismatch` | Canonical encoding differs from Soroban's | Verify golden vectors against `scripts/spec-hash`. |
| `MarketNotFound` | Invalid market ID | Ensure market was created successfully. |
| `CapExceeded` | Trade exceeds treasury caps | Reduce trade size or increase caps. |
| `NoProposalToFinalize` | Never revealed spec | Call `register_signer_spec` before finalizing. |

## Production Considerations

1. **Key Management:** Store agent secrets securely (HSM, vault, etc.). Rotation recommended.
2. **Treasury Caps:** Set conservative caps; expose them in monitoring.
3. **Network Selection:** Testnet before mainnet. Validate all contracts on deployment.
4. **Monitoring:** Log all trades and resolutions; monitor for oracle failures or stalled resolutions.
5. **Fallback:** Have manual resolution (admin void) ready if resolution gets stuck.

## See Also

- [Building a Third-Party Agent Guide](../../docs/build-an-agent.md)
- [OracleDesk Architecture](../../docs/architecture.md)
- [ADR 0001: Resolution Commitment](../../docs/adr/0001-resolution-commitment.md)
- [Treasury Ledger Design](../../docs/treasury-ledger.md)
- [Stellar SDK Docs](https://stellar.github.io/js-stellar-sdk/)

## License

Apache License 2.0. See [LICENSE](../../LICENSE).

---

**Contributing?** Open an issue or PR on [GitHub](https://github.com/OracleDesk/OracleDesk-SmartContract).
