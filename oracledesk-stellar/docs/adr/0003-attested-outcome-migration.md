# ADR 0003: `AttestedOutcome` and the attestation storage migration

## Status

Accepted.

## Context

Attested markets could only settle `Yes` or `No`: `Resolver::attest` took
market-core's `Outcome`. When signers agreed a question was ambiguous or
unanswerable (event cancelled, contradictory source, bad wording), they had
to vote for an outcome they believed was wrong or wait for the admin's
`guardian_void_market`. market-core already settles invalid markets
(`void_market`, every share redeems at 0.5), so only the resolver had to
change.

Adding `Invalid` to market-core's `Outcome` was rejected. It would change the
vendored `market_core.wasm` copies, the treasury's `agent_buy` ABI and the
meaning of market-core's `MarketResolved` event. Instead the resolver defines
its own `AttestedOutcome { Yes, No, Invalid }`.

The difficulty is storage. `Outcome` was part of persistent keys:

- `DataKey::Attestation(u64, Outcome, Address)`: per-signer dedupe flag
- `DataKey::Count(u64, Outcome)`: vote counter
- `DataKey::Proposal(u64)` → `SignerProposal { outcome: Outcome, .. }`

## Decision

### Versioned keys, never reused names

The resolver writes only new keys, appended to `DataKey`:

- `AttestationV2(u64, AttestedOutcome, Address)`
- `CountV2(u64, AttestedOutcome)`
- `ProposalV2(u64)` → `SignerProposalV2 { outcome: AttestedOutcome, proposed_at }`

Keys are XDR `Vec[Symbol(<variant>), ..fields]`, and both enums happen to
encode `Yes` as `Vec[Symbol("Yes")]`. Reusing `Attestation`/`Count` with the
new payload type would therefore decode old entries as new ones. That works
today, but only by accident, and it would stop being safe the first time
either enum's variants change. Explicit V2 keys make every migrated entry
visible.

Two value types (not keys) changed their `Outcome` field to `AttestedOutcome`:
the `AttestationEvidence.outcome` struct field and the `Attested` /
`FallbackSuperseded` event fields. Old `Yes`/`No` values decode unchanged,
and only `Invalid` is new to consumers.

### Option A (recommended): fresh deployment, sequenced resolver handover

The resolver has no upgrade entrypoint, so in practice the new code is a new
contract. market-core's resolver is **global**: every market resolves
through whichever resolver it currently names. This makes sequencing matter:

*(The `set_resolver` call in step 4 was replaced by `propose_resolver` +
`accept_resolver` in ADR 0006; the sequencing below is unchanged.)*

1. Deploy the new resolver (`__constructor(admin, market_core)`).
2. Stop revealing specs on the old resolver. New markets keep being created
   in market-core as before. Their specs are revealed on the new resolver
   only after step 4.
3. Drain the old resolver. Every market configured there must be finalized
   (`finalize_signers`, `resolve_price`), voided (`guardian_void_market`,
   `expire_market`, `expire_dispute`) or explicitly handed over (re-revealed
   on the new resolver once it is active; the commitment check makes that
   permissionless and safe). Claim any settled dispute bonds
   (`claim_dispute_bond`). Bonds escrowed by the old contract stay there.
