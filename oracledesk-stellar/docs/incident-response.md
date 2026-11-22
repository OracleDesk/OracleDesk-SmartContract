# OracleDesk Incident Response Toolkit

This document provides operational procedures for responding to security incidents and service disruptions in OracleDesk. It is maintained alongside the emergency scripts in `scripts/emergency/`.

## Overview

The OracleDesk system is an autonomous agent controlling a treasury that participates in markets. Several failure modes require immediate operational response:

1. **Agent key compromise** — the agent's signing key is leaked
2. **Runaway strategy** — the agent burns through daily limits repeatedly or maliciously
3. **Market-core bug** — a contract defect is discovered on a live market
4. **Oracle/signer misbehaviour** — an oracle or signer acts adversarially on a live market
5. **Admin key compromise** — the treasury admin is compromised
6. **Trace oracle misconfiguration** — x402 serves unverified traces

Each scenario has an operational runbook with exact commands, verification steps, and decision trees.

## Deployment Configuration

All scripts rely on `deployments/{NETWORK}.json` containing contract addresses:

```json
{
  "market_core": "CXXXXXX...",
  "resolver": "CXXXXXX...",
  "treasury": "CXXXXXX...",
  "reasoning_registry": "CXXXXXX...",
  "collateral_token": "CXXXXXX..."
}
```

Set `NETWORK=testnet|local` to choose deployment. Default is `testnet`.

## Scenario 1: Agent Key Compromise

**Trigger:** Agent key is exposed (leaked in logs, github, etc.) or suspected compromised

**Severity:** Critical — attacker can drain trading capital

### On-Chain Capability Assessment

- `market-core.set_paused(true)` — blocks `create_market`, `buy`, `sell` but NOT `redeem`, `claim_pool_remainder`, or `sweep_fees`
- `treasury.set_paused(true)` — blocks `agent_create_market`, `agent_buy`, `agent_sell`
- `reasoning_registry.unregister_agent(agent)` — prevents market creation and trace publishing
- **Gap:** No agent rotation in treasury; must redeploy to change `RiskConfig.agent`

### Runbook: Contain Agent Compromise

```bash
# 1. Pause treasury immediately (stops agent spending)
./scripts/emergency/pause-all.sh --yes

# 2. Deregister agent (stops market creation)
./scripts/emergency/contain-agent.sh <agent_address> --yes

# 3. Assess positions and capital at risk
./scripts/emergency/status.sh

# 4. If capital evacuation needed
./scripts/emergency/evacuate-treasury.sh <safe_address> all --yes

# 5. Void any markets with active exposure
./scripts/emergency/quarantine-markets.sh <market_id> [market_id ...] --yes
```

### Verification Steps

1. `treasury.get_config()` returns `paused == true`
2. `treasury.agent_buy(...)` fails with `Error(Contract, #10)` (Paused)
3. `reasoning_registry.is_registered(agent)` returns `false`
4. If evacuated, collateral balance of `<safe_address>` increases

### Post-Incident

- Rotate agent key (requires treasury redeployment)
- Audit all trades executed by compromised key
- Notify affected traders
- Review key management procedures

---

## Scenario 2: Runaway Strategy

**Trigger:** Agent consumes daily cap every day or in suspicious patterns

**Severity:** High — daily limits are breached or approaching limit

### On-Chain Capability Assessment

- `treasury.set_paused(true)` — stops trading immediately
- `treasury.daily_usage()` — read current window's consumption
- **Gap:** No circuit-breaker to pause after threshold; daily cap is enforced per-call

### Runbook: Halt Runaway Strategy

```bash
# 1. Pause treasury to stop further trades
./scripts/emergency/pause-all.sh --yes

# 2. Check daily usage and open positions
./scripts/emergency/status.sh

# 3. Analyze which markets are problematic
# (Read treasury MarketExposure for each market_id)

# 4. Void markets with excessive exposure
./scripts/emergency/quarantine-markets.sh <market_id> [market_id ...] --yes

# 5. Decide: restart with rate-limited policy or evacuate
```

### Verification Steps

