// Pins the vendored cross-contract wasm to its committed sha256 (issue #58),
// so a stale copy is a compile error rather than a silent old interface.
#[path = "../../scripts/verify-wasm-hash.rs"]
mod verify_wasm_hash;

fn main() {
    verify_wasm_hash::verify_wasm_hash("market_core.wasm", "market_core.wasm.sha256");
    verify_wasm_hash::verify_wasm_hash("reasoning_registry.wasm", "reasoning_registry.wasm.sha256");
}
