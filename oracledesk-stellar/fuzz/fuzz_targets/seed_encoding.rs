//! Byte encoders shared by `gen_corpus.rs` and documented in the target
//! files. This module is never compiled into a fuzz target; `gen_corpus.rs`
//! includes it with `#[path]`.

pub fn push_u8(out: &mut Vec<u8>, v: u8) {
    out.push(v);
}

pub fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn push_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// `<u64, u64, u64, u16, u8>` for the buy/sell/inverse math targets.
pub fn math_seed(a: u64, b: u64, c: u64, fee: u16, scale: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(27);
    push_u64(&mut out, a);
    push_u64(&mut out, b);
    push_u64(&mut out, c);
    push_u16(&mut out, fee);
    push_u8(&mut out, scale);
    out
}

/// `<u64, u16, u8>` for `fuzz_seed_reserves`.
pub fn seed_seed(seed: u64, p: u16, scale: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(11);
    push_u64(&mut out, seed);
    push_u16(&mut out, p);
    push_u8(&mut out, scale);
    out
}

/// `<u64, u64, u64, u8>` for `fuzz_mul_div`.
pub fn mul_div_seed(a: u64, b: u64, c: u64, scale: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(25);
    push_u64(&mut out, a);
    push_u64(&mut out, b);
    push_u64(&mut out, c);
    push_u8(&mut out, scale);
    out
}

const CREATE: u8 = 0;
const BUY: u8 = 1;
const SELL: u8 = 2;
const ADVANCE: u8 = 3;
const RESOLVE: u8 = 4;
const VOID: u8 = 5;
const REDEEM: u8 = 6;
const CLAIM: u8 = 7;
const SWEEP: u8 = 8;

fn op_create(out: &mut Vec<u8>, seed: u64, p: u16, close_in: u32) {
    push_u8(out, CREATE);
    push_u64(out, seed);
    push_u16(out, p);
    push_u32(out, close_in);
}

fn op_buy(out: &mut Vec<u8>, who: u8, market: u8, yes: bool, amount: u64) {
    push_u8(out, BUY);
    push_u8(out, who);
    push_u8(out, market);
    push_u8(out, u8::from(yes));
    push_u64(out, amount);
}

fn op_sell(out: &mut Vec<u8>, who: u8, market: u8, yes: bool, amount: u64) {
    push_u8(out, SELL);
    push_u8(out, who);
    push_u8(out, market);
    push_u8(out, u8::from(yes));
    push_u64(out, amount);
}

fn op_advance(out: &mut Vec<u8>, secs: u32) {
    push_u8(out, ADVANCE);
    push_u32(out, secs);
}

fn op_resolve(out: &mut Vec<u8>, market: u8, yes: bool) {
    push_u8(out, RESOLVE);
    push_u8(out, market);
    push_u8(out, u8::from(yes));
}

fn op_void(out: &mut Vec<u8>, market: u8) {
    push_u8(out, VOID);
    push_u8(out, market);
}

fn op_redeem(out: &mut Vec<u8>, who: u8, market: u8) {
    push_u8(out, REDEEM);
    push_u8(out, who);
    push_u8(out, market);
}

fn op_claim(out: &mut Vec<u8>, market: u8) {
    push_u8(out, CLAIM);
    push_u8(out, market);
}

fn op_sweep(out: &mut Vec<u8>, market: u8) {
    push_u8(out, SWEEP);
    push_u8(out, market);
}

pub fn sequence_seed() -> Vec<(&'static str, Vec<u8>)> {
    let unit = 10_000_000u64;
    let mut out = Vec::new();

    let mut data = vec![3u8];
    op_buy(&mut data, 1, 0, true, 100 * unit);
    op_sell(&mut data, 1, 0, true, 50 * unit);
    op_redeem(&mut data, 1, 0);
    out.push(("buy_sell_redeem", data));

    let mut data = vec![3u8];
    op_advance(&mut data, 20_000);
    op_resolve(&mut data, 0, true);
    op_redeem(&mut data, 0, 0);
    out.push(("resolve_redeem", data));

    let mut data = vec![4u8];
    op_advance(&mut data, 20_000);
    op_void(&mut data, 0);
    op_claim(&mut data, 0);
    op_redeem(&mut data, 0, 0);
    out.push(("void_claim_redeem", data));

    let mut data = vec![4u8];
    op_create(&mut data, 100 * unit, 100, 1);
    op_buy(&mut data, 2, 1, false, unit);
    op_sweep(&mut data, 1);
    op_advance(&mut data, 1_000);
    out.push(("create_boundary", data));

    out
}

// ----- resolver targets (#278) ----------------------------------------------

const SIG_SUBMIT: u8 = 0;
const SIG_CANCEL: u8 = 1;
const SIG_ADVANCE: u8 = 2;
const SIG_FINALIZE: u8 = 3;
const E_VALID: u8 = 0;
const E_DUP: u8 = 6;

/// `fuzz_resolver_signatures` header: keys `(index, weight)` and threshold.
fn sig_header(out: &mut Vec<u8>, keys: &[(u8, u8)], threshold: u16, n_ops: u8) {
    push_u8(out, (keys.len() as u8 - 1) % 8);
    for (k, w) in keys {
        push_u8(out, *k);
        push_u8(out, *w);
    }
    push_u16(out, threshold);
    push_u8(out, n_ops);
}

