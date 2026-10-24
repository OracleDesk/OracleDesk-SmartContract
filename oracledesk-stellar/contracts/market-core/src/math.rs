//! Pure integer math for a binary fixed-product market maker (FPMM).
//!
//! No Soroban types in here, so `cargo test` exercises it natively and
//! `model/fpmm_model.py` mirrors it line by line for property testing.
//!
//! Conventions
//! - All amounts are non-negative `i128` in collateral base units.
//!   The number of decimals is not fixed: deployers pass any SEP-41
//!   token with decimals in `0..=18`. Economic bounds (`min_seed`,
//!   `max_sets`) are derived from the collateral's decimals via
//!   `bounds_for_decimals`. At 18 decimals the product of two
//!   quantities can reach ~1e52, well beyond `i128`, so the
//!   multiply-divide helpers use 256-bit intermediates (`wide` module).
//!   A quotient that fits in `i128` is always returned exactly.
//! - Rounding always favours the pool: fees round up, shares out round down,
//!   shares in round up. This is what keeps the pool invariant `k = r_yes * r_no`
//!   non-decreasing and blocks dust-splitting attacks.
//! - Additions that could in principle overflow are `checked_add`. At the
//!   largest supported decimals (18), `max_sets = 1e26` and sums of two
//!   such reserves stay far below `i128::MAX`.
//! - See `docs/fpmm-economics.md` for the proofs of the rounding, LP-loss and
//!   no-arbitrage claims made here (checked by `model/fpmm_bounds.py`).

pub const BPS: i128 = 10_000;
/// Deprecated: the 7-decimal cap formerly used by contract logic. Kept only
/// so old tests and mirrors compile; real bounds come from `bounds_for_decimals`.
#[deprecated]
pub const MAX_SETS: i128 = 1_000_000_000_000_000; // 1e15 = 100M USDC at 7 dp
pub const MIN_PROB_BPS: u32 = 100; // 1%
pub const MAX_PROB_BPS: u32 = 9_900; // 99%

/// Maximum supported collateral decimals.
pub const MAX_DECIMALS: u32 = 18;

/// Economic bounds derived from the collateral's decimals.
/// - `min_seed` = 100 tokens (100 * 10^d)
/// - `max_sets` = 100M tokens (1e8 * 10^d)
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Bounds {
    pub min_seed: i128,
    pub max_sets: i128,
}

