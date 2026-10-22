# Formal model: resolution lifecycle

[`resolver.tla`](resolver.tla) is a TLA+ model of how one market goes from
`Open` to a final state, checked with TLC. It is documentation as much as a
proof artifact: each action mirrors one entrypoint of
`contracts/resolver/src/lib.rs` or `contracts/market-core/src/lib.rs`.

```bash
make formal            # runs every config, checks each outcome is the expected one
TLA2TOOLS=/path/to/tla2tools.jar make formal
```

`make formal` exits 0 with a skip message when Java is missing, and downloads
`tla2tools.jar` into `docs/formal/.tools/` (git-ignored) when it is not given.
Developed against TLC 2026.10.15 (rev 932d35e) on OpenJDK 17.

**Why TLA+/TLC and not Quint:** TLC checks safety, action properties and
liveness (under fairness) in one tool, needs only a JRE, and its traces map
one-to-one onto the Rust conformance tests below.

## What is modelled

One market, in either mode, with these actors: `N` signers, a guardian
(the resolver admin), an anonymous finalizer/expirer, the oracle, an optional
admin bypass, and time.

| TLA+ action | Rust |
|---|---|
| `RegisterSigners` / `RegisterPrice` | `register_signer_spec` / `register_price_spec` (`assert_unconfigured`; price mode stays `Unconfigured`) |
| `Attest(s, o)` | `attest` → `record_attestation` (per-`(outcome, signer)` dedup, `now >= close_time`, first quorum proposes, Invalid quorum displaces a pending Yes/No) |
| `Cancel` | `cancel_proposal(DisputeUpheld)` (inside the window, ≤ `MAX_CANCELS_PER_MARKET`, keeps counts) |
| `Finalize` | `finalize_signers` (window elapsed, quorum still holds; Yes/No → `resolve`, Invalid → `void_market`) |
| `GuardianVoid` | `guardian_void_market` with each `GuardianReason`'s on-chain precondition |
| `ResolvePrice(o)`, `OracleFlip` | `resolve_price`; the oracle's outcome and availability are environment non-determinism |
| `Expire` | `expire_market` (deadline; settles from a usable price; refuses while a quorum-backed proposal exists; otherwise voids) |
| `AdminBypass` | market-core admin installs another resolver (`propose_resolver`/`accept_resolver`) which resolves; this resolver never sees it |
| `Tick` | ledger time passing |

**Atomic reverts.** Soroban rolls back an invocation on any error, so an error
is an action that is not enabled. Guard order therefore only decides *which*
error the contract returns (e.g. `attest` checks `AlreadyFinalized` before
`AlreadyAttested`); the model does not distinguish them. market-core's own
guards are folded into the action that calls it (`status = "Open"` for both
`resolve` and `void_market`).

**Time.** `now` saturates at `D`: every guard compares it to a threshold `≤ D`
(`C`, `C+RG`, `C+OG`, `C+SG`, `D`), so later times are indistinguishable. A
proposal stores `age` (ticks since it was proposed) saturating at `W` instead
of `proposed_at`, since `now < proposed_at + W ⇔ age < W`. This also keeps
liveness checking finite.

**Not modelled** (deliberately; each is orthogonal to the lifecycle): FPMM
pricing, treasury and tokens, `SignersDisputable` bonds (`Disputed` state),
weighted keys, committee rotation and the hybrid mode's fallback opening, and
`u64` overflow (naturals are used; see Notes). Hybrid, weighted and committee
resolution all end in the same `resolve`/`void_market` calls modelled here.

