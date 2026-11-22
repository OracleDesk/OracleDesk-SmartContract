# OracleDesk Protocol Specification — resolver Contract

This document specifies the resolver contract, which manages resolution commitments, holds bounty escrows, and finalizes market outcomes.

## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_DISPUTE_WINDOW` | 1209600 | 14 days in seconds (signers only). |
| `BUMP_BOUNTY_ENTRY` | 2592000 | TTL bump for bounty escrows (30 days). |
| `BUMP_SPEC_ENTRY` | 2592000 | TTL bump for spec entries. |

## Instance Storage

| Key | Type | Notes |
|-----|------|-------|
| `I[Admin]` | `Address` | Admin address (can void markets, set bounty token). |
| `I[MarketCore]` | `Address` | The market-core contract address. |
| `I[BountyToken]` | `Address` | The token for bounty escrows (usually collateral). |

---

## Persistent Storage (Resolution Specs)

| Key | Type | Notes |
|-----|------|-------|
| `P[SignerSpec(market_id)]` | `SignerConfig` | Registered signer spec. Deleted once a proposal is finalized/cancelled. |
| `P[PriceSpec(market_id)]` | `PriceConfig` | Registered price spec. |
| `P[SignerProposal(market_id)]` | `SignerProposal` | Current signer proposal state (count, threshold, dispute_window, created_at). |
| `P[Attestations(market_id, signer)]` | `bool` | True if `signer` has attested to the current proposal. |
| `P[ProposalCreatedAt(market_id)]` | `u64` | Timestamp when the proposal was created. |

---

## Persistent Storage (Bounties, New Issue #149)

| Key | Type | Notes |
|-----|------|-------|
| `P[Bounty(market_id)]` | `BountyEscrow` | Escrow entry: amount, funder, paid flag. |

**BountyEscrow struct:**

```rust
pub struct BountyEscrow {
    pub amount: i128,         // Amount in collateral tokens
    pub funder: Address,      // Who funded the bounty
    pub paid: bool,           // True after bounty was paid or refunded
}
```

---

## Entrypoints (Core)

### `register_signer_spec`

Reveals the signer specification for a market (commit/reveal pattern).

**AUTH-1** None (permissionless; anyone can reveal if they know the hash preimage).

**PRE-1** `P[Market(market_id)]` exists in market-core (checked via market-core call).
**PRE-2** No prior spec registered for this market (check: neither `SignerSpec` nor `PriceSpec` exists).
**PRE-3** `sha256(XDR(ResolutionSpec::Signers(config))) == P[Market(market_id)].resolution_hash` else `SpecHashMismatch(1)`.
**PRE-4** `config.threshold > 0 && config.threshold <= config.signers.len()` else `InvalidThreshold(2)`.
**PRE-5** `config.dispute_window <= MAX_DISPUTE_WINDOW` else `DisputeWindowTooLarge(3)`.

**POST-1** `P[SignerSpec(market_id)]` = `config`.
**POST-2** `P[SignerProposal(market_id)]` = `{count: 0, threshold: config.threshold, dispute_window: config.dispute_window, ...}`.
**POST-3** `P[ProposalCreatedAt(market_id)]` = `now`.
**POST-4** Spec entry TTL-bumped.

**EVT-1** `SignerSpecRegistered { market_id, signers_count: config.signers.len(), threshold: config.threshold }`.

**ERR-1** `SpecHashMismatch(1)` if hash does not match.
**ERR-2** `InvalidThreshold(2)` if threshold is invalid.
**ERR-3** `DisputeWindowTooLarge(3)` if dispute window exceeds max.
**ERR-4** `SpecAlreadyRegistered(4)` if a spec already exists for this market.

---

### `register_price_spec`

Reveals the price specification for a market.

**AUTH-1** None (permissionless).

**PRE-1** `P[Market(market_id)]` exists in market-core.
**PRE-2** No prior spec registered for this market.
**PRE-3** `sha256(XDR(ResolutionSpec::Price(config))) == P[Market(market_id)].resolution_hash` else `SpecHashMismatch(1)`.

**POST-1** `P[PriceSpec(market_id)]` = `config`.
**POST-2** Spec entry TTL-bumped.

**EVT-1** `PriceSpecRegistered { market_id, feed, threshold }`.

**ERR-1** `SpecHashMismatch(1)` if hash does not match.
**ERR-2** `SpecAlreadyRegistered(4)` if a spec already exists.

---

### `attest`

Signer attests to a signer proposal.

**AUTH-1** `auth(signer)`.

**PRE-1** `P[SignerSpec(market_id)]` exists else `SpecNotRegistered(5)`.
**PRE-2** `signer` is in the spec's signer set else `SignerNotInSet(6)`.
**PRE-3** `P[Attestations(market_id, signer)] != true` else `AlreadyAttested(7)` (each signer attests once).
**PRE-4** `now >= P[ProposalCreatedAt(market_id)] + MIN_ATTEST_DELAY` (soft; check documented in code if enforced).

**POST-1** `P[Attestations(market_id, signer)]` = `true`.
**POST-2** `P[SignerProposal(market_id)].count` incremented.
**POST-3** Proposal entry TTL-bumped.

