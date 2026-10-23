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

The `ResolutionSpec` enum gains two **appended** variants —
`CategoricalSigners` (tag 4, for n-outcome markets) and `Scalar` (tag 5, a
price spec that resolves to a payout in basis points rather than an
outcome). Appending preserves the disjointness argument above: existing
variants keep their tags, so every already-committed hash is unchanged, and
each new rule lives in its own hash space. See
[ADR 0006](0006-market-kind-storage-split.md).

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
  `PriceUnavailable`, so a broken oracle address cannot make expiry revert
  forever; any other error (for example `NotInitialized`) is still surfaced.

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