fn sig_submit(out: &mut Vec<u8>, yes: bool, round_delta: i8, entries: &[(u8, u8)]) {
    push_u8(out, SIG_SUBMIT);
    push_u8(out, if yes { 0 } else { 1 });
    push_u8(out, round_delta as u8);
    push_u8(out, entries.len() as u8);
    for (tag, k) in entries {
        push_u8(out, *tag);
        push_u8(out, *k);
    }
}

pub fn resolver_sig_seed() -> Vec<(&'static str, Vec<u8>)> {
    // Mirrors the resolver test `weighted_fixture`: keys 1, 2, 3 (pool
    // indices 0, 1, 2) with weights 2/1/1 and threshold 3.
    let fixture = [(0u8, 2u8), (1, 1), (2, 1)];
    let mut out = Vec::new();

    let mut d = Vec::new();
    sig_header(&mut d, &fixture, 3, 3);
    sig_submit(&mut d, false, 0, &[(E_VALID, 0), (E_VALID, 1)]);
    push_u8(&mut d, SIG_ADVANCE);
    push_u16(&mut d, 100);
    push_u8(&mut d, SIG_FINALIZE);
    out.push(("weighted_fixture_finalize", d));

    // weighted_duplicate_sig_ignored: the same key twice counts once.
    let mut d = Vec::new();
    sig_header(&mut d, &fixture, 3, 1);
    sig_submit(&mut d, true, 0, &[(E_DUP, 1), (E_VALID, 1)]);
    out.push(("weighted_duplicate_sig_ignored", d));

    // submit_signatures_guards: 33 signatures, then a stale round.
    let mut d = Vec::new();
    sig_header(&mut d, &fixture, 3, 2);
    let many: Vec<(u8, u8)> = (0..33).map(|_| (E_VALID, 0)).collect();
    sig_submit(&mut d, true, 0, &many);
    sig_submit(&mut d, true, 1, &[(E_VALID, 0)]);
    out.push(("submit_signatures_guards", d));

    // Cancel, then re-sign in the new round; old-round sigs are stale.
    let mut d = Vec::new();
    sig_header(&mut d, &fixture, 3, 4);
    sig_submit(&mut d, true, 0, &[(E_VALID, 0), (E_VALID, 1)]);
    push_u8(&mut d, SIG_CANCEL);
    sig_submit(&mut d, true, -1, &[(E_VALID, 0)]);
    sig_submit(&mut d, false, 0, &[(E_VALID, 0), (E_VALID, 2)]);
    out.push(("cancel_then_resign", d));

    // A forged signature from an unseen member traps the whole batch.
    let mut d = Vec::new();
    sig_header(&mut d, &fixture, 3, 1);
    sig_submit(&mut d, true, 0, &[(E_VALID, 1), (4, 0)]);
    out.push(("forged_member_traps", d));
    out
}

/// `fuzz_resolver_committee`: members mask, threshold, bounds, ops.
pub fn resolver_committee_seed() -> Vec<(&'static str, Vec<u8>)> {
    let mut out = Vec::new();
    // Three members, threshold 2: two attest Yes, window passes, finalize.
    let mut d = vec![0b0000_0111, 2, 1, 1, 4];
    d.extend_from_slice(&[0, 0, 0, 0, 1, 0]); // Attest m0 Yes, m1 Yes
    d.push(4);
    push_u16(&mut d, 2); // Advance 128 s
    d.push(5); // Finalize
    out.push(("committee_quorum_finalize", d));

    // Rotation past max_rotation_delta = 0: attestations then fail with
    // RotationBoundExceeded.
    let mut d = vec![0b0000_0011, 1, 1, 0, 4];
    d.extend_from_slice(&[1, 0b0000_1100, 1]); // ProposeRotation {m2, m3}, 1
    d.push(4);
    push_u16(&mut d, 1_400); // Advance 89_600 s > MIN_ROTATION_DELAY
    d.push(2); // ExecuteRotation
    d.extend_from_slice(&[0, 2, 0]); // Attest m2 Yes
    out.push(("rotation_past_bound", d));
    out
}

/// `fuzz_resolver_spec_decode`: mode byte, then the mode's payload.
pub fn resolver_spec_seed() -> Vec<(&'static str, Vec<u8>)> {
    let mut out = Vec::new();
    // Raw: empty and a truncated XDR header.
    out.push(("raw_empty", vec![0]));
    out.push(("raw_vec_header", vec![0, 0, 0, 0, 0x10, 0, 0, 0, 1]));
    // Structured: a valid V2 signer rule (two distinct signers, k=2).
    out.push(("v2_signers_valid", vec![1, 0b0000_0001, 0, 1, 2, 1, 2, 0, 1, 0, 0]));
    // The duplicate-signer gap: [A, A] with threshold 2 is accepted.
    out.push(("v2_signers_duplicate", vec![1, 0b0000_0001, 0, 1, 2, 1, 2, 3, 3, 0, 0]));
    // Precedence: zero salt + wrong network -> InvalidConfig first.
    out.push(("v2_zero_salt_wrong_network", vec![1, 0b0000_0111, 0, 0, 0, 1, 0, 0, 9, 1]));
    // Wrong commitment -> SpecHashMismatch; and a valid price rule twice.
    out.push(("v2_hash_mismatch", vec![1, 0b0001_0001, 0, 0, 0, 1, 0, 0, 9, 1]));
    out.push(("v2_price_twice", vec![1, 0b0010_0001, 0, 0, 0, 1, 0, 0, 9, 1]));
    out
}
