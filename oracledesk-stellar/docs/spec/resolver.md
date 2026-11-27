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

**RS-REGISTER_SIGNER_SPEC-AUTH-1** None (permissionless; anyone can reveal if they know the hash preimage).

**RS-REGISTER_SIGNER_SPEC-PRE-1** `P[Market(market_id)]` exists in market-core (checked via market-core call).
**RS-REGISTER_SIGNER_SPEC-PRE-2** No prior spec registered for this market (check: neither `SignerSpec` nor `PriceSpec` exists).
**RS-REGISTER_SIGNER_SPEC-PRE-3** `sha256(XDR(ResolutionSpec::Signers(config))) == P[Market(market_id)].resolution_hash` else `SpecHashMismatch(1)`.
**RS-REGISTER_SIGNER_SPEC-PRE-4** `config.threshold > 0 && config.threshold <= config.signers.len()` else `InvalidThreshold(2)`.
**RS-REGISTER_SIGNER_SPEC-PRE-5** `config.dispute_window <= MAX_DISPUTE_WINDOW` else `DisputeWindowTooLarge(3)`.

**RS-REGISTER_SIGNER_SPEC-POST-1** `P[SignerSpec(market_id)]` = `config`.
**RS-REGISTER_SIGNER_SPEC-POST-2** `P[SignerProposal(market_id)]` = `{count: 0, threshold: config.threshold, dispute_window: config.dispute_window, ...}`.
**RS-REGISTER_SIGNER_SPEC-POST-3** `P[ProposalCreatedAt(market_id)]` = `now`.
**RS-REGISTER_SIGNER_SPEC-POST-4** Spec entry TTL-bumped.

**RS-REGISTER_SIGNER_SPEC-EVT-1** `SignerSpecRegistered { market_id, signers_count: config.signers.len(), threshold: config.threshold }`.

**RS-REGISTER_SIGNER_SPEC-ERR-1** `SpecHashMismatch(1)` if hash does not match.
**RS-REGISTER_SIGNER_SPEC-ERR-2** `InvalidThreshold(2)` if threshold is invalid.
**RS-REGISTER_SIGNER_SPEC-ERR-3** `DisputeWindowTooLarge(3)` if dispute window exceeds max.
**RS-REGISTER_SIGNER_SPEC-ERR-4** `SpecAlreadyRegistered(4)` if a spec already exists for this market.

---

### `register_price_spec`

Reveals the price specification for a market.

**RS-REGISTER_PRICE_SPEC-AUTH-1** None (permissionless).

**RS-REGISTER_PRICE_SPEC-PRE-1** `P[Market(market_id)]` exists in market-core.
**RS-REGISTER_PRICE_SPEC-PRE-2** No prior spec registered for this market.
**RS-REGISTER_PRICE_SPEC-PRE-3** `sha256(XDR(ResolutionSpec::Price(config))) == P[Market(market_id)].resolution_hash` else `SpecHashMismatch(1)`.

**RS-REGISTER_PRICE_SPEC-POST-1** `P[PriceSpec(market_id)]` = `config`.
**RS-REGISTER_PRICE_SPEC-POST-2** Spec entry TTL-bumped.

**RS-REGISTER_PRICE_SPEC-EVT-1** `PriceSpecRegistered { market_id, feed, threshold }`.

**RS-REGISTER_PRICE_SPEC-ERR-1** `SpecHashMismatch(1)` if hash does not match.
**RS-REGISTER_PRICE_SPEC-ERR-2** `SpecAlreadyRegistered(4)` if a spec already exists.

---

### `attest`

Signer attests to a signer proposal.

**RS-ATTEST-AUTH-1** `auth(signer)`.

**RS-ATTEST-PRE-1** `P[SignerSpec(market_id)]` exists else `SpecNotRegistered(5)`.
**RS-ATTEST-PRE-2** `signer` is in the spec's signer set else `SignerNotInSet(6)`.
**RS-ATTEST-PRE-3** `P[Attestations(market_id, signer)] != true` else `AlreadyAttested(7)` (each signer attests once).
**RS-ATTEST-PRE-4** `now >= P[ProposalCreatedAt(market_id)] + MIN_ATTEST_DELAY` (soft; check documented in code if enforced).