4. Call market-core `propose_resolver(new_resolver)` (then the new resolver's
   `accept_resolver`). From then on the old
   resolver's `resolve`/`void_market` calls fail market-core's
   `require_resolver` auth check (it requires the *new* resolver's auth), so
   any market still in flight there is stuck until it is handed over. That is why step 3 comes first.
5. Point agents, the backend indexer and the frontend at the new address,
   and switch their decoders to the V2 events (see below).

A redeployed resolver starts with empty storage, so the legacy keys never
exist there.

### Option B (implemented regardless): legacy fallback reads

If the resolver ever gains an upgrade path (an in-place code upgrade keeps
storage), the old entries survive. The `legacy_reads` helpers in
`contracts/resolver/src/lib.rs` handle them, so the contract is safe under
either model:

- `attestation_count(id, o)` = `CountV2(id, o)` + legacy `Count(id, o)` (for
  `Yes`/`No` only, since `Invalid` has no legacy key).
- `has_attested(id, o, signer)` = `AttestationV2` exists **or** a legacy
  `Attestation` exists (for `Yes`/`No`), so old votes still deduplicate and
  still count toward committee-mode quorum.
- `load_proposal(id)` reads `ProposalV2`, and otherwise falls back to a
  legacy `Proposal` converted to `SignerProposalV2`.

Migration is lazy and runs on the write path:

- When an attestation for outcome `o` is recorded, the new count
  (`attestation_count + 1`, which already includes the legacy value) is
  written to `CountV2`, and the legacy `Count(id, o)` is deleted **in the
  same invocation**. A legacy count is therefore folded in exactly once and
  never double-counted.
- Legacy `Attestation` flags are only read and never copied. They are
  dedupe markers, and the count already reflects them.
- Writing or removing a proposal (`propose`, `cancel_proposal`, a hybrid
  `resolve_price` superseding the fallback) removes both `ProposalV2` and
  the legacy `Proposal`.

These paths are tested by writing legacy keys directly with
`env.as_contract`: `legacy_count_and_attestation_keys_are_read_and_migrated`,
`legacy_keys_not_double_counted_after_migration` and
`legacy_proposal_is_finalized_through_fallback`.

### Semantics

- `finalize_signers` returns `AttestedOutcome`. `Yes`/`No` call
  `resolve`, while `Invalid` calls `void_market` and emits `CommitteeVoided`
  (distinct from the guardian's `GuardianAction { action: Void }`).
- `void_market` has no `close_time` guard. Attestation rejects
  `now < close_time` before any write, so an `Invalid` proposal, and with it
  a committee void, cannot exist before close.
- Split votes: each outcome has its own counter, and dedupe is per
  `(outcome, signer)`, so one signer may back several outcomes (the
  existing behaviour, extended). The first outcome to reach threshold is
  proposed, and later `Yes`/`No` quorums never move it. A quorum saying the
  question cannot be answered outranks an answer, so `Invalid` reaching
  threshold replaces a pending `Yes`/`No` proposal and restarts the dispute
  window. An `Invalid` proposal is never replaced. A stricter rule, such as
  `Invalid` having to beat every other count, is a possible follow-up.
- Guardian `cancel_proposal` treats an `Invalid` proposal like any other. It
  removes only the proposal, so votes and counts remain, and the next
  attestation that brings an outcome to threshold proposes again.
- Disputes: `dispute(.., None)` claims "invalid", so it is rejected for an
  `Invalid` proposal. A `Verdict::Invalid` ruling *upholds* an `Invalid`
  proposal, and the bond goes to the market-core treasury.
- Weighted-key markets still sign market-core `Outcome`s. The signed
  message format (ADR 0001) is unchanged, so they never propose `Invalid`.
- `AttestedOutcome` is not part of any `ResolutionSpec`, so commitment
  hashes (ADR 0001, ADR 0004) are unaffected.

### Events: breaking for indexers

`ResolutionProposed` / `ResolutionFinalized` carry `outcome: Outcome`.
Changing their field type would silently change a schema that the backend
indexer decodes. The resolver now emits `ResolutionProposedV2` /
`ResolutionFinalizedV2` (with `outcome: AttestedOutcome`) and
`CommitteeVoided { market_id, finalized_at, invalid_count }`, and it no longer
emits the old two. The old structs stay in the contract spec so historical
events still decode. `OracleDesk-Backend`'s indexer and every consumer of
`packages/bindings/resolver` must switch decoders when they move to this
resolver. The `attest` / `attest_with_evidence` ABI also changed:
`outcome` is now an `AttestedOutcome`. The CLI form `--outcome Yes` still
parses.

## Consequences

- market-core and both vendored `market_core.wasm` copies are untouched.
- Signers can void an unanswerable market without the admin key.
- One more persistent entry family per outcome, and bindings consumers
  must handle a third outcome tag on the resolver.

## Addendum: epoch binding (#297)

Committee markets now pin the epoch in force at `close_time` and use that
epoch's `MemberAt` snapshot for all attestations and quorum checks. This
prevents rotations executed between attestation and finalization from
changing the outcome. `AttestEpoch(market, signer)` continues to be written
with the pinned epoch.

New keys: `EpochStart(committee_id, epoch)` holding the timestamp at which
each epoch started, and `MarketEpoch(market_id)` holding the pinned
`(committee_id, epoch)`. `epoch_at` walks back at most `max_rotation_delta + 1`
entries (capped at 17). Legacy committees without `EpochStart` for epoch 1
are treated as having started at creation (timestamp 0).

The pin is written lazily on the first attestation after close, or
permissionlessly through `pin_committee_epoch(market_id)`. `CommitteeSpec`,
`MemberAt`, `EpochStart`, and `MarketEpoch` are bumped to the market's
close-time-aware target in `bump_market_entries` and at pin time, so a
snapshot shared by many markets survives until each finalizes.

`validate_committee_ref` is shared between `register_committee_spec` and
the V2/V3 reveal path (`validate_rule`), so both check committee existence,
`min_epoch`, `dispute_window != 0`, and `max_rotation_delta <= 16`.
