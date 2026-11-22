# ADR 0001: Resolution commitment on `create_market`

## Status

Accepted.

## Context

The original `market-core` design let a market's creator wire up a resolution
rule (a Reflector price threshold, or an m-of-n signer set) *after* the market
was already open and trading. That is a real economic exploit: a creator can
watch how the market trades, see which outcome the crowd is pricing in, and
only then pick (or quietly negotiate) a resolution rule tailored to a
different, more profitable outcome. Nothing on chain stopped this — the
resolver's `configure_price` / `configure_signers` were plain admin-gated
setters with no link back to the market itself.

## Decision

`Market` (and `create_market`) now carries a `resolution_hash: BytesN<32>` —
a commitment fixed at creation time, before any trading happens. It is the
sha256 of an XDR-encoded `resolver::ResolutionSpec` (an enum wrapping either a
`PriceConfig` or a `SignerConfig`; see `contracts/resolver/src/lib.rs`).

The resolver's `register_price_spec` / `register_signer_spec` accept the
*revealed* spec at any time after creation, recompute its hash, and only
accept it if that hash equals the market's `resolution_hash` and no spec has
been registered yet (`Error::SpecHashMismatch`, `Error::MarketAlreadyConfigured`).
Because the check is purely cryptographic, these functions have **no admin
gate** — anyone may reveal the spec, since only the party who already knows a
hash-matching preimage (the creator, at the time they committed to it) can
produce one that passes.

The two resolution rules are wrapped in one `ResolutionSpec` enum before
hashing (not hashed as bare `PriceConfig`/`SignerConfig` values) so the two
modes sit in disjoint hash spaces even if their field encodings could
otherwise collide.

## Consequences

- A market's resolution rule is fixed before the first trade. Front-running
  the resolution mechanism is no longer possible.
