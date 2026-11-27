# OracleDesk fuzz targets

Structured [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html)
targets for the contracts. The crate is a standalone workspace (it needs the
soroban-sdk `testutils` host and a nightly toolchain) and registers contracts
**natively**, so no wasm is instantiated per input.

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
cd oracledesk-stellar/fuzz
cargo +nightly fuzz build                       # all targets
cargo +nightly fuzz run fuzz_resolver_signatures -- -max_total_time=600 -max_len=4096
```

On macOS the contract crates' `cdylib` output does not link with
cargo-fuzz's flags; add
`RUSTFLAGS="-Clink-arg=-Wl,-undefined,dynamic_lookup"` and `-s none`
(CI runs on Linux with the default AddressSanitizer build).

## Targets

| Target | What it drives |
| --- | --- |
| `fuzz_calc_buy`, `fuzz_calc_sell`, `fuzz_sell_inverse`, `fuzz_seed_reserves`, `fuzz_mul_div` | market-core FPMM math (#69) |
| `fuzz_market_core_sequence` | market-core create/trade/settle sequences (#69) |
| `fuzz_resolver_signatures` | weighted-key `submit_signatures`, `cancel_proposal`, `finalize_signers` (#278) |
| `fuzz_resolver_committee` | committee attestations and rotations (#278) |
| `fuzz_resolver_spec_decode` | `ResolutionSpecV2` XDR decoding and `register_spec_v2` (#278) |

The byte encoding of every target is documented at the top of its file and
written by `fuzz_targets/seed_encoding.rs`.

## Resolver invariants

Each stateful resolver target keeps an **independent reference model** (it
never calls back into contract logic to decide what should happen) and
compares results and stored state after **every** op. Shared setup lives in
`src/resolver_harness.rs`.

**`fuzz_resolver_signatures`** — registration agrees with an independently
written weighted-config rule. Every `submit_signatures` result is predicted
as `Ok`, a contract error, or a trap (an invalid signature from an unseen
member aborts the whole batch; the model treats it as a no-op). After every
op: stored per-round weight equals the model; `SigSeen` equals the model's
seen set (no key counts twice in a round); a proposal exists iff an outcome
first crossed the threshold in the current round, and `submit_signatures`
never replaces it; after `Cancel`, old-round signatures fail with
`StaleRound`; `Finalize` succeeds only after the dispute window with the
current round at the threshold; `cancel_proposal` stops at
`MAX_CANCELS_PER_MARKET` (`TooManyCancels`). Forged entries differ from a
valid signature in exactly one thing: the outcome, the round, the domain tag,
the network id, the resolver address, or one signature byte. Once per
process the local copy of the attestation message layout is checked against
the contract by submitting a signature over it.

**`fuzz_resolver_committee`** — `RotationBoundExceeded` exactly when the
model's epoch is outside `[min_epoch, min_epoch + max_rotation_delta]`;
quorum counts only attestations of *current* members (checked through every
`finalize_signers` result); `finalize_signers` never succeeds without quorum;
the stored committee (epoch, members, threshold) equals the model after every
op. Whether a quorum reached in epoch `e` survives a rotation is **logged,
not asserted**: `AttestEpoch` semantics are still open.

**`fuzz_resolver_spec_decode`** — raw mode: decoding arbitrary bytes into a
`ResolutionSpecV2` never panics and anything that decodes re-encodes
byte-for-byte. Decoding goes XDR → `ScVal` → `Val` → type through the
fallible steps only (malformed input and limit errors are errors; in a
contract they are a clean trap). Structured mode: `register_spec_v2` follows
the precedence `InvalidConfig` (version, salt) → `DomainMismatch` →
`MarketAlreadyConfigured` → `InvalidConfig` (`validate_rule`) →
`SpecHashMismatch`; a successful reveal configures the market (a second
reveal is `MarketAlreadyConfigured`, non-price rules leave `Unconfigured`);
and an accepted signer rule must be reachable by distinct addresses.
`AlreadyFinalized` is not reached by this target (it needs a full
resolution first).

## Findings

| Id | Found by | Status |
| --- | --- | --- |
| `dup-signers` | `fuzz_resolver_spec_decode` (reachability invariant) | `validate_rule` accepts `Signers` / `SignersDisputable` / `Hybrid` fallback rules that list one address several times, so `[A, A]` with threshold 2 passes but can never reach quorum. Tracked by the ignored regression test `signers_rule_rejects_duplicate_addresses` in `contracts/resolver`; fix in a separate PR (it changes which specs are accepted). |

`ORACLEDESK_FUZZ_ALLOW` is a comma-separated allow-list of **tracked**
finding ids. CI sets it to `dup-signers` so the smoke job keeps exploring
past the known gap; never set it when hunting locally. Remove the entry
together with the fix.

## Mutation check (#278)

With the `SigSeen` check removed from `submit_signatures` (so a key can count
twice per round), `fuzz_resolver_signatures` reported a model mismatch
within the first seconds of a run from the committed corpus (the
`weighted_duplicate_sig_ignored` seed reaches it directly), well inside the
120 s budget.

## Throughput

Measured on an Apple-silicon laptop, `-s none`, 120 s runs:

| Target | exec/s |
| --- | --- |
| `fuzz_resolver_signatures` | ~190 |
| `fuzz_resolver_committee` | ~300 |
| `fuzz_resolver_spec_decode` | ~600 |

## Corpus

`corpus/<target>/` holds the seeds written by `gen_corpus.rs` (they mirror
the resolver unit tests `weighted_fixture`, `weighted_duplicate_sig_ignored`,
`submit_signatures_guards`, a cancel-then-resign round and a rotation past
its bound). Regenerate with

```bash
cargo run --manifest-path fuzz/Cargo.toml --bin gen_corpus   # must produce no diff
cargo +nightly fuzz run <target> fuzz/corpus/<target> -- -runs=0   # replay
```

Do not commit the inputs a fuzz run adds to `corpus/`; only seeds written by
`gen_corpus` are committed.

## Adding a regression

1. Minimise the crash: `cargo +nightly fuzz tmin <target> artifacts/<target>/crash-…`.
2. Turn the minimised input into a named `#[test]` in the contract's test
   module (e.g. `signers_rule_rejects_duplicate_addresses`), asserting the
   correct behaviour.
3. If the fix changes behaviour, land it in a separate PR; until then mark
   the test `#[ignore = "tracked finding <id> …"]`, add the id to the table
   above and, if CI must stay green, to `ORACLEDESK_FUZZ_ALLOW` in
   `.github/workflows/fuzz.yml`.
