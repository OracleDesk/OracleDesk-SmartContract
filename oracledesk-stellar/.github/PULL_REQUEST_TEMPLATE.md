## What this does

<!-- One or two sentences. Link the issue this closes, if any. -->

## Checklist

- [ ] `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass
- [ ] `cargo test --workspace` passes
- [ ] If contract interfaces changed: bindings regenerated (`make bindings`) and included in this PR
- [ ] If `market-core`'s interface changed: `resolver`/`treasury`'s vendored `market_core.wasm` refreshed
- [ ] New behavior has a test; changed behavior's test was updated, not deleted
- [ ] `docs/STATUS.md` updated if this changes what's verified/unverified

## How this was tested

<!-- Command output, or "ran make demo end to end", etc. -->
