# Resolver: dispute-window and guardian edge-case tests

## Context

`contracts/resolver/src/lib.rs` has tests for the happy path of both
resolution modes (`price_mode_resolves_from_historical_reflector_price`,
`signer_mode_requires_threshold_and_waits_for_dispute_window`) and for the
guardian functions added alongside the resolution-commitment work
(`guardian_can_cancel_a_disputed_proposal`,
`wrong_caller_cannot_use_guardian_functions`). Several edge cases around the
interaction of disputes and guardian actions are untested:

- Attesting to *two different outcomes* passing threshold on each (can this
  happen? what does `finalize_signers` do if so?).
- A guardian cancelling a proposal, then a *new* proposal reaching threshold
  again after re-attestation — does the second one dispute-window and
  finalize correctly?
- `guardian_void_market` called *after* `finalize_signers` has already
  resolved the market (should fail — `AlreadyFinalized` — is this actually
  checked in every path, or only some?).
- Attesting after the market has already been voided by a guardian.

## What to change

Add tests for each scenario above in `contracts/resolver/src/lib.rs`'s test
module. Where a test reveals a real gap (e.g. an unchecked path), fix the
contract code, not just the test.

## Files to touch

- `contracts/resolver/src/lib.rs`

## Acceptance criteria

- Each scenario above has an explicit test with a clear name.
- Any bug found is fixed with a comment explaining the scenario it closes.

## How to test

```bash
cargo test -p resolver
```

## Complexity

`complexity/medium`
