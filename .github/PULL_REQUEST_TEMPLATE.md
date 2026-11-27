## Summary

<!-- What does this PR change, and why? Link the issue it closes, e.g. "Closes #123". -->

## Base branch

- [ ] This PR targets `develop` (PRs into `main` are closed automatically).

## Checklist

- [ ] `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass (`make lint`).
- [ ] `cargo test --workspace` passes (`make test`).
- [ ] If contracts changed: the vendored `market_core.wasm` files were rebuilt and committed, and `make bindings && git diff --exit-code packages/bindings` is clean.
- [ ] If the Python model, `x402/`, or `agents/` changed: their tests pass locally.
- [ ] Docs updated where behaviour or setup changed.

## Testing

<!-- How did you verify this change? Include commands run and relevant output. -->

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, follow-ups, areas you want extra scrutiny on. -->