1. `treasury.daily_usage()` returns usage < `max_daily`
2. `market-core.get_market(id).status` is `Void` for quarantined markets
3. After pausing, all future `agent_buy` calls fail with `Error(Contract, #10)`

### Post-Incident

- Analyze strategy logs for root cause (misconfiguration, bug, attack)
- If legitimate misconfiguration, adjust `max_daily` via timelock
- If bug, roll back strategy code
- Resume with reduced caps and manual oversight

---

## Scenario 3: Market-Core Bug Discovery

**Trigger:** A contract defect is reported or discovered that affects live markets

**Severity:** High — correctness of market settlement is at stake

### On-Chain Capability Assessment

- `market-core.set_paused(true)` — blocks market operations
- `resolver.guardian_void_market(id)` — immediately resolves market as `Void`
- **Gap:** No selective pause per market; must pause all trading

### Runbook: Isolate Affected Markets

```bash
# 1. Pause market-core to halt all trading
./scripts/emergency/pause-all.sh --yes

# 2. Identify markets affected by the bug
# (depends on specific defect; consult issue report)

# 3. Void affected markets to settle early
./scripts/emergency/quarantine-markets.sh <market_id1> <market_id2> ... --yes

# 4. Verify unaffected markets can still resolve
# (use resolver.finalize_* on a test market)

# 5. Begin deployment of patched market-core
```

### Verification Steps

1. `market-core.get_config().paused == true`
2. `market-core.get_market(id).status == MarketStatus::Void` for voided markets
3. Unaffected markets still transition through resolve states normally

### Post-Incident

- Compile and audit the patched binary against the bug report
- Coordinate deployment across all hosts
- Regenerate bindings and update deployment procedures
- Document the bug in `docs/STATUS.md`

---

## Scenario 4: Oracle/Signer Misbehaviour

**Trigger:** An oracle or signer votes adversarially, votes both outcomes, refuses to vote, or is otherwise unreliable

**Severity:** Medium to High depending on market size and outcome

### On-Chain Capability Assessment

- `resolver.cancel_proposal(market_id)` (admin) — resets votes and allows re-attestation
- `resolver.guardian_void_market(market_id)` — immediately resolves as `Void`
- **Gap:** No slashing or stake requirement yet; misbehaviour is costless
- **Gap:** No signer rotation or committee support today

### Runbook: Resolve Disputed Market

```bash
# 1. Assess the disputed market
./scripts/emergency/status.sh
# (check resolver state, signers, attestations)

# 2. Option A: Wait for guardian grace period (7 days)
# Then:
./scripts/emergency/quarantine-markets.sh <market_id> --yes

# Option B: Void immediately if critical
./scripts/emergency/quarantine-markets.sh <market_id> --yes

# 3. Analyze signer behaviour
# (requires off-chain log inspection; on-chain readonly)
```

### Verification Steps

1. `resolver.get_market_state(id)` shows current state
2. `resolver.get_market_state(id).state == State::Void` after void
3. LP can claim returned liquidity without outcome dependency

### Post-Incident

- Analyze event logs: did signer equivocate? Refuse? Vote wrong?
- If signer is unreliable, build case for removal from future markets
- If oracle feed is bad, replace it in new markets
- Once slashing is live, penalize confirmed misbehaviour

---

## Scenario 5: Admin Key Compromise

**Trigger:** Treasury or market-core admin key is exposed or compromised

**Severity:** Critical — admin can drain treasury and modify all contracts

### On-Chain Capability Assessment

- **No protection:** All admin functions are callable by the compromised key
- `treasury.withdraw()` — admin can drain any amount
- `treasury.set_paused()` — admin can pause indefinitely
- `market-core.set_treasury()` / `set_resolver()` — admin can redirect fees
- **Gap:** No admin transfer / multisig / timelock on treasury today

### Runbook: Isolate Compromised Admin

**CRITICAL: This scenario has LIMITED on-chain remediation today.**

```bash
# 1. Freeze operations manually:
# - Stop all off-chain agents immediately
# - Suspend accepting new markets
# - Notify all traders

# 2. Contact hosts running market-core and treasury contracts
# - Request emergency pause via constellation or L0 protocol
# - Or, deploy a proxy contract that blocks the compromised admin

# 3. Plan redeployment:
# - New treasury with new admin key (held in multisig or Terraform)
# - Point market-core to new treasury address
# - Coordinate with all agents and traders

# 4. Execute redeployment (off-chain, requires coordination)
```

