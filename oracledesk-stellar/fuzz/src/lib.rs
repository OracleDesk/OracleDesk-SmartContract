//! Shared helpers for the OracleDesk libFuzzer targets.
//!
//! The crate is intentionally outside the main workspace: it depends on
//! soroban-sdk's testutils host and needs a nightly toolchain for
//! `cargo +nightly fuzz`. See `fuzz/README.md`.

pub mod inverse;
pub mod registry_model;
pub mod timelock_model;
pub mod timelock_targets;

/// Widen a fuzz-generated `u64` into the i128 domain the contracts use.
///
/// `scale % 80` keeps the shift well inside i128 (2^127) while still reaching
/// values far above `MAX_SETS`, so the math targets exercise overflow paths.
pub fn widen(x: u64, scale: u8) -> i128 {
    let shift = (scale % 80) as u32;
    (x as i128) << shift
}

/// Clamp generated values into a useful range without hiding edge cases.
pub fn bounded(x: i128, max: i128) -> i128 {
    if max <= 0 {
        return x;
    }
    x.rem_euclid(max + 1)
}
