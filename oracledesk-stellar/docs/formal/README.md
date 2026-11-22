# Formal model: resolution lifecycle

[`resolver.tla`](resolver.tla) is a TLA+ model of how one market goes from
`Open` to a final state, checked with TLC. It is documentation as much as a
proof artifact: each action mirrors one entrypoint of
`contracts/resolver/src/lib.rs` or `contracts/market-core/src/lib.rs`.

```bash
make formal            # runs every config of both models, checks each outcome is the expected one
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
  re-entry). This was not investigated here; it is now modelled and confirmed
  in the [Governance model](#governance-model) below (finding G1).

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

---

# Governance model

[`governance.tla`](governance.tla) models the three protocols that decide who
can change OracleDesk's money-moving configuration: **two-step admin transfer**
(ADR 0007), **authenticated wiring** (ADR 0006) and the **governance timelock**
(ADR 0008). It runs under the same `make formal` as the resolver model.

## What is modelled

Contracts `Core` (market-core), `Res` (resolver), `Tre` (treasury), `TL`
(timelock) and a `Wrong` peer (has `accept_market_core_role` but is wired to a
different market-core, i.e. a misconfigured deploy). Keys `k1` (proposer),
`k2` (canceller/watchdog and emergency), `k3` (every admin). `Actors` restricts
which keys may act: most configs let anyone act, and the attack configs let
exactly one **compromised** key act while the honest keys stay idle.

**The call stack.** Soroban forbids calling a contract that is already
executing, and rolls an invocation back on any error. `PeerAccept` builds the
stack of the whole transaction (`lastStack`) and the transaction *reverts* when
it would invoke a contract already on it (`Invoke(stack, c) == c \notin
Range(stack)`); a reverted attempt changes nothing but `lastResult`. Contract
auth is modelled as "the invoker, or a signer of the key", never "any signer".

| TLA+ action | Rust entrypoint |
|---|---|
| `ProposeAdmin(c, k, n)` | `propose_admin` (market-core, resolver, registry, timelock): `require_admin`, `PendingAdmin{address, expires_at = now + TTL}` |
| `AcceptAdmin(c, k)` | `accept_admin`: rejects `now > expires_at`, then `pending.require_auth()` |
| `CancelAdmin(c, k)` | `cancel_admin_transfer` |
| `ProposeWiring(r, p, k)` | market-core `propose_resolver` / `propose_treasury` (admin; no expiry; overwrites silently) |
| `PeerAccept(p, r, k)` | the peer's `accept_market_core_role()` -> market-core `accept_resolver` / `accept_treasury`; mode `Callback` adds the callback `peer.market_core()` |
| `Schedule(k, fn, a)` | timelock `schedule` (proposer auth; `eta = now + max(floor, override)`; `expires = eta + EXECUTION_GRACE`) |
| `Execute(i, k)` | `execute` (executor or anyone; `eta <= now <= expires`; one self-call today, `set_default_delay`) |
| `Cancel(i, k)` | `cancel` (canceller auth) |
| `Emergency(k, t, fn)` | `emergency` (emergency auth; only `set_paused(true)` and `cancel_proposal`, on **any** target) |
| `SetRoles`, `SetDelay`, `LowerDefaultDelay` | admin-instant `set_roles`, `set_delay`, `set_default_delay` (lowering) |
| `Tick` | ledger time (saturates at `MaxTime`; a pending operation records whether the watchdog held the canceller role through a tick) |

Each contract's own expiry variant is modelled (`NotExpired(c)`): all four
accept at `now == expires_at` and reject from `expires_at + 1`.

**Abstractions.** One configuration change on a core contract is one opaque
`cfg` operation. Operation arguments are fixed except for `set_roles` and
`set_default_delay`. Violations are recorded as flags set by the offending
action (not as a growing history), so the state space stays tiny. Bounds: 3
keys, `MaxTime = 6`, `AdminTTL = 2`, `MinDelay = 1`, `MaxDelay = 2`,
`Grace = 2`, at most 2 operations. Symmetry over keys is not used: every config
finishes in well under a second, and symmetry is unsound for the liveness
configs anyway. Not modelled: the operation-hash/batch timelock extension, a
*lying* peer (the core admin chooses which peer to propose, so a contract that
lies about `market_core()` is already inside the trusted set), and treasury caps.

**Switches.** `AdminExpiry` (`"Code"` = accept at `<=`, `"Adr"` = `<`),
`WIRING_MODE` (`"Callback"` today, `"PeerAsserts"` proposed), `TIMELOCK_SELF_ADMIN`
(execute also handles `accept_admin` / `set_roles` self-calls),
`START_HANDED_OVER` (the timelock is its own admin), `WatchdogVigilant` (the
watchdog cancels whatever a compromised key scheduled), `Mutation` (a
deliberate bug).

## Properties

| Name | Meaning | Kind |
|---|---|---|
| `NoUnauthorisedAdminChange` | admin changes only by the address the then-admin proposed, authorised by that address | invariant |
| `NoExpiredAccept` | ADR 0007: an accept needs `now < expires_at` | invariant |
| `NoWiringToUnconsentingPeer` | `wiring[role]` changes only to a peer wired to this core that initiated the accept | invariant |
| `WiringLiveness` | an honest proposal followed by the peer's accept eventually updates wiring | temporal (weak fairness on honest actions only) |
| `StalePendingWiring` | witness: a pending wiring proposal is never accepted after the admin TTL | invariant (expected to fail) |
| `NoExecuteBeforeEta`, `NoExecuteAfterExpiry` | an operation executes inside `[eta, expires]` | invariants |
| `CancelWinsBeforeExecute` | a cancelled operation never executes | invariant |
| `EmergencyAllowListOnly` | emergency runs only `set_paused(true)` / `cancel_proposal` | invariant |
| `NoInstantPowerFromSingleKey` | no single compromised key changes a core configuration without `MinDelay` passing and a tick in which the honest watchdog held the canceller role | invariant (expected to fail for the timelock admin) |

## Results

| Config | Expected | Result | Distinct states | Time |
|---|---|---|---|---|
| `governance_admin.cfg` | `NoExpiredAccept` fails (ADR vs code) | **violated** (exit 12) | ~300 | < 1 s |
| `governance_admin_aligned.cfg` (`AdminExpiry = "Adr"`) | all hold | **No error** | 6,111 | ~1 s |
| `governance_wiring_callback.cfg` | `WiringLiveness` fails | **violated** (exit 13) | 609 | ~1 s |
| `governance_wiring_peer_asserts.cfg` | all hold | **No error** | 3,426 | ~2 s |
| `governance_wiring_safety.cfg` (every peer proposable) | all hold | **No error** | 23,898 | ~2 s |
| `governance_stale_wiring.cfg` | `StalePendingWiring` fails | **violated** (exit 12) | ~400 | < 1 s |
| `governance_timelock.cfg` (honest roles) | all hold | **No error** | 1,428 | ~1 s |
| `governance_single_key.cfg` (compromised timelock admin) | `NoInstantPowerFromSingleKey` fails | **violated** (exit 12) | ~1,000 | < 1 s |
| `governance_selfadmin.cfg` (timelock is its own admin) | all hold | **No error** | 14,567 | ~2 s |

All finish in a few seconds on a laptop (target was < 60 s on CI). Violated
configs stop at the first counterexample, so their state counts vary run to run.

## Findings

### G1. The authenticated-wiring handshake cannot succeed for any contract peer (confirmed; matches the resolver README's note)

`governance_wiring_callback.cfg`, `WiringLiveness` violated; the cycle is
`ProposeWiring("resolver", resolver)`, then `PeerAccept(resolver, "resolver")`
with `lastStack = <<resolver, core, resolver>>` and `lastResult = "reverted"`,
forever. `Resolver::accept_market_core_role` calls market-core's
`accept_resolver`, which calls back into the resolver for `market_core()` to
check consent. The resolver is already executing, so the host raises
`Error(Context, InvalidAction)` and rolls the whole transaction back. This is
the failure the earlier resolver README recorded and did not investigate.
`pending.require_auth()` is satisfied by the direct invoker, so only the
callback is the problem. Replayed against real wasm by
`model_trace_wiring_callback_reenters`.

Consequences: the wiring step of `deploy-testnet.sh` can never have completed
through this path on `develop`, and the treasury has no `accept_market_core_role`
at all (`HasAccept[Tre] = FALSE`), so `accept_treasury` (and `wire-timelock.sh`
for the treasury) cannot work either.

**Fix validated by the model** (`WIRING_MODE = "PeerAsserts"`): market-core drops
the callback and relies on `pending.require_auth()`, and the peer's
`accept_market_core_role` first asserts its own `market_core()` equals the
caller's core. `governance_wiring_peer_asserts.cfg` passes `WiringLiveness`, and
`governance_wiring_safety.cfg` shows the misconfigured peer (`Wrong`) can still
never be wired, because it fails its own assertion.

### G2. ADR 0007 and the code disagree by one second (confirmed)

`governance_admin.cfg`, trace `ProposeAdmin(timelock, k3, k1)`, `Tick`, `Tick`,
`AcceptAdmin(timelock, k1)`: accepted at `now == expires_at`. Every
implementation (market-core, resolver, registry, timelock) rejects only
`now > expires_at`, while ADR 0007 says a proposal is inert once
`expires_at <= now`. `governance_admin_aligned.cfg` (the ADR's boundary) holds.
Replayed by `model_trace_admin_accept_at_expiry_boundary`. Fix by changing
either side; then flip that test and the config's expected exit code.

### G3. `PendingResolver` / `PendingTreasury` never expire (confirmed)

`governance_stale_wiring.cfg`: a wiring proposal made long ago is still
pending and acceptable. Unlike admin transfer there is no `expires_at`, and a
second proposal silently overwrites the first. Replayed (at the storage level)
by `model_trace_pending_wiring_never_expires`.

### G4. The timelock admin holds instant power (confirmed, trust assumption)

`governance_single_key.cfg`: `SetRoles(k3, k3, k1)`, `Schedule(k3, "cfg")`,
`Tick`, `Execute`. A single compromised timelock admin key makes itself
proposer, moves the canceller to a key the watchdog does not control (so
`WatchdogVigilant` cannot save it: the role change is instant and same-tick),
schedules a change and executes it after only `MinDelay`. `set_delay` and
`set_default_delay` (lowering) are instant too. Replayed by
`model_trace_timelock_admin_set_roles_instant`.

`governance_selfadmin.cfg` shows the alternative: with the timelock as its own
admin and execute handling the `set_roles` / `accept_admin` self-calls
(`TIMELOCK_SELF_ADMIN`), a compromised proposer cannot change anything the
watchdog does not have a tick to cancel. Today `execute` supports exactly one
self-call (`set_default_delay`), so the timelock can never accept its own admin
role (`model_trace_timelock_cannot_accept_its_own_admin`); until that changes,
the residual trust is exactly: the timelock admin key, the watchdog staying
honest and online, and the watchdog holding the canceller role.

### Other observations

- `emergency` allows `set_paused(true)` and `cancel_proposal` on any target
  address (`model_trace_emergency_any_target`); the allow-list is on the
  function and argument, not the target.
- `execute` removes the operation before invoking it, then returns an error for
  an expired or unsupported operation. The error rolls the removal back, so such
  operations stay in storage (harmless, but never cleaned up).

## Mutation checks

Each deliberate bug must be caught by a property; `make formal` runs them
(`FORMAL_MUTATIONS=0` skips):

| Mutation | Caught by |
|---|---|
| `accept_no_auth`: `accept_admin` without `require_auth` | `NoUnauthorisedAdminChange` |
| `execute_ignores_eta`: `execute` ignores `eta` | `NoExecuteBeforeEta` |
| `cancel_skips_removal`: `cancel` leaves the operation in storage | `CancelWinsBeforeExecute` |
| `emergency_allows_all`: allow-list widened to everything | `EmergencyAllowListOnly` |

## Conformance tests

`cargo test -p integration-tests --test governance_model` (after `make build`)
replays the traces against the real wasm of market-core, resolver and timelock,
with no `mock_all_auths`:

| Test | Model trace |
|---|---|
| `model_trace_wiring_callback_reenters` | `governance_wiring_callback.cfg` (G1) |
| `model_trace_admin_accept_at_expiry_boundary` | `governance_admin.cfg` (G2) |
| `model_trace_admin_accept_requires_the_pending_address` | `governance_admin_aligned.cfg` |
| `model_trace_pending_wiring_never_expires` | `governance_stale_wiring.cfg` (G3) |
| `model_trace_timelock_cancel_before_execute` | `CancelWinsBeforeExecute` |
| `model_trace_execute_before_eta_rejected` | `NoExecuteBeforeEta` |
| `model_trace_emergency_any_target` | `EmergencyAllowListOnly` |
| `model_trace_timelock_admin_set_roles_instant` | `governance_single_key.cfg` (G4) |
| `model_trace_timelock_cannot_accept_its_own_admin` | `TIMELOCK_SELF_ADMIN = FALSE` |

Each test that is expected to change when a finding is fixed says so in its doc
comment, and names the config whose expected exit code in `scripts/formal.sh`
must change with it. No contract behaviour was changed by this work.
