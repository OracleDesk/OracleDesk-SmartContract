# interface-manifest

Standalone development tool; never linked into contract WASM. Run from
`oracledesk-stellar/` with `CARGO_TARGET_DIR=target` to share build artifacts.

```
cargo run --manifest-path scripts/interface-manifest/Cargo.toml -- extract \
  --wasm target/wasm32v1-none/release/resolver.wasm --contract resolver
cargo run --manifest-path scripts/interface-manifest/Cargo.toml -- diff \
  --old /tmp/old.json --new packages/bindings/resolver/interface.json --format json
make interface-check INTERFACE_BASE_REF=upstream/develop
```

The schema uses sorted maps of definitions, each containing its XDR spec kind
and decoded spec. Type references retain stellar-xdr's semantic tags (`udt`,
`option`, `result`, `vec`, `map`, `bytes_n`, `tuple`, and primitive names), rather
than storing opaque bytes or parsing generated TypeScript. Numeric codes,
argument positions, event locations and data formats survive normalization.
Docs whitespace and order-insensitive named fields/union cases are canonical.

`roots.toml` lists commitment types; transitive reachability handles nested type
references and cycles. `imports.toml` restores origins erased by contractimport;
reports identify the defining contract. A consumer package still needs a bump
when its exported interface changes. Several breaking items require one version
bump of the maximum severity, never repeated increments.

`check` reads manifests and package versions directly from the supplied git ref.
Breaking changes require 0.y+1.0 or x+1.0.0, additions at least a patch, and each
new version a nonempty `## VERSION` changelog section. Its body must include
all breaking item identifiers verbatim. Docs alone need no version bump.
New manifests establish a nonzero initial release with a changelog.

Tests include semantic rules, actual Soroban named-struct XDR equivalence, a
throwaway git repository demonstrating CLI enforcement, extraction determinism
from committed cross-contract WASMs, and all six built-WASM golden manifests.
Run `make build` before these golden tests.

stellar-xdr 27 exports current types at the crate root and has no `curr` feature;
its `std`/`serde` feature set matches soroban-spec 27.0.6. Both versions are pinned.