**RS-ATTEST-POST-1** `P[Attestations(market_id, signer)]` = `true`.
**RS-ATTEST-POST-2** `P[SignerProposal(market_id)].count` incremented.
**RS-ATTEST-POST-3** Proposal entry TTL-bumped.

**RS-ATTEST-EVT-1** `SignerAttested { market_id, signer, proposal_count: new count }`.

**RS-ATTEST-ERR-1** `SpecNotRegistered(5)` if no signer spec exists.
**RS-ATTEST-ERR-2** `SignerNotInSet(6)` if signer is not in the spec.
**RS-ATTEST-ERR-3** `AlreadyAttested(7)` if this signer already attested.

---

### `cancel_proposal`

Cancels a signer proposal (can only be called by admin or the creator; design choice documented).

**RS-CANCEL_PROPOSAL-AUTH-1** `auth(admin)` or design choice TBD (currently admin-only or creator-only; specify).

**RS-CANCEL_PROPOSAL-PRE-1** `P[SignerProposal(market_id)]` exists else `NoProposalToCancel(8)`.
**RS-CANCEL_PROPOSAL-PRE-2** Market status != `Finalized` (checked via market-core call).

**RS-CANCEL_PROPOSAL-POST-1** `P[SignerProposal(market_id)]` deleted (or marked cancelled).
**RS-CANCEL_PROPOSAL-POST-2** `P[Attestations(market_id, *)]` entries cleared.
**RS-CANCEL_PROPOSAL-POST-3** `P[SignerSpec(market_id)]` deleted.

**RS-CANCEL_PROPOSAL-EVT-1** `ProposalCancelled { market_id }`.

**RS-CANCEL_PROPOSAL-ERR-1** `NoProposalToCancel(8)` if no proposal exists.
**RS-CANCEL_PROPOSAL-ERR-2** `Unauthorized(9)` if caller lacks authority.

---

### `resolve_price`

Permissionless: resolves a market via price oracle (no bounty payout; kept for backward compatibility).

**RS-RESOLVE_PRICE-AUTH-1** None (permissionless).

**RS-RESOLVE_PRICE-PRE-1** `P[PriceSpec(market_id)]` exists else `SpecNotRegistered(5)`.
**RS-RESOLVE_PRICE-PRE-2** `P[Market(market_id)]` status != `Finalized` else `AlreadyFinalized(10)`.
**RS-RESOLVE_PRICE-PRE-3** `now >= P[Market(market_id)].close_time` else `MarketNotClosed(11)`.
**RS-RESOLVE_PRICE-PRE-4** Price oracle returns a valid price (no stale/invalid check; assumed valid).

**RS-RESOLVE_PRICE-POST-1** Calls `market_core.resolve(market_id, outcome)` where outcome is determined by price vs. threshold.
**RS-RESOLVE_PRICE-POST-2** `P[PriceSpec(market_id)]` deleted.

**RS-RESOLVE_PRICE-EVT-1** `PriceResolved { market_id, outcome }`.

**RS-RESOLVE_PRICE-ERR-1** `SpecNotRegistered(5)` if no price spec.
**RS-RESOLVE_PRICE-ERR-2** `AlreadyFinalized(10)` if already resolved.
**RS-RESOLVE_PRICE-ERR-3** `MarketNotClosed(11)` if `now < close_time`.

---

### `resolve_price_for` (New, Issue #149)

Resolves via price and pays bounty to the caller.

**RS-RESOLVE_PRICE_FOR-AUTH-1** `auth(caller)`.

**RS-RESOLVE_PRICE_FOR-PRE-1** Same as `resolve_price` (PRE-1 through PRE-4).

**RS-RESOLVE_PRICE_FOR-POST-1** Calls `market_core.resolve(market_id, outcome)`.
**RS-RESOLVE_PRICE_FOR-POST-2** Calls `pay_bounty(market_id, caller)` (see below).