### Post-Incident

- Rotate all admin keys immediately
- Implement multisig or timelock on admin functions (issue #62)
- Audit all admin actions between compromise time and isolation
- Publish post-mortem

---

## Scenario 6: Trace Oracle Misconfiguration

**Trigger:** x402 endpoint serves unverified or incorrect traces

**Severity:** Medium — affects agent decision inputs only, not on-chain safety

### On-Chain Capability Assessment

- `reasoning_registry.publish_trace_signed()` — trace author can prove possession of key
- `reasoning_registry.get_trace_signature()` — anyone can verify published trace
- On-chain data is never trusted in settlement (only on-chain observations matter)

### Runbook: Verify Trace Integrity

```bash
# 1. Check x402 URL and service health

# 2. Verify on-chain published traces
./scripts/emergency/status.sh
# (check reasoning registry for recent traces)

# 3. If traces are verified on-chain but x402 differs:
#    x402 is malfunctioning; restart or investigate logs

# 4. If traces were never published to on-chain registry:
#    off-chain cache issue; refresh from registry

# 5. Agents automatically fall back to on-chain data only
#    (no emergency pause needed unless feed is completely unreliable)
```

### Verification Steps

1. Fetch trace hash from x402
2. `reasoning_registry.get_trace_signature(hash)` should return valid signature
3. Verify signature offline against known agent public key

### Post-Incident

- Identify root cause (bad configuration, service outage, attack)
- If outage, restart service
- If attack or misconfiguration, audit x402 audit logs
- Consider rate-limiting x402 responses

---

## Missing Capabilities & Follow-ups

The runbooks above identify gaps in the on-chain system. Each gap blocks a full remedy:

| Scenario | Gap | Proposal | Tracking |
|----------|-----|----------|----------|
| Agent compromise | No agent rotation without redeployment | Add `treasury.set_agent(Address)` (admin) with event | Follow-up issue |
| Runaway strategy | Daily caps checked atomically, not progressive | Add settle-and-reduce-only mode while paused | Follow-up issue |
| Market bug | Pause affects all markets, not just affected ones | Add selective per-market or per-core pause flag | Follow-up issue |
| Signer misbehaviour | Misbehaviour is costless | Add signer staking with slashing (issue #138) | Active |
| Admin compromise | No transfer or multisig | Add `propose_admin` / `accept_admin` with timelock | Follow-up issue |
| Trace oracle | Fallback to on-chain is automatic | Document fallback behaviour | Docs |

---

## Drill: Simulated Agent Compromise on Local Network

A CI drill (`scripts/emergency/drill.sh`) simulates agent compromise and verifies containment:

1. Start local Soroban network
2. Deploy all contracts
3. Create a market and seed it
4. Have agent execute trades up to daily cap
5. Simulate compromise (switch agent identity)
6. Run containment runbook
7. Assert:
   - Treasury is paused
   - Agent is deregistered
   - Existing positions are **not** liquidated (by design; only future trades blocked)
   - Unsafe address balance is 0 (no assets leaked)
   - Completion within N steps

The drill is run on `workflow_dispatch` and weekly via CI.

---

## Approval & Authority

Who may execute which script (requires coordination before mainnet):

| Script | Authority | Prerequisites |
|--------|-----------|----------------|
| `pause-all.sh` | Ops on-call, Platform  | Consensus among ops team |
| `contain-agent.sh` | Ops on-call | Confirmed compromise evidence |
| `evacuate-treasury.sh` | Executive decision / Governance | Critical financial risk |
| `quarantine-markets.sh` | Resolver admin (ops) | Market bug or oracle consensus |
| `status.sh` | Anyone | Read-only |

---

## References

- [OracleDesk Architecture](./architecture.md)
- [System Model](./system-model.md)
- [Formal Verification](./formal-verification.md)
- [ADR 0001: Resolution Commitment](./adr/0001-resolution-commitment.md)