**EVT-1** `SignerAttested { market_id, signer, proposal_count: new count }`.

**ERR-1** `SpecNotRegistered(5)` if no signer spec exists.
**ERR-2** `SignerNotInSet(6)` if signer is not in the spec.
**ERR-3** `AlreadyAttested(7)` if this signer already attested.

---

### `cancel_proposal`

Cancels a signer proposal (can only be called by admin or the creator; design choice documented).

**AUTH-1** `auth(admin)` or design choice TBD (currently admin-only or creator-only; specify).

**PRE-1** `P[SignerProposal(market_id)]` exists else `NoProposalToCancel(8)`.
**PRE-2** Market status != `Finalized` (checked via market-core call).

**POST-1** `P[SignerProposal(market_id)]` deleted (or marked cancelled).
**POST-2** `P[Attestations(market_id, *)]` entries cleared.
**POST-3** `P[SignerSpec(market_id)]` deleted.

**EVT-1** `ProposalCancelled { market_id }`.

**ERR-1** `NoProposalToCancel(8)` if no proposal exists.
**ERR-2** `Unauthorized(9)` if caller lacks authority.

---

### `resolve_price`

Permissionless: resolves a market via price oracle (no bounty payout; kept for backward compatibility).

**AUTH-1** None (permissionless).

**PRE-1** `P[PriceSpec(market_id)]` exists else `SpecNotRegistered(5)`.
**PRE-2** `P[Market(market_id)]` status != `Finalized` else `AlreadyFinalized(10)`.
**PRE-3** `now >= P[Market(market_id)].close_time` else `MarketNotClosed(11)`.
**PRE-4** Price oracle returns a valid price (no stale/invalid check; assumed valid).

**POST-1** Calls `market_core.resolve(market_id, outcome)` where outcome is determined by price vs. threshold.
**POST-2** `P[PriceSpec(market_id)]` deleted.

**EVT-1** `PriceResolved { market_id, outcome }`.

**ERR-1** `SpecNotRegistered(5)` if no price spec.
**ERR-2** `AlreadyFinalized(10)` if already resolved.
**ERR-3** `MarketNotClosed(11)` if `now < close_time`.

---

### `resolve_price_for` (New, Issue #149)

Resolves via price and pays bounty to the caller.

**AUTH-1** `auth(caller)`.

**PRE-1** Same as `resolve_price` (PRE-1 through PRE-4).

**POST-1** Calls `market_core.resolve(market_id, outcome)`.
**POST-2** Calls `pay_bounty(market_id, caller)` (see below).

**EVT-1** `PriceResolvedFor { market_id, outcome, caller, bounty_paid }`.

**ERR-1** Same as `resolve_price`, plus auth failure if `auth(caller)` fails.

---

### `finalize_signers`

Permissionless: finalizes a signer proposal once threshold is reached (no bounty payout).

**AUTH-1** None (permissionless).

**PRE-1** `P[SignerProposal(market_id)]` exists else `NoProposalToFinalize(12)`.
**PRE-2** `now >= P[ProposalCreatedAt(market_id)] + P[SignerProposal(market_id)].dispute_window` else `DisputeWindowOpen(13)`.
**PRE-3** `P[SignerProposal(market_id)].count >= P[SignerProposal(market_id)].threshold` else `ThresholdNotReached(14)`.
**PRE-4** `P[Market(market_id)]` status != `Finalized` else `AlreadyFinalized(10)`.

**POST-1** Calls `market_core.resolve(market_id, Yes)` (signer proposals always resolve to Yes; design choice documented).
**POST-2** `P[SignerProposal(market_id)]` deleted.
**POST-3** `P[SignerSpec(market_id)]` deleted.
**POST-4** `P[Attestations(market_id, *)]` cleared.

**EVT-1** `SignersFinalized { market_id, threshold_reached: count }`.

**ERR-1** `NoProposalToFinalize(12)` if no proposal exists.
**ERR-2** `DisputeWindowOpen(13)` if dispute window still open.
**ERR-3** `ThresholdNotReached(14)` if attestation count < threshold.
**ERR-4** `AlreadyFinalized(10)` if already resolved.

---

### `finalize_signers_for` (New, Issue #149)

Finalizes signers and pays bounty to the caller.

**AUTH-1** `auth(caller)`.

**PRE-1** Same as `finalize_signers`.

**POST-1** Calls `market_core.resolve(market_id, Yes)`.
**POST-2** Calls `pay_bounty(market_id, caller)`.

**EVT-1** `SignersFinalizedFor { market_id, caller, bounty_paid }`.

**ERR-1** Same as `finalize_signers`, plus auth failure.

---

### `guardian_void_market`

Admin: voids a market and refunds any unpaid bounty to the funder.