**RS-RESOLVE_PRICE_FOR-EVT-1** The events of `resolve_price` (`PriceResolution`), then `BountyPaid { market_id, caller, amount }` when a bounty is paid. No event when there is no bounty.

**RS-RESOLVE_PRICE_FOR-ERR-1** Same as `resolve_price`, plus auth failure if `auth(caller)` fails. A failing resolution also reverts any payout, because both happen in one invocation.

---

### `finalize_signers`

Permissionless: finalizes a signer proposal once threshold is reached (no bounty payout).

**RS-FINALIZE_SIGNERS-AUTH-1** None (permissionless).

**RS-FINALIZE_SIGNERS-PRE-1** `P[SignerProposal(market_id)]` exists else `NoProposalToFinalize(12)`.
**RS-FINALIZE_SIGNERS-PRE-2** `now >= P[ProposalCreatedAt(market_id)] + P[SignerProposal(market_id)].dispute_window` else `DisputeWindowOpen(13)`.
**RS-FINALIZE_SIGNERS-PRE-3** `P[SignerProposal(market_id)].count >= P[SignerProposal(market_id)].threshold` else `ThresholdNotReached(14)`.
**RS-FINALIZE_SIGNERS-PRE-4** `P[Market(market_id)]` status != `Finalized` else `AlreadyFinalized(10)`.

**RS-FINALIZE_SIGNERS-POST-1** Calls `market_core.resolve(market_id, Yes)` (signer proposals always resolve to Yes; design choice documented).
**RS-FINALIZE_SIGNERS-POST-2** `P[SignerProposal(market_id)]` deleted.
**RS-FINALIZE_SIGNERS-POST-3** `P[SignerSpec(market_id)]` deleted.
**RS-FINALIZE_SIGNERS-POST-4** `P[Attestations(market_id, *)]` cleared.

**RS-FINALIZE_SIGNERS-EVT-1** `SignersFinalized { market_id, threshold_reached: count }`.

**RS-FINALIZE_SIGNERS-ERR-1** `NoProposalToFinalize(12)` if no proposal exists.
**RS-FINALIZE_SIGNERS-ERR-2** `DisputeWindowOpen(13)` if dispute window still open.
**RS-FINALIZE_SIGNERS-ERR-3** `ThresholdNotReached(14)` if attestation count < threshold.
**RS-FINALIZE_SIGNERS-ERR-4** `AlreadyFinalized(10)` if already resolved.

---

### `finalize_signers_for` (New, Issue #149)

Finalizes signers and pays bounty to the caller.

**RS-FINALIZE_SIGNERS_FOR-AUTH-1** `auth(caller)`.

**RS-FINALIZE_SIGNERS_FOR-PRE-1** Same as `finalize_signers`.

**RS-FINALIZE_SIGNERS_FOR-POST-1** Calls `market_core.resolve(market_id, Yes)`.
**RS-FINALIZE_SIGNERS_FOR-POST-2** Calls `pay_bounty(market_id, caller)`.

**RS-FINALIZE_SIGNERS_FOR-EVT-1** The events of `finalize_signers`, then `BountyPaid { market_id, caller, amount }` when a bounty is paid.

**RS-FINALIZE_SIGNERS_FOR-ERR-1** Same as `finalize_signers`, plus auth failure.

---

### `guardian_void_market`

Admin: voids a market and refunds any unpaid bounty to the funder.

**RS-GUARDIAN_VOID_MARKET-AUTH-1** `auth(admin)`.