**Bounds.** `Signers` is 2–4 model values, `T = 2`, `C = 1`, `W = 1`,
`RG = OG = 2`, `SG = 3`, `D = 6`, `MaxCancels = 2` (the contract's value).
Small constants are enough because behaviour only depends on the *order* of
the thresholds; symmetry over signers is used for the safety configs.

## Properties

| Name | Meaning | Kind |
|---|---|---|
| `TypeOK` | well-typed state | invariant |
| `AtMostOnceFinal` | market-core leaves `Open` at most once | invariant |
| `StatusMonotone` | after leaving `Open` the status never changes | action property |
| `VoidMeansNoResolve` | a `Void` market is never `Resolved` | action property |
| `FinalImpliesClosed` | resolver `Finalized`/`Expired` ⇒ market status ≠ `Open` | invariant |
| `ResolvedOutcomeHadThreshold` | a Yes/No result of a signer-mode market had quorum | invariant |
| `NoFinalizeAfterCancelWithoutNewProposal` | a cancelled proposal is never the one finalized | invariant |
| `WindowRespected` | signer finalization only after the dispute window | action property |
| `NoResolveBeforeClose` | nothing resolves or voids before `close_time` (except bypass) | invariant |
| `ProposalTimestampStable` | later attestations never replace a pending proposal except by an Invalid quorum | action property |
| `Liveness` | `<>(status ∈ {Yes, No})` under fairness | temporal |
| `NoStrandedQuorum` | witness: quorum exists but no proposal | invariant (expected to fail) |
| `NoInvalidDisplacement` | witness: Invalid never displaces Yes/No | action property (expected to fail) |

Liveness assumptions (`LiveSpec`): time passes, the market gets configured,
honest signers (who only ever vote Yes) attest when they can, a ready proposal
is finalized, and the guardian, expiry and bypass are off.

## Results

| Config | Expected | Result | Distinct states | Time |
|---|---|---|---|---|
| `resolver.cfg` (N=3, all modes, guardian, expiry) | all hold | **No error** | 40,200 | ~1 s |
| `resolver_both_outcomes.cfg` (N=4, T=2) | `ProposalTimestampStable` holds | **No error** | 100,518 | ~4 s |
| `resolver_live.cfg` (N=3, honest = 2) | `Liveness` holds | **No error** | 360 | < 1 s |
| `resolver_cancel.cfg` (N=T=2) | `NoStrandedQuorum` fails | **violated** (exit 12) | 143 | ~1 s |
| `resolver_invalid.cfg` (N=T=2) | `NoInvalidDisplacement` fails | **violated** (exit 13) | 255 | < 1 s |
| `resolver_bypass.cfg` (N=3) | `ResolvedOutcomeHadThreshold` fails | **violated** (exit 12) | 91 | ~1 s |
| `resolver_live_invalid.cfg` (N=4, honest = 2) | `Liveness` fails | **violated** (exit 13) | 4,966 | ~1 s |

State counts for the violated configs vary slightly from run to run (TLC stops
at the first violation while several workers are exploring); the verdicts do not.

The checks have teeth: dropping the window guard from `Finalize`, letting
`Cancel` keep the proposal, dropping the `Open` guard from market-core, or
allowing attestation before close each make one of the properties fail
(mutation-tested while writing the model).

## Findings

The issue that asked for this model listed four findings to investigate. The
contract has moved since that list was written; each was re-checked against the
current code.

### 1. `cancel_proposal` does not reset votes (confirmed, stranding possible)

`resolver_cancel.cfg`, trace: `RegisterSigners, Tick, Attest(s1,Yes),
Attest(s2,Yes), Cancel`. Counts survive a cancel, so a *new* signer attesting
the quorum outcome re-proposes instantly (a fresh window; the guardian may
cancel at most twice). But when every signer already backs the quorum outcome
(`N = T`, as in the unit-test fixture) nothing can re-propose it: the signers
cannot attest it again (`AlreadyAttested`), and `finalize_signers` fails with
`NoProposal`.

**Assessment: design limitation, doc now accurate.** The doc comment ("the next
attestation that brings any outcome to threshold … proposes again") already
describes the behaviour, but it is not obvious that this can dead-end a
market. The way out is intended: `GuardianReason::SignersStalled` after
`SIGNER_GRACE_SECS`, or `expire_market` after the deadline (which is allowed
because no proposal exists). Replayed by
`model_trace_cancel_strands_quorum_until_stalled_void`.

### 2. "Both outcomes can alternate proposals and delay finalization" (refuted)

`resolver_both_outcomes.cfg` (N=4, T=2, i.e. `T ≤ N/2`): `ProposalTimestampStable`
holds. Current `record_attestation` only proposes when no proposal is pending
(`may_propose`), so later attestations, including a quorum for the other
outcome, never move `proposed_at`. Replayed by
`model_trace_other_outcome_quorum_does_not_reset_window`.

The one exception is intended and was found by `resolver_invalid.cfg`: an
**Invalid** quorum displaces a pending Yes/No proposal and restarts the window,
and an Invalid proposal is never displaced (replayed by
`model_trace_invalid_quorum_displaces_yes_and_restarts_window`). Delay is
therefore bounded to one restart. With `T ≤ N/2`, a coalition of `T` dishonest
signers can force a Void instead of a Yes/No (`resolver_live_invalid.cfg`, the
documented "a quorum saying the question is unanswerable outranks an answer").
That is a property of the m-of-n trust assumption, not a bug.

### 3. Guardian void before close (refuted) and attest-after-void guard (sufficient)

`NoResolveBeforeClose` holds. Every `GuardianReason` other than `DisputeUpheld`
requires `now ≥ close_time`, and `DisputeUpheld` needs a proposal, which needs
an attestation, which needs `now ≥ close_time`. After a guardian void,
`attest` fails with `AlreadyFinalized` and `finalize_signers` (which does not
check `ResolutionState` itself) fails inside market-core with `MarketNotOpen`,
so the guard is sufficient. Replayed by `model_trace_no_void_or_attestation_before_close`
and `model_trace_guardian_void_blocks_later_attest_and_finalize`.

### 4. Admin bypass breaks `ResolvedOutcomeHadThreshold` (confirmed, trust assumption)

`resolver_bypass.cfg`: `RegisterSigners, Tick, AdminBypass(Yes)`. market-core's
admin can propose and accept another resolver, which resolves without this
resolver's signers voting at all; this resolver stays `SignersPending`. This is
the two-step wiring (ADR 0006, 0007) working as designed: the market-core admin
is trusted. Replayed by `model_trace_admin_bypass_resolves_without_threshold`.

### Other observations

- `cancel_proposal` does not check `ResolutionState`, so inside the window it
  also works on an already guardian-voided market (it only removes the
  proposal and spends one of the two cancels). Harmless; mirrored by the model.
- `finalize_signers` computes `proposed_at + dispute_window` with unchecked
  `+` (release builds enable `overflow-checks`, so it traps), while the other
  window checks use `saturating_add`. `dispute_window` is only validated
  non-zero. A huge window therefore means "never finalizable" either way, with
  `expire_market` refused (`ResolutionAvailable`) while a quorum proposal
  exists, so the guardian is the only exit. The model uses naturals and does
  not capture the trap, only the "never" part.
- While writing the bypass test, calling `Resolver::accept_market_core_role`
  on a second resolver in the unit-test environment failed with
  `Error(Context, InvalidAction)` (market-core's `accept_resolver` calls back
  into the same resolver for `market_core()`, which Soroban treats as
  re-entry). This was not investigated further and is not covered by the model;
  worth checking against the testnet deploy flow in
  `scripts/deploy-testnet.sh`.

No contract behaviour was changed by this work.

## Conformance tests

`cargo test -p resolver model_trace_` replays the traces against the real
contracts (two happy paths, plus one test per finding above):

| Test | Model trace |
|---|---|
| `model_trace_signers_happy_path_yes` | `resolver.cfg` signers path |
| `model_trace_price_happy_path_yes` | `resolver.cfg` price path |
| `model_trace_cancel_strands_quorum_until_stalled_void` | `resolver_cancel.cfg` |
| `model_trace_invalid_quorum_displaces_yes_and_restarts_window` | `resolver_invalid.cfg` |
| `model_trace_other_outcome_quorum_does_not_reset_window` | `resolver_both_outcomes.cfg` |
| `model_trace_no_void_or_attestation_before_close` | `NoResolveBeforeClose` |
| `model_trace_guardian_void_blocks_later_attest_and_finalize` | `resolver.cfg` |
| `model_trace_expire_blocked_by_valid_proposal` | `Expire` guard |
| `model_trace_admin_bypass_resolves_without_threshold` | `resolver_bypass.cfg` |

## Reproducing a counterexample

```bash
cd docs/formal
java -cp tla2tools.jar tlc2.TLC -config resolver_cancel.cfg resolver.tla -workers 1
```

`-workers 1` gives the shortest trace (breadth-first).