/// Derive the economic bounds for a collateral with `d` decimals.
/// Returns `MathError::InvalidInput` for `d > MAX_DECIMALS`.
pub fn bounds_for_decimals(d: u32) -> Result<Bounds, MathError> {
    if d > MAX_DECIMALS {
        return Err(MathError::InvalidInput);
    }
    let unit = 10i128.checked_pow(d).ok_or(MathError::Overflow)?;
    let min_seed = 100i128.checked_mul(unit).ok_or(MathError::Overflow)?;
    let max_sets = 100_000_000i128
        .checked_mul(unit)
        .ok_or(MathError::Overflow)?;
    Ok(Bounds {
        min_seed,
        max_sets,
    })
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MathError {
    Overflow,
    InvalidInput,
    InsufficientLiquidity,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Settlement {
    Yes,
    No,
    Void,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct BuyQuote {
    pub shares_out: i128,
    pub fee: i128,
    /// Collateral that actually mints complete sets (`collateral_in - fee`).
    pub net: i128,
    pub new_reserve_bought: i128,
    pub new_reserve_other: i128,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SellQuote {
    pub shares_in: i128,
    pub fee: i128,
    /// Complete sets burned from the pool (`collateral_out + fee`).
    pub gross: i128,
    pub new_reserve_sold: i128,
    pub new_reserve_other: i128,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SeedReserves {
    pub reserve_yes: i128,
    pub reserve_no: i128,
    /// Outcome shares handed back to the market creator so the pool opens at
    /// the requested probability (only one of these is non-zero).
    pub creator_yes: i128,
    pub creator_no: i128,
}

/// 256-bit intermediate arithmetic. Env-free and no-std so it can be
/// tested natively and mirrored by the Python / TS models.
///
/// The only operations the contract needs are `mul` of two `u128`s and
/// `divrem` in which the divisor fits in `u128` and the quotient is checked
/// to fit in `u128`. The division is a shift-subtract loop over the
/// bits of the dividend. It is simple to verify and compares favourably
/// with full Knuth D in wasm instructions for the sizes we see here.
pub mod wide {
    use super::MathError;

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct U256 {
        pub hi: u128,
        pub lo: u128,
    }

    /// Schoolbook widening multiply on 64-bit limbs.
    /// `a * b = (a.hi * 2^64 + a.lo) * (b.hi * 2^64 + b.lo)`
    pub fn mul(a: u128, b: u128) -> U256 {
        const MASK: u128 = (1 << 64) - 1;
        let ahi = a >> 64;
        let alo = a & MASK;
        let bhi = b >> 64;
        let blo = b & MASK;

        // Each partial product of two 64-bit limbs fits in u128 exactly.
        let p_ll = alo * blo;
        let p_lh = alo * bhi;
        let p_hl = ahi * blo;
        let p_hh = ahi * bhi;

        // Column 1 (bits 64..128): low half of p_lh + p_hl + high half of p_ll.
        // Sum of three 64-bit-ish values fits in u128 (max ~3 * 2^64).
        let mid = (p_ll >> 64) + (p_lh & MASK) + (p_hl & MASK);
        let lo = (p_ll & MASK) | ((mid & MASK) << 64);
        // Column 2 (bits 128..): high halves of p_lh and p_hl, p_hh, and carry from mid.
        let hi = p_hh + (p_lh >> 64) + (p_hl >> 64) + (mid >> 64);
        U256 { hi, lo }
    }

    /// Divide a 256-bit number by a 128-bit divisor. Returns `(quotient,
    /// remainder)`. `InvalidInput` if `d == 0`, `Overflow` if the quotient
    /// does not fit in `u128`.
    pub fn divrem(n: U256, d: u128) -> Result<(u128, u128), MathError> {
        if d == 0 {
            return Err(MathError::InvalidInput);
        }
        // Quotient >= 2^128 whenever the high half is >= divisor.
        if n.hi >= d {
            return Err(MathError::Overflow);
        }
        // Here n.hi < d, so the quotient fits in u128. Shift-subtract long
        // division: the remainder stays < d at every step, tracked with a
        // separate carry bit for the bit shifted out of the top.
        let mut q: u128 = 0;
        let mut r: u128 = n.hi;
        let mut i = 128i32;
        while i > 0 {
            i -= 1;
            let bit = (n.lo >> i) & 1;
            // r = (r << 1) | bit, with the shifted-out bit tracked as carry.
            let carry = (r >> 127) & 1 == 1;
            r = (r << 1) | bit;
            // If carry is set the true value is 2^128 + r >= d, so subtract
            // (wrapping handles the 2^128 correctly).
            if carry || r >= d {
                r = r.wrapping_sub(d);
                q |= 1u128 << i;
            }
        }
        Ok((q, r))
    }
}

fn mul(a: i128, b: i128) -> Result<i128, MathError> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

/// floor(a * b / c) with a 256-bit intermediate.
pub fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(MathError::InvalidInput);
    }
    let (q, _) = wide::divrem(wide::mul(a as u128, b as u128), c as u128)?;
    i128::try_from(q).map_err(|_| MathError::Overflow)
}

/// ceil(a * b / c) with a 256-bit intermediate.
pub fn mul_div_ceil(a: i128, b: i128, c: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(MathError::InvalidInput);
    }
    let (q, r) = wide::divrem(wide::mul(a as u128, b as u128), c as u128)?;
    let rounded = if r != 0 {
        q.checked_add(1).ok_or(MathError::Overflow)?
    } else {
        q
    };
    i128::try_from(rounded).map_err(|_| MathError::Overflow)
}

/// Spot price of YES in bps: r_no / (r_yes + r_no).
pub fn price_yes_bps(reserve_yes: i128, reserve_no: i128) -> Result<i128, MathError> {
    let sum = reserve_yes
        .checked_add(reserve_no)
        .ok_or(MathError::Overflow)?;
    if sum <= 0 {
        return Err(MathError::InsufficientLiquidity);
    }
    mul_div_floor(reserve_no, BPS, sum)
}

/// YES price in bps of the pool **after** applying an outcome-relative
/// reserve update (the `new_reserve_*` pair of a `BuyQuote`/`SellQuote`).
/// Follows `reserves_for`'s convention: pass `outcome_is_yes = false` for a
/// NO trade, where `r_after` is the NO reserve.
pub fn price_after(
    outcome_is_yes: bool,
    r_after: i128,
    r_other_after: i128,
) -> Result<i128, MathError> {
    if outcome_is_yes {
        price_yes_bps(r_after, r_other_after)
    } else {
        price_yes_bps(r_other_after, r_after)
    }
}

/// Pool opens at `yes_bps` probability with `seed` complete sets minted.
/// The pool keeps fewer of the *likelier* outcome; the creator keeps the rest.
pub fn seed_reserves(seed: i128, yes_bps: u32) -> Result<SeedReserves, MathError> {
    if seed <= 0 || !(MIN_PROB_BPS..=MAX_PROB_BPS).contains(&yes_bps) {
        return Err(MathError::InvalidInput);
    }
    let p = yes_bps as i128;
    let (reserve_yes, reserve_no) = if p >= BPS / 2 {
        (mul_div_floor(seed, BPS - p, p)?, seed)
    } else {
        (seed, mul_div_floor(seed, p, BPS - p)?)
    };
    if reserve_yes <= 0 || reserve_no <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(SeedReserves {
        reserve_yes,
        reserve_no,
        creator_yes: seed - reserve_yes,
        creator_no: seed - reserve_no,
    })
}

/// Buy `collateral_in` worth of the outcome whose pool reserve is `r_bought`.
///
/// 1. fee = ceil(in * fee_bps / BPS); net = in - fee
/// 2. mint `net` complete sets into the pool: r_other += net
/// 3. pool keeps r_bought' = ceil(r_bought * r_other / r_other')  (k preserved)
/// 4. buyer receives r_bought + net - r_bought'
pub fn calc_buy(
    r_bought: i128,
    r_other: i128,
    collateral_in: i128,
    fee_bps: u32,
) -> Result<BuyQuote, MathError> {
    if collateral_in <= 0 || r_bought <= 0 || r_other <= 0 {
        return Err(MathError::InvalidInput);
    }
    let fee = mul_div_ceil(collateral_in, fee_bps as i128, BPS)?;
    let net = collateral_in - fee;
    if net <= 0 {
        return Err(MathError::InvalidInput);
    }
    let new_other = r_other.checked_add(net).ok_or(MathError::Overflow)?;
    let new_bought = mul_div_ceil(r_bought, r_other, new_other)?;
    let shares_out = r_bought.checked_add(net).ok_or(MathError::Overflow)?
