# OracleDesk Smart Contract Events Catalogue

This document defines all events emitted by OracleDesk contracts. It serves as the authoritative schema for the backend indexer, monitoring services, and audit trails.

## Event Versioning Strategy

Events follow a two-tier versioning model:

### Existing v0 Events (Frozen)
Events that existed before this issue are immutable and do NOT carry a version topic. Their topic layouts are fixed:
- Topic 0: event name (symbol)
- Topic 1+: entity IDs (market_id, trader, etc.)
- Data: remaining fields

**Rationale**: Existing commitments and indexers depend on v0 topic order. Changing them would require reindexing all historical data.

**Examples**: MarketCreated, Trade, MarketResolved, PriceResolution, Attested, TradeAuthorized, TracePublished

### New v1+ Events (Versioned)
All new events introduced in this issue carry an explicit version topic to enable future evolution without breaking indexers.

**Topic Layout**:
- Topic 0: event name (symbol)
- Topic 1: `u32` schema version (currently `1`)
- Topic 2+: entity IDs in order (market_id, then actor address, etc.)
- Data: remaining fields

**Rationale**: When a new field is added in v2, topic order stays constant. Indexers keyed on `(contract, topic0, topic1)` can dispatch to v1 or v2 decoders based on version.

---

## Market-Core Contract

**Contract ID**: Defined in deployment manifest

### Existing v0 Events

| Event Name | Topics | Data Fields | Emitted By |
|---|---|---|---|
| **MarketCreated** | market_id, creator, category | close_time, seed_amount, initial_yes_bps | create_market |
| **Trade** | market_id, trader, outcome | is_buy, collateral_in, shares_out, fee_bps, reserve_yes_new, reserve_no_new | buy, sell, agent_buy, agent_sell (from treasury) |
| **MarketResolved** | market_id, outcome? | (none) | resolve, void_market |
| **Redeemed** | market_id, holder | payout | redeem, claim_lp_fees, claim_pool_remainder |
| **FeesSwept** | market_id | amount | sweep_fees |
| **FeesSweptTo** | market_id | amount, recipient | sweep_fees_to |

### New v1 Events (This Issue)

| Event Name | Topics | Data Fields | Emitted By | Rationale |
|---|---|---|---|---|
| **PoolRemainderClaimed** | version(u32), market_id, creator | payout | claim_pool_remainder | Creator withdraws LP remainder after finality |
| **PausedSet** | version(u32) | paused: bool | set_paused | Admin pauses/resumes trading |
| **DefaultFeeSet** | version(u32) | old_fee_bps, new_fee_bps | set_default_fee_bps | Admin updates market creation fee |

**Emission Rules**:
- `PoolRemainderClaimed`: After `lp_claimed` flag is set and collateral transferred
- `PausedSet`: After pause state is updated
- `DefaultFeeSet`: Read old fee **before** overwriting, emit both values

---

## Resolver Contract

**Contract ID**: Defined in deployment manifest

### Existing v0 Events

| Event Name | Topics | Data Fields | Emitted By |
|---|---|---|---|
| **PriceResolution** | market_id | price, timestamp, outcome | resolve_price |
| **ResolutionProposed** | market_id | outcome | register_signers (proposal step) |
| **ResolutionFinalized** | market_id | outcome, finalized_at | submit_signatures (after threshold) |

### New v1 Events (This Issue)

| Event Name | Topics | Data Fields | Emitted By | Rationale |
|---|---|---|---|---|
| **SpecRegistered** | version(u32), market_id | mode: Symbol, resolution_hash: BytesN<32> | register_price_spec, register_signer_spec, register_market_spec | Spec is revealed and validated against commitment |
| **Attested** | version(u32), market_id, signer | outcome, count | submit_signatures | Signer attests to an outcome (tracks running count per outcome) |
| **LinkedResolution** | version(u32), market_id | source_market_id, source_status: Symbol, result: Symbol | resolve_linked | Market-linked resolution outcome applied |

**Emission Rules**:
- `SpecRegistered`: After hash validation passes, before state is set
  - mode: `"price"`, `"signers"`, `"market"` as symbol (string values)
  - resolution_hash: The XDR-committed hash
- `Attested`: Every time a new signature passes, includes running count per market/outcome
  - Indexers can verify count increments are sequential (detect skips)
- `LinkedResolution`: After mapping source outcome to linked result and calling market-core resolve/void

---

## Treasury Contract

**Contract ID**: Defined in deployment manifest

### Existing v0 Events

| Event Name | Topics | Data Fields | Emitted By |
|---|---|---|---|
| **TradeAuthorized** | market_id, agent | amount, market_total, daily_total | agent_buy, agent_sell |
| **PositionClosed** | market_id | amount | agent_redeem, agent_claim_pool_remainder |
| **FeesCollected** | market_id | amount | on_fee (sweep_fees from market-core) |

### New v1 Events (This Issue)

| Event Name | Topics | Data Fields | Emitted By | Rationale |
|---|---|---|---|---|
| **Deposited** | version(u32), from | amount, shares | deposit | Capital deposited to treasury |
| **Withdrawn** | version(u32), to | amount | withdraw, claim_pool_remainder | Capital withdrawn from treasury |
| **TreasuryPausedSet** | version(u32) | paused: bool | set_paused | Admin pauses/resumes treasury operations |
| **AgentSold** | version(u32), market_id, outcome | collateral_out, shares_in | agent_sell | Agent liquidates position |
| **AgentRedeemed** | version(u32), market_id | payout | agent_redeem | Agent redeems shares after market resolution |
| **AgentPoolClaimed** | version(u32), market_id | payout | agent_claim_pool_remainder | Agent claims LP remainder |