- Creating a market now requires computing this hash off-chain first (the
  agent's trace-building code does this — see `agents/core`), then revealing
  the spec once trading is ready to close. Markets with a never-revealed spec
  are simply unresolvable through the normal path; `Resolver::guardian_void_market`
  (admin-gated) exists as the escape hatch for that case.
- `Outcome`/`PriceConfig`/`SignerConfig` used inside `ResolutionSpec` must stay
  stable in field *names* and types: XDR encoding is structural (structs encode
  as a map sorted by field name), so renaming a field changes the hash of every
  already-committed market's spec type. Golden vectors now pin this.

## Update

The commitment format is extended by [ADR 0004](0004-spec-versioning.md): a
salted, versioned, domain-separated `ResolutionSpecV2` envelope accepted
alongside the legacy format described above.

## Price threshold units

A SEP-40 feed (Reflector included) reports `price` as a decimal-scaled integer:
the value is `actual x 10^decimals`, where `decimals()` is published by the
feed itself (14 for Reflector's canonical feeds). That makes the units of a
committed threshold load-bearing, and the original `PriceConfig` never declared
them.

* **Legacy `Price`.** `PriceConfig.threshold` is compared *raw* against the
  feed's reported integer — feed-native units, no scaling, no decimals call.
  This meaning is frozen: field names, types and the enum's variant order are
  exactly what every already-committed `resolution_hash` was built over, and
  the golden vectors in `contracts/resolver/src/lib.rs` (`mod golden`) and
  `scripts/spec-hash` pin it. Do not "fix" the legacy variant by adding
  scaling to it — that silently breaks every existing commitment.
* **Decimal-explicit scaled price.** Issue #26 adds
  `ScaledPriceConfig` (defined in `contracts/resolver`, alongside
  `register_scaled_price_spec`), which carries `threshold_decimals`
  alongside the threshold. At resolution both sides are rescaled with
  checked base-10 arithmetic to
  `max(feed_decimals, threshold_decimals)` before comparison; an `i128`
  overflow traps the read as `InvalidPrice`, and `threshold_decimals` above
  `MAX_THRESHOLD_DECIMALS` (38, the largest power of ten an `i128` holds) is
  rejected with `InvalidConfig` at reveal, before any commitment is stored.
* **Hash compatibility.** PR #176 moved `ResolutionSpec` (and every config
  type it wraps) into `contracts/oracledesk-types`, the shared types crate
  that router, treasury and `scripts/spec-hash` all flow through, so a
  seventh variant cannot be appended from inside the resolver without
  editing that crate. The scaled commitment therefore lives in its own
  domain-tagged preimage:
  `sha256("oracledesk:scaled-price-spec" || XDR(ScaledPriceConfig))`
  (`resolver::scaled_spec_hash`), the same construction ADR 0004 uses for
  the V2 envelope. The three spaces are provably disjoint: every legacy
  preimage is an `ScVal` XDR starting `00 00 00 10`; the V2 tag starts
  `oracledesk:resolution-spec` and the scaled tag `oracledesk:scaled-`, so
  they differ at a fixed offset. Consequently every previously committed
  hash — legacy `Price`, `Signers`, and every later-appended variant — is
  byte-identical; nothing was reordered or renumbered. The scaled config is
  a distinct struct, not a field added to `PriceConfig`, for the same
  reason, and because bare `PriceConfig` XDR is already stored under
  `DataKey::Price` and must never be reinterpreted. A market is either
  legacy-price or scaled-price, never both (`assert_unconfigured` checks
  `DataKey::Price`, `DataKey::Signers` and the appended
  `DataKey::PriceScaled`).
* **Maintainer follow-up (canonical home).** The append-only shape this ADR
  originally planned — a `PriceScaled(ScaledPriceConfig)` variant added
  *last* in `oracledesk-types::ResolutionSpec` and in `DataKey` — remains
  the canonical end state once `oracledesk-types` compiles again (it
  currently fails on every toolchain because its line 27 never imports
  `contracttype`). Adding it there is additive for hashing: the six
  existing variants keep their preimages, so the domain-tagged form above
  can be migrated variant-by-variant without breaking committed markets.

## TWAP resolution variant

Issue #27 adds a time-weighted-average price rule, `TwapConfig` (defined in
`contracts/resolver`, alongside `register_twap_spec` / `resolve_twap`): the
market settles on the average of the feed's records over a window ending at
`close_time`, so a single manipulated or anomalous close print can no longer
decide it. It is described here because it changes what `resolution_hash`
can commit to.

* **Hash space.** Same construction as the scaled mode above: the TWAP
  commitment is
  `sha256("oracledesk:price-twap-spec" || XDR(TwapConfig))`
  (`resolver::twap_spec_hash`). The issue's sketch appended a
  `PriceTwap(TwapConfig)` variant to `ResolutionSpec` (discriminant 2 in
  the then-two-variant enum); under PR #176's shared-types layout that
  enum is frozen in `contracts/oracledesk-types`, exactly the constraint
  documented in "Price threshold units", so the variant form is a listed
  maintainer follow-up and the domain-tagged form ships now. Disjointness
  extends to four provably separate spaces: legacy `ScVal` preimages start
  `00 00 00 10`; the V2 tag starts `oracledesk:resolution-`; the scaled
  tag is `oracledesk:scaled-price-spec`; the TWAP tag is
  `oracledesk:price-twap-spec` — all differ at fixed offsets, so no
  preimage of one mode is ever a preimage of another and every previously
  committed hash stays byte-identical (pinned by the golden vectors in
  `contracts/resolver` and `scripts/spec-hash`, unchanged by this ADR).
  A market is exactly one of the price shapes
  (`DataKey::Price` / `PriceScaled` / the appended `PriceTwap`), enforced
  by `assert_unconfigured` checking all keys.
* **Sampling.** `resolve_twap` (and `resolve_price`, which dispatches)
  reads `price(asset, ts)` at every `resolution()`-aligned timestamp in
  `(close_time - window, close_time]`, newest grid slot first, using the
  same grid alignment as the #26 single-read lookup. Missing records are
  skipped; a trapping feed is `PriceUnavailable`; `resolution() == 0` is
  rejected at both registration (`InvalidConfig`) and resolution
  (`InvalidPrice`). Duplicated timestamps — a feed answering with the
  nearest earlier record — are counted once. Registration additionally
  calls `resolution()` on the committed reflector and rejects (
  `InvalidConfig`) a `window / resolution` above the sample cap or a
  `min_samples` above the slot count, so an unresolvable market is caught
  at reveal, not at close.
