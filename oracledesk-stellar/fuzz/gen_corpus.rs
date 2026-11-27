//! Regenerates the committed seed corpus under `fuzz/corpus/`.
//!
//! Run with:
//!     cargo run --manifest-path fuzz/Cargo.toml --bin gen_corpus
//!
//! Math targets decode `<u64, u64, u64, u16, u8>` (see the target files)
//! little-endian, so the seeds below are the documented boundary values with
//! a `scale` of 0. The sequence target uses the byte-oriented op encoding in
//! `fuzz_targets/fuzz_market_core_sequence.rs`.

#[path = "fuzz_targets/seed_encoding.rs"]
mod seed_encoding;

use seed_encoding::{math_seed, sequence_seed};
use std::fs;
use std::path::Path;

fn write(path: &str, bytes: &[u8]) {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

fn main() {
    let max = 1_000_000_000_000_000u64;
    let min_seed = 100 * 10_000_000u64;

    for (name, a, b, c, fee) in [
        ("max_sets", max, max, 1_000_000_000, 999),
        ("min_seed", min_seed, min_seed, min_seed, 0),
        ("unit", 1_000, 1_000, 100, 100),
        ("fee_cap", max - 1, max - 1, 1_000_000_000, 1_000),
        ("zero", 0, 0, 0, 0),
    ] {
        write(
            &format!("corpus/fuzz_calc_buy/{name}"),
            &math_seed(a, b, c, fee as u16, 0),
        );
    }
    for (name, a, b, c, fee) in [
        ("max_sets", max, max, 1_000_000_000, 999),
        ("min_seed", min_seed, min_seed, min_seed, 0),
        ("unit", 1_000, 1_000, 100, 100),
        ("near_other", 1_000, 1_000, 999, 0),
        ("zero", 0, 0, 0, 0),
    ] {
        write(
            &format!("corpus/fuzz_calc_sell/{name}"),
            &math_seed(a, b, c, fee as u16, 0),
        );
    }
    for (name, seed, p) in [
        ("max_sets", max, 5_000u16),
        ("min_seed", min_seed, 100),
        ("one", 1, 5_000),
        ("skew", max, 100),
    ] {
        write(
            &format!("corpus/fuzz_seed_reserves/{name}"),
            &seed_encoding::seed_seed(seed, p, 0),
        );
    }
    for (name, a, b, c) in [
        ("max_sets", max, max, max),
        ("divisible", 100, 3, 7),
        ("one", 1, 1, 1),
        ("zero", 0, 0, 0),
    ] {
        write(
            &format!("corpus/fuzz_mul_div/{name}"),
            &seed_encoding::mul_div_seed(a, b, c, 0),
        );
    }
    for (name, rs, ro, out, fee) in [
        ("max_sets", max, max, 1_000_000_000, 999),
        ("unit", 1_000, 1_000, 100, 0),
        ("round_trip", 1_000, 1_000, 100, 100),
        ("zero", 0, 0, 0, 0),
    ] {
        write(
            &format!("corpus/fuzz_sell_inverse/{name}"),
            &math_seed(rs, ro, out, fee as u16, 0),
        );
    }
    for (name, bytes) in sequence_seed() {
        write(&format!("corpus/fuzz_market_core_sequence/{name}"), &bytes);
    }

    println!("wrote corpus under fuzz/corpus/");

    for (target, seeds) in [
        ("fuzz_resolver_signatures", seed_encoding::resolver_sig_seed()),
        ("fuzz_resolver_committee", seed_encoding::resolver_committee_seed()),
        ("fuzz_resolver_spec_decode", seed_encoding::resolver_spec_seed()),
    ] {
        for (name, bytes) in seeds {
            write(&format!("corpus/{target}/{name}"), &bytes);
        }
    }
}