**Emission Rules**:
- `Deposited` / `Withdrawn`: Track flows in and out of treasury
- `TreasuryPausedSet`: Named distinctly from market-core's `PausedSet` (decoder can distinguish without contract address if needed)
- `AgentSold` / `AgentRedeemed` / `AgentPoolClaimed`: Emitted by treasury, tracking agent actions
  - Even though market-core emits `Redeemed`, treasury emits `AgentRedeemed` to track agent-initiated redemptions separately

---

## Reasoning-Registry Contract

**Contract ID**: Defined in deployment manifest

### Existing v0 Events

| Event Name | Topics | Data Fields | Emitted By |
|---|---|---|---|
| **AgentRegistered** | agent | (none) | register_agent |
| **TracePublished** | trace_id, market_id, agent | action: Symbol, trace_hash: BytesN<32>, ipfs_cid: String, published_at: u64 | publish_trace |

### New v1 Events (This Issue)

| Event Name | Topics | Data Fields | Emitted By | Rationale |
|---|---|---|---|---|
| **AgentUnregistered** | version(u32), agent | (none) | unregister_agent | Agent is deregistered (retired or revoked) |

**Emission Rules**:
- `AgentUnregistered`: After agent status is changed to Retired or Revoked
  - Allows indexers to track agent lifecycle end

---

## Event Consumer Integration Guide

### Backend Indexer

Indexers should key decoders on the tuple `(contract_id, topic0, topic1)`:

```
contract_id: Address
topic0: Symbol (event name)
topic1: u32 or u64 (version for v1+, or market_id for v0)

Example decoders:
- (MarketCore, "MarketCreated", <ignored>) → v0 MarketCreated handler
- (Resolver, "SpecRegistered", 1) → v1 SpecRegistered handler (version = 1)
- (Treasury, "Deposited", 1) → v1 Deposited handler (version = 1)
```

### Cross-Contract Event Sequences

When a single user action triggers events across multiple contracts, they appear in the same transaction ledger:

**Scenario: Agent creates market atomically (issue #64)**
1. `treasury.agent_create_market_and_reveal()`
2. Internally calls: `market_core.create_market()`
3. Internally calls: `resolver.register_spec_v2()`
4. Expected events in order:
   - **MarketCreated** (from market-core, topic0="MarketCreated")
   - **SpecRegistered** (from resolver, topic0="SpecRegistered", topic1=1)
5. All in same transaction (ledger sequence), deterministic event order within contract

**Note**: Treasury does not emit an event for this flow; it's an atomic operation within the market-core contract invocation.

### Event Deduplication

Events are immutable once written to the ledger. Indexers should:
1. Track event source: `(tx_hash, event_index_in_tx)`
2. Deduplicate on replay (if re-indexing)
3. Store event hash (`sha256(event_xdr)`) for idempotency

---

## Testing Strategy

Each contract with new events adds tests following this pattern:

```rust
#[test]
fn {operation}_emits_{event_name}() {
    let env = Env::new();
    // Setup...
    let tx_result = env.invoke_contract(...);
    
    let events = env.events().all();
    let emitted: Vec<_> = events.into_iter()
        .filter(|e| e.contract_id == &contract_id)
        .collect();
    
    assert_eq!(emitted.len(), 1);
    let event = emitted[0];
    assert_eq!(event.topics[0], Symbol::new(&env, "EventName"));
    assert_eq!(event.topics[1], 1u32); // version
    assert_eq!(event.topics[2], expected_market_id); // topic 2
    // Assert data fields...
}

#[test]
fn {operation}_on_failure_emits_no_events() {
    let env = Env::new();
    // Setup to fail...
    let result = env.invoke_contract(...);
    assert!(result.is_err());
    
    let events = env.events().all();
    assert_eq!(events.len(), 0); // Events discarded on revert
}
```

### Cost Measurement

Add a test helper measuring resource usage:

```rust
#[test]
#[ignore]  // Run with --ignored event_costs
fn event_costs() {
    let mut costs = Vec::new();
    
    for (name, operation) in [("buy", buy_market), ("sell", sell_market), ...] {
        let env = Env::new();
        let budget = env.budget();
        operation(&env);
        
        costs.push((
            name,
            budget.cpu_insn,
            budget.mem_bytes,
            budget.events_bytes,
        ));
    }
    
    // Print table
    println!("Event cost report:");
    for (name, cpu, mem, events) in &costs {
        println!("{:<20} CPU: {:<10} MEM: {:<10} EVENTS: {:<10}", ...);
    }
}
```

Run with:
```bash
cargo test --workspace -- --ignored event_costs
```

---

## Backwards Compatibility

- **v0 events**: Never change (no version topic for a reason)
- **Adding v1 events**: Does not affect v0 events; indexers unaware of v1 simply ignore them
- **Future v2 events**: Will have `topic1 = 2`, allowing parallel indexing of v1 and v2
- **Removing events**: Not recommended; instead emit a "deprecated" v2 event that carries less data

---

## References

- [ADR 0001: Resolution Commitment](./adr/0001-resolution-commitment.md) — ResolutionSpec encoding
- [Architecture Overview](./architecture.md) — Event-driven indexing context
- Soroban Events: https://developers.stellar.org/docs/learn/encyclopedia/contract-development/events
- RPC getEvents: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents

---

## Related Issues

- **Issue #145**: This catalogue (event surface completion)
- **Issue #141**: Treasury ledger segregation (may add ledger transfer events)
- **Issue #140 & #139**: Incident response toolkit (may reference events for triggering)
- **Wave Issues / 06**: Postgres event indexer (this doc feeds that work)