* **Rejection rules.** Fewer than `min_samples` present samples, a gap
  above `max_gap` between `start` and the first sample, between any two
  consecutive samples, or between the last sample and `close_time`, all
  fail `StalePrice`; a sample price `<= 0` or any arithmetic overflow
  fails `InvalidPrice`. Failed resolution leaves the market untouched, and
  `expire_market` treats those errors as "feed unusable" exactly as for
  the other price shapes.
* **Weighting formula.** Each sample is weighted by the time until the
  next sample; the newest sample is weighted `close_time - last_ts + 1`
  (the closing second is included — the convention the issue offered as
  "`close_time - ts_last + 1` or `resolution()`", this ADR picks the
  former and both the numerator and denominator apply it consistently).
  `twap = floor( Σ price_i * dt_i / Σ dt_i )` in `i128` with
  `checked_mul`/`checked_add`/`checked_div`; the committed
  `AtOrAbove`/`AtOrBelow` comparison applies to the floored average.
  Threshold units are feed-native, like the legacy `Price` variant (the
  decimal-explicit question is #26's and stays with `ScaledPriceConfig`).
* **Sample cap and budget.** `MAX_TWAP_SAMPLES = 32` bounds the
  cross-contract `price` reads per resolution attempt — as a cap on
  *reads inspected*, not samples found, so a window full of missing
  records terminates instead of walking the grid forever. The issue asks
  for a value "chosen from measured CPU cost" (`env.cost_estimate()`
  against the registered wasm, recorded here). **That measurement is not
  available and this number is reasoned, not measured**: the in-tree
  build gate (the wasm-hash verification build script and
  `oracledesk-types`) fails at the current tip, so no test executes; no
  benchmark figure is claimed. 32 is instead derived from the contract's
  own accepted ceilings — `MAX_WEIGHTED_SIGNERS = 32` /
  `MAX_COMMITTEE = 32`, and the weighted-keys path verifies up to 32
  ed25519 signatures in one call at a documented 23.1M instructions (see
  "Weighted-key attestations"), a per-item cost strictly above one bounded
  price read — so a 32-sample TWAP cannot exceed a flow the protocol
  already ships against. A measured re-derivation is a maintainer
  follow-up alongside the golden re-pin.
* **Manipulation scope.** A TWAP dilutes a single print, but a sustained
  push still moves the average; median filtering is out of scope.

## Amendment: Market-linked resolution (Issue #147)

Issue #147 adds a third `ResolutionSpec` variant, `Market(MarketLinkConfig)`, allowing a market to resolve based on another market's final outcome. This enables conditional markets ("If A resolves YES, will B happen?"), negations, and chained markets without requiring a trusted signer.

### Append-only variant rule

The new variant is **appended as the last enum variant** in `ResolutionSpec`, ensuring existing `Price` and `Signers` commitments remain byte-identical:

```rust
pub enum ResolutionSpec {
    Price(PriceConfig),                    // existing, variant 0
    Signers(SignerConfig),                 // existing, variant 1
    WeightedKeys(WeightedKeyConfig),       // existing, variant 2
    SignersDisputable(...),                // existing, variant 3
    Committee(CommitteeRef),               // existing, variant 4
    Hybrid(HybridConfig),                  // existing, variant 5
    Market(MarketLinkConfig),              // NEW, variant 6, appended at end
}
```

**Why**: Soroban XDR encodes enums as `Vec[Symbol(variant_name), value]`. Adding a variant at the end does not change the discriminant or encoding of earlier variants. Golden vectors in `contracts/resolver/src/lib.rs` and `scripts/spec-hash` verify that all existing variant hashes (Price, Signers, etc.) remain byte-identical before and after this change.

### Cycle prevention via ordering rule

Markets can link to other markets, but dependency cycles are impossible by construction:

- **Ordering rule**: Require `source_market_id < market_id`. Market IDs come from market-core's monotonically incrementing `NextId`. A source market must have existed (and thus have a smaller ID) when the dependent market was created. Following "points to an earlier ID" edges can never return to the start.
- **Depth limit**: Store `Depth(market_id) = 1 + depth(source)` if source has a Link, else 1. Reject if `> MAX_LINK_DEPTH` (e.g., 4). Prevents long chains and bounds cross-contract reads at resolution time.
- **Close-time ordering**: Require `source.close_time <= dependent.close_time`. A conditional market cannot settle before its condition.

**Acyclicity guarantee**: The ordering rule alone makes cycles *impossible* (not just discouraged); the depth limit is defense-in-depth and reduces resource coupling.

### Configuration and resolution

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketLinkConfig {
    pub source_market_id: u64,
    pub on_yes: LinkedResult,     // Yes | No | Void
    pub on_no: LinkedResult,      // Yes | No | Void
    pub on_void: LinkedResult,    // Yes | No | Void
    pub max_wait: u64,            // seconds after this market's close_time
}
```

- `register_market_spec` validates commitment match, ordering and depth, and stores the config.
- `resolve_linked` (permissionless, like `resolve_price`) applies the committed mapping to the source's final `MarketStatus`:
  - `Resolved(Yes)` → `on_yes`; `Resolved(No)` → `on_no`; `Void` → `on_void`; `Open` (after max_wait) → void dependent
  - Calls market-core's `resolve` or `void_market` and sets `State = Finalized`
- `LinkedResolution` event emitted on success, tracking source outcome and result.

### Safe fallback for missing sources

If the source market's storage is archived or does not exist:

- If `now > close_time + max_wait`: void the dependent market (liveness guaranteed).
- Else: return `SourceNotFinal`, allowing retry once the source settles.
- `max_wait` is part of the commitment, so traders know the worst-case settlement delay.

### Documentation and testing

- Updated `docs/market-metadata.md` with schema v1 to include `mode: "market"` and `MarketLinkConfig` spec serialization.
- Updated `docs/events.md` with `LinkedResolution` event and cross-contract event sequence examples.
- Golden vectors in `docs/market-metadata-vectors.json` include a market-linked example to verify schema stability.
- Tests: `register_market_spec_valid`, `register_market_spec_rejects_circular_via_ordering`, `resolve_linked_yes/no/void`, `source_open_after_max_wait_voids_dependent`.

## Liveness fallback

A market whose spec is never revealed, whose committed feed is permanently
unusable, or whose signers go silent would otherwise lock its collateral until
the single guardian key acts. `Resolver::expire_market` removes that dependency.

* **Deadline.** `close_time + RESOLUTION_GRACE_SECS` (30 days, a compile-time
  constant so no admin can shorten it). It reads only market-core's
  `close_time`, so it applies to unrevealed specs and to every market created
  before this change, with no spec migration. `resolution_deadline(market_id)`
  exposes it.
* **Permissionless, liveness-first.** After the deadline anyone may call
  `expire_market`. If the market can still resolve validly it does not void:
  a price market whose feed is usable *right now* is resolved (not voided), and a
  market with a pending signer proposal is refused with `ResolutionAvailable`
  until `finalize_signers` settles it (a proposal always stays finalizable by
  anyone). Only a market with nothing resolvable is voided, through
  market-core's existing `void_market`; `MarketExpired` records the mode
  (`Unrevealed`, `Price` or `Signers`) so indexers can tell it from a guardian void.
* **Terminal state.** `ResolutionState::Expired` is terminal like `Finalized`:
  reveals, attestations, `resolve_price` and `guardian_void_market` are refused
  afterwards, and the state's TTL is extended whenever it is written.
* **Griefing.** A void pays every holder half per share, so it is never a
  free win for one side. Stalling `expire_market` cannot get a correctly
  resolvable price market voided, because that call resolves it instead.
  Stalling the feed is only possible for a creator who committed to an oracle
  they control, a risk that already exists (the commitment does not bind
  oracle identity) and is a known limitation to be addressed by the guardian
  constraints and multi-oracle follow-up work. A guardian who cancels a
  proposal shortly before the deadline can let expiry void a market whose
  signers are still re-attesting; that is accepted by design.
* **Unusable feed.** A Reflector call that traps is treated as
  `PriceUnavailable`, and the expiry and guardian paths accept
  `PriceUnavailable`, `StalePrice` (no acceptable record on the feed's
  resolution grid within `max_staleness`, and no earlier one within the
  bounded lookback) and `InvalidPrice` (a non-positive published price, or a
  feed reporting `resolution() == 0`) as "feed unusable", so a broken or dead
  oracle address cannot make expiry revert forever. Any other error (for
  example `NotInitialized`) is still surfaced.

## Weighted-key attestations

`ResolutionSpec::WeightedKeys` commits to a committee of raw Ed25519 public
keys with weights. Members sign off-chain; anyone submits the signatures in
one `resolver.submit_signatures` call, which verifies each with
`env.crypto().ed25519_verify` and sums the weight per `(market, round, outcome)`.
The host verifies with ed25519-dalek's `verify_strict`, which rejects a
non-canonical `S`, weak (small-order) public keys and a small-order `R`, and
traps on failure.

The signed message is raw (never hashed first) and fixed by
`Resolver::attestation_message`:

```
msg = "oracledesk-attest-v1"        20 ASCII bytes (domain tag)
   || network_id                    32 bytes, env.ledger().network_id()
   || resolver address              ScVal XDR of the resolver address (40 bytes for C...)
   || market_id                     u64 big-endian
   || round                         u32 big-endian
   || outcome                       1 byte: 0 = Yes, 1 = No
   || resolution_hash               32 bytes, the market's commitment
```

Every field but the address is fixed-length and the address XDR is
self-delimiting, so the encoding is unambiguous. `network_id` and the resolver
address stop replay across networks and deployments, `market_id` across
markets, `round` across guardian cancellations, and `resolution_hash` ties a
signature to the exact committed committee. `cancel_proposal` increments the
round, so signatures collected before a cancellation can never be reused.

Rules the contract enforces:

* A key counts once per round, for one outcome only (`SigSeen`), so a signer
  cannot contribute weight to both outcomes.
* Non-members and already-counted keys are skipped; **one invalid signature
  aborts the whole batch** (`ed25519_verify` traps), so submitters pre-filter
  with `agents/core/attestation.ts`.
* The proposal (and its dispute window) is written only when the weight first
  reaches the threshold; extra signatures never move `proposed_at`.
* `MAX_WEIGHTED_SIGNERS = 32` keys and `MAX_SIGS_PER_CALL = 32` signatures. 32
  signatures cost 23.1M instructions / 2.9 MB with the compiled wasm, under 6% /
  7% of the 400M-instruction / 40 MiB transaction limits.
* Choose `weight_threshold` above half the total weight so two outcomes cannot
  both reach it; if they could, the first to reach it owns the proposal.

A `G...` account's raw key is `StrKey.decodeEd25519PublicKey(address)`;
`C...` contract addresses have no Ed25519 key and cannot be committee members.

## Committee commitments and rotation bounds

Markets can run for weeks or months. If a fixed signer loses their key or suffers a compromise, an attested market could otherwise freeze or become unresolvable. To address operational rotation needs without breaking the commit-reveal invariant, `ResolutionSpec::Committee(CommitteeRef)` commits to a named committee registry entry rather than raw addresses:

- `CommitteeRef { committee_id: u64, min_epoch: u32, max_rotation_delta: u32, dispute_window: u64 }`
- Appended as a new `ResolutionSpec` variant so existing `Price` / `Signers` hashes remain byte-identical.
- The committee admin proposes rotations subject to a time lock (`rotation_delay >= MIN_ROTATION_DELAY = 86_400`). Anyone can execute the rotation once the delay elapses.
- `attest` and `finalize_signers` enforce rotation bounds: `epoch >= min_epoch` and `epoch - min_epoch <= max_rotation_delta`. A creator setting `max_rotation_delta = 0` gets exact fixed-membership semantics.
- In `finalize_signers`, votes are recounted against the current epoch's active members (`MemberAt(committee_id, epoch)`), preventing rotated-out keys from deciding outcomes.

## Hybrid resolution mode: Price feed with attested fallback

High-frequency Reflector oracle feeds can experience unexpected upstream outages, sequencer downtime, or missing asset feeds. `ResolutionSpec::Hybrid(HybridConfig)` couples a primary price threshold check with a time-locked signer fallback:

- Commit structure: `HybridConfig { price: PriceConfig, fallback_signers: Vec<Address>, fallback_threshold: u32, dispute_window: u64, fallback_delay: u64 }`.
- Prior to `close_time + fallback_delay`, the resolver strictly requires `resolve_price`.
- After `close_time + fallback_delay`, anyone can call `open_fallback(market_id)` to transition `ResolutionState::HybridPricePending` to `ResolutionState::HybridFallbackOpen`, enabling signers to attest.
- Dual-path safety: if a usable price report arrives while an attested proposal is still pending in its dispute window, `resolve_price` immediately supersedes the proposal and finalizes the market directly from the oracle feed.

## Reasoning evidence commitments

To guarantee verifiable accountability for off-chain agent attestations, the resolver links attestation votes to cryptographic evidence traces published in `reasoning-registry`:

- `set_evidence_config(min_policy, registry)` configures system-wide trace verification standards.
- `attest_with_evidence(market_id, outcome, signer, trace_hash, reasoning_hash)` verifies with `reasoning-registry` that the trace exists and satisfies the required `EvidencePolicy`.
- Replay prevention: each `trace_hash` can be cited only once per market.
- Observability: the resolver retains an immutable append-only evidence trail accessible via `evidence_count` and `evidence_at`.

## Constrained guardian powers and audit trail

To eliminate unbounded administrative discretion and guarantee credible decentralization:

- Time-window constraints:
  - `cancel_proposal` is permitted only during the active dispute window (`DisputeWindowClosed` returned otherwise).
  - `guardian_void_market` can only be invoked after grace periods have expired: `close_time + REVEAL_GRACE_SECS` (3 days) for unrevealed specs, `close_time + ORACLE_GRACE_SECS` (1 day) for failing price feeds, and `close_time + SIGNER_GRACE_SECS` (7 days) for unresponsive signer sets.
- Cancellation rate limiting: `cancel_proposal` is strictly capped at `MAX_CANCELS_PER_MARKET = 2` cancellations per market to prevent indefinite griefing.
- Audit trail: both `cancel_proposal` and `guardian_void_market` require a typed `GuardianReason` enum (`StaleOracleFeed = 1`, `CompromisedSigner = 2`, `AmbiguousSpec = 3`, `LivenessFailure = 4`, `Other = 5`), emitting structured `GuardianAction` events with execution metadata.

## Early close: the commitment, the threat model, the late-trade policy (#22)

Context. A commitment must cover *who may end trading early and on what
evidence*, or a halt can be sprung on traders after they have priced the market.
`halt_trading` alone (market-core) is resolver-only and backdated at most
`MAX_BACKDATE_SECS`, but the authority to call it is delegated by a signer set,
so the delegation needs a commitment of its own.

Decision. The early-close config is **committed, resolver-local, and hashed in
its own domain tag**:

```
signer_with_early_close_hash = sha256(
    "oracledesk:early-close-spec" || XDR(SignerConfig) || XDR(EarlyCloseSignerSpec)
)
```

`EarlyCloseSignerSpec { early_close_threshold, early_close_window,
late_trade_policy }` lives in `contracts/resolver/src/lib.rs`, not in
`oracledesk-types`, for the same reason PR #171 kept its own config local: that
crate is the XDR-consensus surface shared by every consumer (and is the crate
that fails `cargo +stable check` with 21 pre-existing errors at this tip). The
preimage is a *third* hash space, disjoint from ADR 0001's legacy
`sha256(XDR(ResolutionSpec))` and ADR 0004's V2 `sha256(SPEC_DOMAIN || XDR(...))`:
every legacy preimage is the XDR of an `ScVal` and therefore starts with the
bytes `00 00 00 10`, while both tags start with ASCII `o`, and the two tags
differ within their first 13 bytes, so no preimage can be valid under both.
`register_signer_spec` and `legacy_spec_hash` are untouched, which is why every
existing spec hash and every existing golden vector holds **by construction**
rather than by re-baselining. `scripts/spec-hash` still only ever computes
legacy hashes; delegating the new tag into it is deliberately not done here.

A market reveals through `register_signer_early_close_spec` or
`register_signer_spec`, never both: each entrypoint checks its own commitment,
so the two authorities are not interchangeable after the fact
(`SpecHashMismatch` either way).

Vote agreement. `propose_early_close(market_id, signer, event_time)` requires
signer auth, membership in the market's existing signer group, the market still
`Open`, `now` before the effective close, one vote per signer per round, and
**exact agreement** on `event_time` with the vote already under consideration.
#22 allowed "match or take the maximum"; matching is what is auditable. A
maximum would let whichever signer votes latest silently move the refund
boundary for everyone, and a signer who genuinely believes a different instant is
the true one should be attesting `Invalid` on the outcome, not dragging a halt
forward. `event_time` must lie in `[now − MAX_BACKDATE_SECS, now]`: the upper
bound is what makes a halt a record of a fact rather than a schedule, the lower
bound is the same seven days the guardian's `SIGNER_GRACE_SECS` grace already
tolerates.

Threat model. The worst a captured or mistaken signer majority can do is
**freeze a market early**; it cannot choose the outcome, cannot move collateral,
and cannot resolve anything, because `finalize_signers`, `resolve` and
`void_market` are untouched. Three bounds make that the whole damage:
`early_close_threshold >= SignerConfig.threshold` (freezing is never easier than
resolving, validated at registration, and `<= signers.len()` so a quorum can
exist), `early_close_window > 0` with the halt gated behind it
(`EarlyCloseProposed` is visible before it lands and `cancel_early_close` is the
guardian's veto while it is open), and one halt per market, final and
non-extending (`effective_close` is a clamped `min`, so a corrupt value can never
lengthen a market's life). `cancel_early_close` clears the votes as well as the
proposal, unlike `cancel_proposal`, which leaves outcome counters in place: votes
for a rejected event time must not count towards the next round. It
deliberately does **not** consume `MAX_CANCELS_PER_MARKET`, because that budget
bounds churn of an *outcome*, and a guardian refusing a halt strands nothing —
trading simply continues to `close_time`.

Late trades. The policy is **accept and disclose**, committed in
`late_trade_policy` and enforced by `TradingHalted`, which publishes
`effective_at`, `halted_at`, `close_time` and `last_trade_at` so the window
`[effective_at, halted_at)` can be flagged and repriced off-chain. Trades in it
are not reverted: they settled against a pool that was still open, and
clawing them back would move collateral belonging to parties who relied on the
market being tradable — the explicit non-goal of #22. *Void-if-late* was
rejected because it converts one signer group's latency into a total loss for
every holder (a void pays half per share, which under `CostBasis` (#21) is a
second-order refund surprise on top of a halt), and because `last_trade_at`
measures the last accepted trade, not every trade in the window, so it cannot
decide a void honestly. `LateTradePolicy::VoidIfLate` remains registerable so a
creator can be honest about intending it, and nothing acts on it yet.

Follow-up for maintainers, named rather than assumed: the canonical home of
`EarlyCloseSignerSpec` is a `ResolutionSpec::SignersWithEarlyClose` variant in
`oracledesk-types::ResolutionSpec` / `SignerConfig`, which would let
`scripts/spec-hash` and `packages/bindings` see it. That append changes the XDR
every consumer decodes and therefore requires re-rendering the sha256-pinned
`market_core.wasm`/`treasury` blobs and the generated bindings together with it;
neither is possible from this checkout, so it is left as the maintainer step it
has always been.
\n

## Agent flow and recovery

Create and reveal are two transactions, and between them only the agent
holds the preimage of `resolution_hash`. If the spec is lost there (crash,
wiped working directory, container restart), the market can only end
through `guardian_void_market`. The market-maker
(`agents/bin/market-maker.ts`, `agents/core/maker-flow.ts`) therefore runs:

1. **Build** a `SpecJson` (`agents/core/spec.ts`) from `MM_*` config:
   signers mode (`MM_SIGNERS`, default `deployments.agent`;
   `MM_SIGNER_THRESHOLD`; `MM_DISPUTE_WINDOW_SECS`) or price mode
   (`MM_REFLECTOR`, `MM_ASSET`, `MM_PRICE_THRESHOLD`, `MM_PRICE_DIRECTION`,
   `MM_MAX_STALENESS_SECS`, or a signal's own `priceRule`). `validateSpec`
   mirrors the resolver's `InvalidConfig` rules exactly, and `close_time`
   must exceed `now + dispute_window + MM_CLOSE_MARGIN_SECS`.
2. **Canonicalize**: signers are sorted lexicographically by strkey. `Vec`
   order is part of the XDR (`signer_spec_hash_depends_on_signer_order`), so
   the same order is used to hash and to reveal. `scripts/seed-market.sh`
   sorts the same way.
3. **Commit** through `SpecHasher` (`agents/core/spec-hasher.ts`):
   `scripts/spec-hash` via `execFile` (`SPEC_HASH_BIN` for a prebuilt binary,
   else `cargo run`), or the TypeScript resolution-spec library when
   installed. `--verify-spec-hash` runs both and fails on disagreement.
4. **Persist** a `pending_create` entry to `AGENT_SPEC_DIR` (default
   `./.specs`, gitignored, separate from `.traces/`) with
   `agents/core/spec-store.ts`: temp file, fsync, atomic rename, fsync of
   the directory, then the optional `SPEC_BACKUP_CMD`. The create is not
   built until this write has resolved. **Back up this directory.**
5. **Create** with `resolution_hash = commitment`, mark the entry `created`
   with its market id, **reveal** with `register_signer_spec` /
   `register_price_spec`, and mark it `revealed`.

`recoverSpecs` runs at startup and after every create attempt, and drives
every non-terminal entry forward:

- `created`: if the market's spec is not registered yet, reveal it. A price
  reveal leaves `state()` at `Unconfigured`, so the resolver's
  `Price(market_id)` entry is checked too. Reveal is permissionless, so
  `MarketAlreadyConfigured` from someone who revealed first counts as
  success once the market's `resolution_hash` is confirmed to equal the
  stored commitment. A failed reveal stays `created` and is retried; entries
  older than `MM_STALE_REVEAL_SECS` are logged as alerts.
- `pending_create` (crash or RPC failure after the write, market id unknown):
  scan the newest `MM_RECOVERY_MAX_SCAN` market ids for
  `resolution_hash == commitment && creator == treasury`, plus a matching
  `question_hash` and `close_time`. Each market is claimed by at most one
  entry, because identical specs (the spec does not include the question)
  share a commitment. A match moves to `created` and is revealed. With no
  match after `MM_PENDING_TTL_SECS`, the entry is marked `abandoned` and its
  file is kept.
- A create that failed before submission (simulation rejected it, e.g.
  `TradeCapExceeded`; the adapter raises `NotSubmittedError`) created no
  market, so its entry is marked `abandoned` immediately instead of waiting
  for the TTL.

Dry-run mode uses an in-memory store and skips recovery, so it never
leaves entries behind for a live run. Creating and revealing atomically in
one transaction (`agent_create_market_and_reveal`, used by
`scripts/seed-market.sh`) removes this window entirely; this flow and its
recovery loop cover agents that still use the two-step path.