**AUTH-1** `auth(admin)`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(15)`.
**PRE-2** `P[Market(market_id)].status != Finalized` else `AlreadyFinalized(10)`.

**POST-1** Calls `market_core.void_market(market_id)`.
**POST-2** Calls `refund_bounty(market_id)` (see below).

**EVT-1** `GuardianVoided { market_id }`.

**ERR-1** `MarketNotFound(15)` if market does not exist.
**ERR-2** `AlreadyFinalized(10)` if already finalized.
**ERR-3** `Unauthorized(9)` if caller is not admin.

---

## Bounty Entrypoints (New, Issue #149)

### `fund_bounty`

Funds a per-market resolution bounty.

**AUTH-1** `auth(funder)`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(15)`.
**PRE-2** `now < P[Market(market_id)].close_time` else `BountyFundingClosed(16)`.
**PRE-3** `amount > 0` else `InvalidAmount(17)`.
**PRE-4** No bounty exists, or existing bounty has the same funder (single funder constraint; design choice).

**POST-1** `P[Bounty(market_id)]` updated or created with new amount and funder.
**POST-2** `token.transfer(funder, resolver, amount)` executed.
**POST-3** Bounty entry TTL-bumped.

**EVT-1** `BountyFunded { market_id, funder, amount, total_bounty }`.

**ERR-1** `MarketNotFound(15)` if market does not exist.
**ERR-2** `BountyFundingClosed(16)` if `now >= close_time`.
**ERR-3** `InvalidAmount(17)` if `amount <= 0`.
**ERR-4** `BountyFunderMismatch` if bounty already exists with different funder.

---

### `pay_bounty` (Internal; called by resolve_price_for and finalize_signers_for)

Pays the bounty to the caller if one exists and hasn't been paid.

**AUTH-1** None (internal call; caller must already be auth'd by the resolution entrypoint).

**PRE-1** `P[Bounty(market_id)]` exists and `amount > 0`.
**PRE-2** `P[Bounty(market_id)].paid == false`.

**POST-1** `P[Bounty(market_id)].paid` = `true`.
**POST-2** `token.transfer(resolver, caller, amount)` executed (bounty paid out; effects before interactions).

**EVT-1** `BountyPaid { market_id, caller, amount }`.

**ERR-1** None (called only internally; errors are impossible given PRE conditions).

---

### `refund_bounty` (Internal; called by guardian_void_market)

Refunds unpaid bounty to the funder.

**AUTH-1** None (internal).

**PRE-1** `P[Bounty(market_id)]` exists.
**PRE-2** `P[Bounty(market_id)].paid == false`.

**POST-1** `P[Bounty(market_id)].paid` = `true`.
**POST-2** `token.transfer(resolver, funder, amount)` executed.

**EVT-1** `BountyRefunded { market_id, funder, amount }`.

---

### `set_bounty_token`

Admin: sets the token address for bounty escrows.

**AUTH-1** `auth(admin)`.

**PRE-1** `token` is a valid SEP-41 token address.
**PRE-2** `token == P[Market(any)].collateral` (enforced; bounty token must match collateral).

**POST-1** `I[BountyToken]` = `token`.

**ERR-1** `Unauthorized(9)` if not admin.
**ERR-2** `InvalidToken(18)` if token does not match market-core's collateral.

---

## View Functions

### `state`

Returns the current proposal state for a market (read-only snapshot).

**PRE-1** No preconditions.

**POST-1** Returns `{spec_type, count, threshold, dispute_window, created_at}` or `None` if no proposal.

---

## Error Codes (Resolver)

| Code | Name | Trigger |
|------|------|---------|
| 1 | `SpecHashMismatch` | Revealed spec doesn't match committed hash. |
| 2 | `InvalidThreshold` | Signer threshold out of valid range. |
| 3 | `DisputeWindowTooLarge` | Dispute window > MAX_DISPUTE_WINDOW. |
| 4 | `SpecAlreadyRegistered` | Spec already revealed for this market. |
| 5 | `SpecNotRegistered` | No spec registered for this market. |
| 6 | `SignerNotInSet` | Signer not in the registered signer set. |
| 7 | `AlreadyAttested` | Signer already attested to this proposal. |
| 8 | `NoProposalToCancel` | No active proposal to cancel. |
| 9 | `Unauthorized` | Caller is not authorized (admin, etc.). |
| 10 | `AlreadyFinalized` | Market already finalized. |
| 11 | `MarketNotClosed` | Market hasn't reached close_time yet. |
| 12 | `NoProposalToFinalize` | No proposal to finalize. |
| 13 | `DisputeWindowOpen` | Dispute window hasn't closed yet. |
| 14 | `ThresholdNotReached` | Signer count < threshold. |
| 15 | `MarketNotFound` | Market ID does not exist. |
| 16 | `BountyFundingClosed` | Bounty can't be funded after close_time. |
| 17 | `InvalidAmount` | Invalid or zero bounty amount. |
| 18 | `InvalidToken` | Bounty token doesn't match collateral. |

---

## Invariants

- `SYS-INV-6`: Resolver finalizes once (AlreadyFinalized guard on resolve/void).
- Bounty is paid exactly once (paid flag prevents re-payment).
- Bounty only paid on successful finalization (not on revert or partial failure).

## See Also

- `contracts/resolver/src/lib.rs` — implementation.
- `docs/adr/0001-resolution-commitment.md` — commit/reveal pattern.
- `docs/spec/system.md` — cross-contract message flows (Sequence 3, 5).
