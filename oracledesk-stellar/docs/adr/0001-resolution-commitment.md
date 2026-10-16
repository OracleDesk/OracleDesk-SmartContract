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
[ADR 0005](0005-market-kind-storage-split.md).

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
