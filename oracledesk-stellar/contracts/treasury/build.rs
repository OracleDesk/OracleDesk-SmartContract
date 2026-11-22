// Pins the vendored cross-contract wasm to its committed sha256 (issue #58),
// so a stale copy is a compile error rather than a silent old interface.
#[path = "../../scripts/verify-wasm-hash.rs"]
mod verify_wasm_hash;

fn main() {
    verify_wasm_hash::verify_wasm_hash("market_core.wasm", "market_core.wasm.sha256");
    // The resolver client (register_spec_v2, trade_status, spec_kind) is
    // generated from this copy; it is pinned like market_core.wasm (#273).
    verify_wasm_hash::verify_wasm_hash("resolver.wasm", "resolver.wasm.sha256");
}