**RS-GUARDIAN_VOID_MARKET-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(15)`.
**RS-GUARDIAN_VOID_MARKET-PRE-2** `P[Market(market_id)].status != Finalized` else `AlreadyFinalized(10)`.

**RS-GUARDIAN_VOID_MARKET-POST-1** Calls `market_core.void_market(market_id)`.
**RS-GUARDIAN_VOID_MARKET-POST-2** Calls `refund_bounty(market_id)` (see below).

**RS-GUARDIAN_VOID_MARKET-EVT-1** `GuardianVoided { market_id }`.

**RS-GUARDIAN_VOID_MARKET-ERR-1** `MarketNotFound(15)` if market does not exist.
**RS-GUARDIAN_VOID_MARKET-ERR-2** `AlreadyFinalized(10)` if already finalized.
**RS-GUARDIAN_VOID_MARKET-ERR-3** `Unauthorized(9)` if caller is not admin.

---

## Bounty Entrypoints (New, Issue #149)

### `fund_bounty`

Funds a per-market resolution bounty.

**RS-FUND_BOUNTY-AUTH-1** `auth(funder)`.

**RS-FUND_BOUNTY-PRE-1** `P[Market(market_id)]` exists, else the market-core error `MarketCoreMarketNotFound(1044)`.
**RS-FUND_BOUNTY-PRE-2** `now < P[Market(market_id)].close_time` else `BountyFundingClosed(46)`.
**RS-FUND_BOUNTY-PRE-3** `amount > 0` else `InvalidBounty(45)`.
**RS-FUND_BOUNTY-PRE-4** No bounty exists, or existing bounty has the same funder (single funder constraint; design choice). Otherwise `BountyFunderMismatch(47)`.
**RS-FUND_BOUNTY-PRE-5** Market not yet final (`resolution_state` is not terminal) else `AlreadyFinalized(17)`. Bounty token configured else `BountyTokenNotSet(44)`.

**RS-FUND_BOUNTY-POST-1** `P[Bounty(market_id)]` updated or created with new amount and funder.
**RS-FUND_BOUNTY-POST-2** `token.transfer(funder, resolver, amount)` executed.
**RS-FUND_BOUNTY-POST-3** Bounty entry TTL-bumped.

**RS-FUND_BOUNTY-EVT-1** `BountyFunded { market_id, funder, amount, total }`.

**RS-FUND_BOUNTY-ERR-1** `MarketCoreMarketNotFound(1044)` if market does not exist.
**RS-FUND_BOUNTY-ERR-2** `BountyFundingClosed(46)` if `now >= close_time`.
**RS-FUND_BOUNTY-ERR-3** `InvalidBounty(45)` if `amount <= 0`.
**RS-FUND_BOUNTY-ERR-4** `BountyFunderMismatch(47)` if the bounty already has a different funder.

---

### `pay_bounty` (Internal; called by resolve_price_for and finalize_signers_for)

Pays the bounty to the caller if one exists and hasn't been paid.

**RS-PAY_BOUNTY-AUTH-1** None (internal call; caller must already be auth'd by the resolution entrypoint).

**RS-PAY_BOUNTY-PRE-1** `P[Bounty(market_id)]` exists and `amount > 0`.
**RS-PAY_BOUNTY-PRE-2** `P[Bounty(market_id)].paid == false`.

**RS-PAY_BOUNTY-POST-1** `P[Bounty(market_id)].paid` = `true`.
**RS-PAY_BOUNTY-POST-2** `token.transfer(resolver, caller, amount)` executed (bounty paid out; effects before interactions).

**RS-PAY_BOUNTY-EVT-1** `BountyPaid { market_id, caller, amount }`.

**RS-PAY_BOUNTY-ERR-1** None (called only internally; errors are impossible given PRE conditions).

---

### `refund_bounty` (Internal; called by guardian_void_market)

Refunds unpaid bounty to the funder.

**RS-REFUND_BOUNTY-AUTH-1** None (internal).

**RS-REFUND_BOUNTY-PRE-1** `P[Bounty(market_id)]` exists.
**RS-REFUND_BOUNTY-PRE-2** `P[Bounty(market_id)].paid == false`.

**RS-REFUND_BOUNTY-POST-1** `P[Bounty(market_id)].paid` = `true`.
**RS-REFUND_BOUNTY-POST-2** `token.transfer(resolver, funder, amount)` executed.

**RS-REFUND_BOUNTY-EVT-1** `BountyRefunded { market_id, funder, amount }`.

---

### `set_bounty_token`

Admin: sets the token address for bounty escrows.

**RS-SET_BOUNTY_TOKEN-AUTH-1** `auth(admin)`.

**RS-SET_BOUNTY_TOKEN-PRE-1** `token` is a valid SEP-41 token address.
**RS-SET_BOUNTY_TOKEN-PRE-2** `token == P[Market(any)].collateral` (enforced; bounty token must match collateral).

**RS-SET_BOUNTY_TOKEN-POST-1** `I[BountyToken]` = `token`.

**RS-SET_BOUNTY_TOKEN-ERR-1** Admin auth failure if the caller is not the admin.
**RS-SET_BOUNTY_TOKEN-ERR-2** `InvalidConfig(3)` if the token does not match market-core's collateral.

---

### `reclaim_bounty`

Returns an unpaid escrow to its funder once the market is final. This covers markets finalized through `resolve_price` or `finalize_signers` rather than their `_for` variants, which would otherwise leave the escrow stranded.

**RS-RECLAIM_BOUNTY-AUTH-1** `auth(funder)`.

**RS-RECLAIM_BOUNTY-PRE-1** `P[Market(market_id)]` status is terminal (`Finalized`) else `BountyNotFinal(49)`.
**RS-RECLAIM_BOUNTY-PRE-2** `P[Bounty(market_id)]` exists else `NoBounty(48)`.
**RS-RECLAIM_BOUNTY-PRE-3** `P[Bounty(market_id)].funder == funder` else `BountyFunderMismatch(47)`.

**RS-RECLAIM_BOUNTY-POST-1** If `paid == false`: `P[Bounty(market_id)].paid` = `true` and `token.transfer(resolver, funder, amount)` executed. Returns `amount`.
**RS-RECLAIM_BOUNTY-POST-2** If `paid == true`: no transfer, returns `0`.

**RS-RECLAIM_BOUNTY-EVT-1** `BountyRefunded { market_id, funder, amount }` when `amount > 0`.

**RS-RECLAIM_BOUNTY-ERR-1** `BountyNotFinal(49)` if the market is not final.
**RS-RECLAIM_BOUNTY-ERR-2** `NoBounty(48)` if no escrow exists.
**RS-RECLAIM_BOUNTY-ERR-3** `BountyFunderMismatch(47)` if the caller is not the funder.

---

## View Functions

### `state`

Returns the current proposal state for a market (read-only snapshot).

**RS-STATE-PRE-1** No preconditions.

**RS-STATE-POST-1** Returns `{spec_type, count, threshold, dispute_window, created_at}` or `None` if no proposal.

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
| 44 | `BountyTokenNotSet` | Bounty token not configured (`set_bounty_token`). |
| 45 | `InvalidBounty` | Bounty amount is zero or negative, or the escrow would overflow. |
| 46 | `BountyFundingClosed` | Bounty can't be funded at or after close_time. |
| 47 | `BountyFunderMismatch` | A different address already funds this market's bounty. |
| 48 | `NoBounty` | No bounty was funded for this market. |
| 49 | `BountyNotFinal` | Bounty reclaim attempted before the market is final. |

> Codes 15-18 were used for bounty errors in an earlier draft of this table; they collided with `DisputeWindowOpen`, `NoProposal`, `AlreadyFinalized` and `SpecHashMismatch`, so the bounty codes are 44-49 (see `contracts/resolver/src/lib.rs`). Rows 1-14 do not match the implemented enum either; that discrepancy is tracked under #142.

---

## Invariants

- `SYS-INV-6`: Resolver finalizes once (AlreadyFinalized guard on resolve/void).
- Bounty is paid exactly once (paid flag prevents re-payment).
- Bounty only paid on successful finalization (not on revert or partial failure).

## See Also

- `contracts/resolver/src/lib.rs` — implementation.
- `docs/adr/0001-resolution-commitment.md` — commit/reveal pattern.
- `docs/spec/system.md` — cross-contract message flows (Sequence 3, 5).
