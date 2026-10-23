// Shared `build.rs` helper that pins a vendored wasm artifact to a committed
// sha256 (issue #58).
//
// `contractimport!` reads `market_core.wasm` / `reasoning_registry.wasm` at
// the *dependent* crate's compile time, so a stale copy silently compiles
// against an old interface. A plain `git diff --exit-code` in CI only catches
// that after a full rebuild, and only if the build is bit-for-bit
// reproducible. This makes the stale copy a **compile error**: the expected
// digest lives in `<name>.wasm.sha256`, and the build fails unless the bytes
// on disk hash to it. Refreshing a vendored wasm (a deliberate, reviewable
// act) requires updating both files together.
//
// Self-contained (no build-dependency) so pinning does not change
// `Cargo.lock`; `include!`d by each contract's `build.rs`. Uses `//` rather
// than `//!` because rustc (>= 1.93) rejects an inner doc comment inside an
// `include!`ed fragment that is not the crate root.

use std::fs;
use std::path::Path;

/// Verifies `wasm_path` against the hex digest in `expected_path` (whitespace
/// trimmed). Panics with a contributor-facing message on mismatch, which turns
/// a stale vendored wasm into a compile error.
pub fn verify_wasm_hash(wasm_path: &str, expected_path: &str) {
    println!("cargo:rerun-if-changed={wasm_path}");
    println!("cargo:rerun-if-changed={expected_path}");

    let bytes = fs::read(wasm_path)
        .unwrap_or_else(|e| panic!("cannot read vendored wasm {wasm_path}: {e}"));
    let expected = fs::read_to_string(expected_path)
        .unwrap_or_else(|e| panic!("cannot read pinned hash {expected_path}: {e}"));
    let expected = expected.trim();
    let actual = sha256_hex(&bytes);
    if actual != expected {
        panic!(
            "\nvendored {wasm_path} does not match its pinned hash.\n  expected: {expected}\n  actual:   {actual}\n\
             This means the checked-in wasm is stale or was replaced without updating the pin.\n\
             Rebuild market-core (or reasoning-registry) and re-copy the wasm, then update\n\
             {expected_path} in the same commit. See docs/adr/0002-cross-contract-calls.md.\n"
        );
    }
}

fn sha256_hex(input: &[u8]) -> String {
    let digest = sha256(input);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
    }
    out
}

/// Minimal SHA-256 (FIPS 180-4). Kept inline so pinning needs no new crate.
fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut message = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// Convenience for a `build.rs` that only needs to verify one artifact.
#[allow(dead_code)]
pub fn verify(wasm: &str, expected: &str) {
    let _ = Path::new(wasm);
    verify_wasm_hash(wasm, expected);
}
