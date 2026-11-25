//! Pure integer math for a binary fixed-product market maker (FPMM).
//!
//! No Soroban types in here, so `cargo test` exercises it natively and
//! `model/fpmm_model.py` mirrors it line by line for property testing.
//!
//! Conventions
//! - All amounts are non-negative `i128` in collateral base units
//!   (USDC on Stellar = 7 decimals, so 1 USDC = 10_000_000).
//! - Rounding always favours the pool: fees round up, shares out round down,
//!   shares in round up. This is what keeps the pool invariant `k = r_yes * r_no`
//!   non-decreasing and blocks dust-splitting attacks.
//! - See `docs/fpmm-economics.md` for the proofs of the rounding, LP-loss and
//!   no-arbitrage claims made here (checked by `model/fpmm_bounds.py`).
//! - `MAX_SETS` bounds market size so that any product of two quantities
//!   (both <= 1e15) is <= 1e30, far below `i128::MAX` (~1.7e38). Every
//!   multiplication is still `checked_*` as a second line of defence.
//!
//! Headroom for `calc_sell_shares`: with b = shares_in + r_sold + r_other
//! and every term <= MAX_SETS = 1e15, b <= 3e15 and b^2 <= 9e30. The
//! discriminant D = b^2 - 4*r_other*shares_in fits in u128 (max ~3.4e38).
//! The 256-bit widening issue must revisit this bound if MAX_SETS grows.

pub const BPS: i128 = 10_000;
pub const MAX_SETS: i128 = 1_000_000_000_000_000_000; // 1e15 = 100M USDC (7 dp)
pub const MIN_PROB_BPS: u32 = 100; // 1%
pub const MAX_PROB_BPS: u32 = 9_900; // 99%
/// Longest dynamic-fee ramp: 30 days. Caps how far before close an admin
/// can start the time component.
pub const MAX_RAMP_SECS: u64 = 30 * 86_400;
/// Largest skew multiplier: 1_000 means the skew term grows 1 bp per
/// 1_000 bps (10 points) of price distance from 50%, up to 5x the
/// multiplier at the extreme prices.
pub const MAX_SKEW_MULT_BPS: u32 = 1_000;

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
    /// Scalar market: LONG pays `floor(yes * p / BPS)`, SHORT pays
    /// `floor(no * (BPS - p) / BPS)`, `p` in bps in `0..=BPS`.
    /// `Scalar(BPS)` is equivalent to `Yes`, `Scalar(0)` to `No`.
    Scalar(u32),
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

#[cfg(test)]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SellSharesQuote {
    pub collateral_out: i128,
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

fn mul(a: i128, b: i128) -> Result<i128, MathError> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

/// floor(a * b / c)
pub fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(mul(a, b)? / c)
}

/// ceil(a * b / c), written to avoid overflowing on `p + c - 1`.
pub fn mul_div_ceil(a: i128, b: i128, c: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(MathError::InvalidInput);
    }
    let p = mul(a, b)?;
    let q = p / c;
    Ok(if p % c != 0 { q + 1 } else { q })
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

/// Pure mirror of the contract's `FeeSchedule` (see `lib.rs`), phrased with
/// plain numbers so `model/fpmm_model.py` and `agents/core/fpmm.ts` can
/// reproduce `effective_fee_bps` bit-for-bit. Field order mirrors the XDR.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct FeeScheduleM {
    pub base_bps: u32,
    pub max_bps: u32,
    pub ramp_secs: u64,
    pub skew_mult_bps: u32,
}

/// The fee rate a trade pays under `s` at time `now` with the pool at
/// `(r_yes, r_no)`: `min(max, base + t + skew)` where
///
/// - `t` ramps linearly from 0 to `max - base` over the last `ramp_secs`
///   before `close` (0 when `ramp_secs == 0` or the window has not opened;
///   `max - base` once `now >= close`), and
/// - `skew = |p - 5_000| * skew_mult_bps / 1_000` with `p` the floored
///   pre-trade YES price — so a balanced pool pays `base` and a one-sided
///   pool pays up to `base + 5 * skew_mult_bps`.
///
/// Both floors round **down**, i.e. towards the trader: unlike the pool
/// math (`calc_buy`/`calc_sell` always round for the pool) the fee only
/// needs to be deterministic across the contract, the Python model and the
/// TS mirror, and a sub-bp gift to the trader cannot break the invariant.
/// The pre-trade price keeps the fee independent of the trade being priced
/// (a post-trade price would be circular with `calc_buy`).
///
/// Guarantees `base <= result <= max` for every schedule with
/// `base <= max < BPS`; any other schedule is rejected. `now >= close`
/// (possible in quotes) clamps to the ramp end. All arithmetic is `i128`,
/// so no input pair can overflow.
pub fn effective_fee_bps(
    s: &FeeScheduleM,
    now: u64,
    close: u64,
    r_yes: i128,
    r_no: i128,
) -> Result<u32, MathError> {
    if s.base_bps > s.max_bps || s.max_bps as i128 >= BPS {
        return Err(MathError::InvalidInput);
    }
    let base = s.base_bps as i128;
    let max = s.max_bps as i128;
    let delta = max - base;
    let t = if s.ramp_secs == 0 {
        0
    } else {
        let ramp = s.ramp_secs as i128;
        let into_ramp = if now >= close {
            ramp
        } else {
            s.ramp_secs.saturating_sub(close - now) as i128
        };
        mul_div_floor(into_ramp, delta, ramp)?
    };
    let p = price_yes_bps(r_yes, r_no)?;
    let d = (p - 5_000).abs();
    let skew = mul_div_floor(d, s.skew_mult_bps as i128, 1_000)?;
    let total = base
        .checked_add(t)
        .and_then(|v| v.checked_add(skew))
        .ok_or(MathError::Overflow)?;
    Ok(if total > max {
        max as u32
    } else {
        total as u32
    })
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
    let shares_out = r_bought.checked_add(net).ok_or(MathError::Overflow)? - new_bought;
    if shares_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(BuyQuote {
        shares_out,
        fee,
        net,
        new_reserve_bought: new_bought,
        new_reserve_other: new_other,
    })
}

/// Sell shares of the outcome with pool reserve `r_sold` for an exact
/// `collateral_out` (Gnosis-style, so no square root on-chain).
///
/// 1. gross = ceil(out * BPS / (BPS - fee_bps)); fee = gross - out
/// 2. burn `gross` complete sets from the pool: r_other -= gross
/// 3. pool must end at r_sold' = ceil(r_sold * r_other / r_other')
/// 4. seller gives r_sold' + gross - r_sold shares
///
/// To sell an exact share count, prefer the on-chain `sell_shares` entrypoint
/// (see `calc_sell_shares`). This function remains for backward compatibility.
pub fn calc_sell(
    r_sold: i128,
    r_other: i128,
    collateral_out: i128,
    fee_bps: u32,
) -> Result<SellQuote, MathError> {
    if collateral_out <= 0 || r_sold <= 0 || r_other <= 0 || (fee_bps as i128) >= BPS {
        return Err(MathError::InvalidInput);
    }
    let gross = mul_div_ceil(collateral_out, BPS, BPS - fee_bps as i128)?;
    let fee = gross - collateral_out;
    if gross >= r_other {
        return Err(MathError::InsufficientLiquidity);
    }
    let new_other = r_other - gross;
    let new_sold = mul_div_ceil(r_sold, r_other, new_other)?;
    let shares_in = new_sold.checked_add(gross).ok_or(MathError::Overflow)? - r_sold;
    if shares_in <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(SellQuote {
        shares_in,
        fee,
        gross,
        new_reserve_sold: new_sold,
        new_reserve_other: new_other,
    })
}

/// Integer square root of a `u128`, floored, exact for every input
/// (`isqrt(n)^2 <= n < (isqrt(n)+1)^2`). Newton iteration seeded from a
/// bit-length upper bound, so it converges monotonically down to the floor.
/// Seeding at or below the root would let Newton converge from below and
/// return floor+1, which would break the pool-favouring correction in
/// `calc_sell_shares`.
#[cfg(test)]
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // shift = ceil(bit_len(n) / 2), so 1 << shift >= sqrt(n).
    let shift = (128 - n.leading_zeros()).div_ceil(2);
    let mut x = 1u128 << shift;
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Sell an exact `shares_in` count of the outcome whose pool reserve is
/// `r_sold`, returning the collateral the seller receives. This is the
/// on-chain inverse of `calc_sell`: it solves for the gross sets burned
/// such that the constant-product invariant is preserved after the seller gives
/// `shares_in` shares and the pool removes `gross` complete sets.
///
/// Derivation: we want `x` (gross) such that
///   (r_sold + shares_in - x) * (r_other - x) = r_sold * r_other
/// Expanding gives the quadratic x^2 - b*x + r_other*shares_in = 0 with
/// b = r_sold + shares_in + r_other. The smaller root is
///   x0 = (b - sqrt(b*b - 4*r_other*shares_in)) / 2
///
/// Pool-favouring rounding: isqrt rounds down, so x0 can overshoot the
/// real root by at most one. We decrement x while the invariant would drop,
/// guaranteeing new_sold * new_other >= r_sold * r_other. This loop runs
/// at most twice: the real root is in [x0-1, x0], and the invariant is
/// monotone in x on [0, min(shares_in, r_other)), so at most one step
/// from x0 reaches the greatest x satisfying the invariant.
///
/// Because the pool removes at least the gross that `calc_sell` would
/// charge for the same `shares_in`, the seller never receives more
/// collateral than the curve allows.
#[cfg(test)]
pub fn calc_sell_shares(
    r_sold: i128,
    r_other: i128,
    shares_in: i128,
    fee_bps: u32,
) -> Result<SellSharesQuote, MathError> {
    if shares_in <= 0 || r_sold <= 0 || r_other <= 0 || (fee_bps as i128) >= BPS {
        return Err(MathError::InvalidInput);
    }
    // b = r_sold + shares_in + r_other, all terms <= MAX_SETS, so b <= 3e15.
    let b = r_sold
        .checked_add(shares_in.checked_add(r_other).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?;
    // D = b^2 - 4*r_other*shares_in. b^2 <= 9e30 and 4*r_other*shares_in <= 4e30,
    // both well within u128 (max ~3.4e38).
    let b2 = (b as u128)
        .checked_mul(b as u128)
        .ok_or(MathError::Overflow)?;
    let four_r_shares = (r_other as u128)
        .checked_mul(shares_in as u128)
        .ok_or(MathError::Overflow)?
        .checked_mul(4)
        .ok_or(MathError::Overflow)?;
    let d = b2.checked_sub(four_r_shares).ok_or(MathError::Overflow)?;
    let sqrt_d = isqrt(d);
    let mut x = ((b as u128) - sqrt_d) / 2;
    // Pool-favouring correction: decrement while the invariant would drop.
    // The products are at most 1e30 and fit in i128.
    while x > 0 {
        let new_sold = r_sold.checked_add(shares_in).ok_or(MathError::Overflow)? - x as i128;
        let new_other = r_other - x as i128;
        let left = new_sold.checked_mul(new_other).ok_or(MathError::Overflow)?;
        let right = r_sold.checked_mul(r_other).ok_or(MathError::Overflow)?;
        if left >= right {
            break;
        }
        x -= 1;
    }
    if x == 0 || x >= (r_other as u128) {
        return Err(MathError::InsufficientLiquidity);
    }
    let x = x as i128;
    // Fee rounds up, as in calc_buy.
    let collateral_out = mul_div_floor(x, BPS - fee_bps as i128, BPS)?;
    let fee = x - collateral_out;
    if collateral_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    let new_sold = r_sold.checked_add(shares_in).ok_or(MathError::Overflow)? - x;
    let new_other = r_other - x;
    Ok(SellSharesQuote {
        collateral_out,
        fee,
        gross: x,
        new_reserve_sold: new_sold,
        new_reserve_other: new_other,
    })
}

/// True when a buy's average execution price `collateral_in / shares_out`
/// (fees included) is at most `limit_bps` per share (1.0 = BPS).
/// Compared by cross-multiplication so division rounding cannot flip the
/// decision; exact equality passes. `shares_out` comes from `calc_buy`, so
/// it is always > 0 in practice.
pub fn buy_within_limit(
    collateral_in: i128,
    shares_out: i128,
    limit_bps: u32,
) -> Result<bool, MathError> {
    if collateral_in < 0 || shares_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(mul(collateral_in, BPS)? <= mul(shares_out, limit_bps as i128)?)
}

/// True when a sell's average execution price `collateral_out / shares_in`
/// is at least `limit_bps` per share. Exact equality passes; a zero limit is
/// trivially satisfied (`collateral_out >= 0`), which buys the caller no
/// protection — see `sell_v2`'s docs.
pub fn sell_within_limit(
    collateral_out: i128,
    shares_in: i128,
    limit_bps: u32,
) -> Result<bool, MathError> {
    if collateral_out < 0 || shares_in <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(mul(collateral_out, BPS)? >= mul(shares_in, limit_bps as i128)?)
}

/// Splits a gross fee between the protocol and the LP.
///
/// The protocol portion rounds **up** so `protocol + lp == fee` exactly (no
/// rounding leakage): the LP absorbs at most one sub-unit of dust, and the
/// default `protocol_share_bps = BPS` is exact (all protocol, 0 to the LP).
pub fn split_fee(fee: i128, protocol_share_bps: u32) -> Result<(i128, i128), MathError> {
    if fee < 0 || protocol_share_bps as i128 > BPS {
        return Err(MathError::InvalidInput);
    }
    let protocol = mul_div_ceil(fee, protocol_share_bps as i128, BPS)?;
    Ok((protocol, fee - protocol))
}

/// Collateral value of a (yes, no) share pair once a market is final.
/// Void pays 0.5 per share, floored per call, which keeps total payouts
/// <= sets minted (see `settle_upper` and the settlement Kani harnesses).
///
/// The Void sum is `checked_add`: with `overflow-checks = true` in the
/// release profile an unchecked `yes + no` would trap instead of returning
/// an error. Every in-domain input (`0 <= yes, no <= MAX_SETS`) is `Ok`.
pub fn settle_value(kind: Settlement, yes: i128, no: i128) -> Result<i128, MathError> {
    match kind {
        Settlement::Yes => Ok(yes),
        Settlement::No => Ok(no),
        Settlement::Void => Ok(half_toward_zero(
            yes.checked_add(no).ok_or(MathError::Overflow)?,
        )),
        Settlement::Scalar(p) => scalar_payout(p, yes, no),
    }
}

/// Collateral value of a (yes, no) share pair in a scalar market whose
/// resolved value maps to `payout_long_bps` LONG per complete set. Both legs
/// floor independently, so no holder ever receives more than their exact
/// rational share, and since `Σyes == Σno == sets_minted` across holders and
/// the pool the total paid out never exceeds `sets_minted`.
///
/// `payout_long_bps` must be `<= BPS`; the market layer validates that in
/// `resolve_scalar` before any payout can be settled.
pub fn scalar_payout(payout_long_bps: u32, yes: i128, no: i128) -> Result<i128, MathError> {
    let p = payout_long_bps as i128;
    if p > BPS {
        return Err(MathError::InvalidInput);
    }
    let long = mul(yes, p)? / BPS;
    let short = mul(no, BPS - p)? / BPS;
    long.checked_add(short).ok_or(MathError::Overflow)
}

/// `x / 2` (Rust's round-toward-zero division), written as shifts. Same
/// result for every `i128` (`void_half_matches_division` pins it); it exists
/// because a model checker bit-blasts a full 128-bit divider for `/ 2`,
/// which made the settlement Kani harnesses intractable.
fn half_toward_zero(x: i128) -> i128 {
    // For negative x, add 1 before the (flooring) arithmetic shift.
    (x + ((x >> 127) & 1)) >> 1
}

/// Maximum complete sets a holder can merge: `min(yes, no)`.
///
/// Pure helper so frontends and agents can offer "merge all" without
/// duplicating the clip logic. Negative inputs are clipped to zero so the
/// result is always non-negative and safe to pass to `merge`.
#[cfg(test)]
pub fn merge_max(yes: i128, no: i128) -> i128 {
    let y = if yes < 0 { 0 } else { yes };
    let n = if no < 0 { 0 } else { no };
    if y < n {
        y
    } else {
        n
    }
}

/// Upper bound on the total collateral `settle_value` will pay out for a
/// set of per-holder (yes, no) claims. Exact for `Yes`/`No`; for `Void`
/// each individual claim floors its own half, so the sum of what holders
/// can still redeem is at most the floor of the summed halves:
/// `floor(a/2) + floor(b/2) <= floor((a + b)/2)` for all `a, b >= 0`
/// (the floors give back at most 1 unit and `a + b` is integral, so the
/// per-holder rounding never lets redemptions exceed this bound).
/// `finalize_market` reserves exactly this much for outstanding claims;
/// anything the rounding then leaves unclaimed is swept, never stranded.
///
/// The arithmetic is the same as `settle_value`; the two names exist because
/// they answer different questions (one holder's payout vs. a reserve for
/// many holders). The over-reservation is at most `floor(H / 2)` units for
/// `H` holders, proved by `proof_settle_upper_over_reserve_bound`.
pub fn settle_upper(kind: Settlement, yes: i128, no: i128) -> Result<i128, MathError> {
    settle_value(kind, yes, no)
}

// ---------------------------------------------------------------------------
// Settlement ledger (issue #276)
//
// Everything `redeem`, `claim_pool_remainder`, `redeem_many`,
// `claim_pool_remainders` and `finalize_market` compute about collateral is
// done here, on plain integers, so the Kani harnesses in `math_proofs.rs`
// prove the code the contract actually runs. `lib.rs` only loads the
// `Market` / `SettleState` / `LpFees` entries into a `SettleLedger`, calls
// one of these functions, and writes the result back (plus auth, events and
// the token transfer).
// ---------------------------------------------------------------------------

/// Settlement view of one market.
///
/// Conservation is tracked in two separate legs:
///
/// - **Share/pool collateral** (`paid_out`): every complete set is backed by
///   one unit of collateral, so `paid_out + reserved <= sets_minted` must
///   hold for the market to stay solvent.
/// - **LP fees** (`lp_fees`, `fees_paid`): the LP share of trade fees sits in
///   `DataKey::LpFees(id)`, *outside* `sets_minted` (`buy` adds only
///   `q.net` to `sets_minted`). Counting fees paid by `apply_pool_claim` in
///   `paid_out` would subtract them from `sets_minted` once and then again
///   implicitly (they never entered it), which is the bug that made
///   `finalize_market` fail after an LP claimed a remainder with fees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleLedger {
    /// Complete sets ever minted for the market (`Market::sets_minted`).
    pub sets_minted: i128,
    /// Shares held outside the pool and not yet redeemed.
    pub outstanding_yes: i128,
    pub outstanding_no: i128,
    /// Pool reserves; zeroed by `apply_pool_claim`.
    pub reserve_yes: i128,
    pub reserve_no: i128,
    /// Collateral paid for shares and the pool remainder only. LP fees are
    /// never added here (see `fees_paid`).
    pub paid_out: i128,
    /// LP fees paid out by `apply_pool_claim`. Not stored on-chain; it lives
    /// only for the duration of one call so the proofs can show each fee
    /// unit leaves exactly once.
    pub fees_paid: i128,
    /// Unclaimed LP fees (`DataKey::LpFees(id)`), outside `sets_minted`.
    pub lp_fees: i128,
    pub lp_claimed: bool,
    /// `false` for legacy markets created before `SettleState` existed.
    /// Their payouts are computed exactly as for tracked markets, but
    /// `outstanding_*` and `paid_out` are left untouched (there is nothing
    /// to write them back to) and `finalize_residual` refuses them.
    pub tracked: bool,
}

/// One holder's redemption: pays `settle_value(kind, yes, no)`, decrements
/// **both** outstanding sides by the full position (a losing-side position
/// still clears, mirroring `redeem`), and adds the payout to `paid_out`.
///
/// Negative positions are rejected; `lib.rs` never stores one.
pub fn apply_redeem(
    l: &mut SettleLedger,
    kind: Settlement,
    yes: i128,
    no: i128,
) -> Result<i128, MathError> {
    if yes < 0 || no < 0 {
        return Err(MathError::InvalidInput);
    }
    let payout = settle_value(kind, yes, no)?;
    if l.tracked {
        let outstanding_yes = l
            .outstanding_yes
            .checked_sub(yes)
            .ok_or(MathError::Overflow)?;
        let outstanding_no = l
            .outstanding_no
            .checked_sub(no)
            .ok_or(MathError::Overflow)?;
        let paid_out = l.paid_out.checked_add(payout).ok_or(MathError::Overflow)?;
        l.outstanding_yes = outstanding_yes;
        l.outstanding_no = outstanding_no;
        l.paid_out = paid_out;
    }
    Ok(payout)
}

/// The LP's pool claim: pays `settle_value(kind, reserve_yes, reserve_no)`
/// plus the unclaimed LP fees, zeroes the reserves and the fee balance and
/// marks the pool claimed. Only the pool value is added to `paid_out`; the
/// fee part goes to `fees_paid`.
///
/// Returns `InvalidInput` if the pool was already claimed (`lib.rs` maps
/// that case to `AlreadyClaimed` before calling).
pub fn apply_pool_claim(l: &mut SettleLedger, kind: Settlement) -> Result<i128, MathError> {
    if l.lp_claimed || l.lp_fees < 0 {
        return Err(MathError::InvalidInput);
    }
    let pool_value = settle_value(kind, l.reserve_yes, l.reserve_no)?;
    let fees = l.lp_fees;
    let payout = pool_value.checked_add(fees).ok_or(MathError::Overflow)?;
    let fees_paid = l.fees_paid.checked_add(fees).ok_or(MathError::Overflow)?;
    if l.tracked {
        l.paid_out = l
            .paid_out
            .checked_add(pool_value)
            .ok_or(MathError::Overflow)?;
    }
    l.fees_paid = fees_paid;
    l.lp_fees = 0;
    l.reserve_yes = 0;
    l.reserve_no = 0;
    l.lp_claimed = true;
    Ok(payout)
}

/// One step of `redeem_many`'s fold: applies the redemption to that
/// market's ledger and adds the payout to the batch total. The batch fold
/// is proved equal to the same redemptions done one at a time
/// (`proof_batch_equals_sequential`).
pub fn batch_redeem_step(
    total: i128,
    l: &mut SettleLedger,
    kind: Settlement,
    yes: i128,
    no: i128,
) -> Result<i128, MathError> {
    let mut next = *l;
    let payout = apply_redeem(&mut next, kind, yes, no)?;
    let total = total.checked_add(payout).ok_or(MathError::Overflow)?;
    *l = next;
    Ok(total)
}

/// What `finalize_market` reserves and sweeps, as
/// `(unclaimed_user, lp_claim, dust)`:
///
/// - `unclaimed_user = settle_upper(kind, outstanding_yes, outstanding_no)`
/// - `lp_claim` = the unclaimed pool value (0 once claimed)
/// - `dust = sets_minted - paid_out - unclaimed_user - lp_claim`
///
/// `dust` is proved non-negative on every reachable ledger, exactly 0 for
/// Yes/No and at most `(H + 1) / 2` for Void with `H` redeeming legs. A
/// negative value can only come from a broken invariant, so it is an error
/// (`Overflow`, as before) rather than a silent under-sweep. Untracked
/// (legacy) ledgers have no outstanding counts and are rejected.
pub fn finalize_residual(
    l: &SettleLedger,
    kind: Settlement,
) -> Result<(i128, i128, i128), MathError> {
    if !l.tracked {
        return Err(MathError::InvalidInput);
    }
    let unclaimed_user = settle_upper(kind, l.outstanding_yes, l.outstanding_no)?;
    let lp_claim = if l.lp_claimed {
        0
    } else {
        settle_value(kind, l.reserve_yes, l.reserve_no)?
    };
    let dust = l
        .sets_minted
        .checked_sub(l.paid_out)
        .and_then(|v| v.checked_sub(unclaimed_user))
        .and_then(|v| v.checked_sub(lp_claim))
        .ok_or(MathError::Overflow)?;
    if dust < 0 {
        return Err(MathError::Overflow);
    }
    Ok((unclaimed_user, lp_claim, dust))
}

/// Total `finalize_market` transfers to the treasury: the share/pool
/// residual (`dust + unclaimed_user + lp_claim`) plus the two fee legs that
/// live outside `sets_minted` (`fees_accrued` and the unclaimed LP fees).
/// Fee legs are added exactly once here and never subtracted from the
/// share residual (`proof_settlement_fee_legs_counted_once`).
pub fn finalize_sweep(
    l: &SettleLedger,
    residual: (i128, i128, i128),
    fees_accrued: i128,
) -> Result<i128, MathError> {
    let (unclaimed_user, lp_claim, dust) = residual;
    dust.checked_add(unclaimed_user)
        .and_then(|v| v.checked_add(lp_claim))
        .and_then(|v| v.checked_add(fees_accrued))
        .and_then(|v| v.checked_add(l.lp_fees))
        .ok_or(MathError::Overflow)
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    #[test]
    fn merge_max_clips_negative_inputs_to_zero() {
        assert_eq!(merge_max(5, 3), 3);
        assert_eq!(merge_max(3, 5), 3);
        assert_eq!(merge_max(-4, 3), 0);
        assert_eq!(merge_max(3, -4), 0);
    }

    fn isqrt_exact(n: u128) {
        let x = isqrt(n);
        assert!(
            x.checked_mul(x).unwrap() <= n,
            "isqrt lower bound failed for {}",
            n
        );
        if let Some(next) = x.checked_add(1) {
            if let Some(sq) = next.checked_mul(next) {
                assert!(n < sq, "isqrt upper bound failed for {}", n);
            }
        }
    }

    #[test]
    fn isqrt_exact_for_boundaries() {
        for n in 0u128..=128 {
            isqrt_exact(n);
        }
        for root in [10u128, 100u128, 1_000_000u128] {
            isqrt_exact(root * root);
            isqrt_exact(root * root - 1);
            isqrt_exact(root * root + 1);
        }
        // (3e15)^2 = 9e30, the largest product we allow.
        let max = 3_000_000_000_000_000u128;
        isqrt_exact(max * max);
        isqrt_exact(max * max - 1);
        isqrt_exact(max * max + 1);
        isqrt_exact(u128::MAX);
        isqrt_exact(u128::MAX - 1);
    }

    #[test]
    fn sell_shares_example_matches_model() {
        // 1000/1000 pool, sell 212 shares, no fee.
        let q = calc_sell_shares(1000, 1000, 212, 0).unwrap();
        assert_eq!(q.gross, 100);
        assert_eq!(q.collateral_out, 100);
        assert_eq!(q.fee, 0);
        assert_eq!(q.new_reserve_sold, 1112);
        assert_eq!(q.new_reserve_other, 900);
    }

    // Linear congruential generator for reproducible property tests.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(144269);
            self.0
        }
        fn range(&mut self, lo: i128, hi: i128) -> i128 {
            lo + (self.next() as i128) % (hi - lo + 1)
        }
    }

    #[test]
    fn sell_shares_k_never_decreases() {
        let mut rng = Lcg(0xdeadbeef);
        for _ in 0..2000 {
            let r_sold = rng.range(1, 1_000_000);
            let r_other = rng.range(1, 1_000_000);
            let shares_in = rng.range(1, r_sold);
            let fee_bps = rng.range(0, 1000) as u32;
            if let Ok(q) = calc_sell_shares(r_sold, r_other, shares_in, fee_bps) {
                let left = q.new_reserve_sold * q.new_reserve_other;
                let right = r_sold * r_other;
                assert!(left >= right, "k decreased");
            }
        }
    }

    #[test]
    fn sell_shares_never_pays_more_than_calc_sell() {
        let mut rng = Lcg(0xcafe_babe_1234);
        for _ in 0..2000 {
            let r_sold = rng.range(1, 1_000_000);
            let r_other = rng.range(1, 1_000_000);
            let shares_in = rng.range(1, r_sold);
            let fee_bps = rng.range(0, 1000) as u32;
            if let Ok(q) = calc_sell_shares(r_sold, r_other, shares_in, fee_bps) {
                if let Ok(back) = calc_sell(r_sold, r_other, q.collateral_out, fee_bps) {
                    assert!(
                        back.shares_in <= shares_in,
                        "calc_sell charged less than shares_in"
                    );
                }
            }
        }
    }

    #[test]
    fn sell_shares_at_max_sets_no_overflow() {
        let q = calc_sell_shares(MAX_SETS, MAX_SETS, MAX_SETS / 2, 500).unwrap();
        assert!(q.collateral_out > 0);
        assert!(q.new_reserve_sold > 0);
        assert!(q.new_reserve_other > 0);
    }

    #[test]
    fn sell_shares_rejects_zero_collateral() {
        // A sell too small to burn even one complete set must revert: the
        // pool-favouring correction drives the gross to 0.
        assert_eq!(
            calc_sell_shares(1_000_000, 1_000_000, 1, 0),
            Err(MathError::InsufficientLiquidity),
        );
        // One set burned, but the fee floors the seller's collateral to 0.
        let q = calc_sell_shares(1_000, 1_000, 3, 0).unwrap();
        assert_eq!(q.gross, 1);
        assert_eq!(
            calc_sell_shares(1_000, 1_000, 3, 500),
            Err(MathError::InvalidInput),
        );
    }

    #[test]
    fn buy_example_matches_model() {
        // 1000/1000 pool, buy 100 with no fee -> 190 shares, reserves 910/1100
        let q = calc_buy(1000, 1000, 100, 0).unwrap();
        assert_eq!(q.shares_out, 190);
        assert_eq!(q.new_reserve_bought, 910);
        assert_eq!(q.new_reserve_other, 1100);
    }

    #[test]
    fn sell_example_matches_model() {
        let q = calc_sell(1000, 1000, 100, 0).unwrap();
        assert_eq!(q.shares_in, 212);
        assert_eq!(q.gross, 100);
        assert_eq!(q.new_reserve_sold, 1112);
        assert_eq!(q.new_reserve_other, 900);
    }

    #[test]
    fn seed_opens_at_requested_probability() {
        for p in [100u32, 2500, 5000, 7300, 9900] {
            let s = seed_reserves(10_000_000_000, p).unwrap();
            let price = price_yes_bps(s.reserve_yes, s.reserve_no).unwrap();
            assert!((price - p as i128).abs() <= 1, "p={p} price={price}");
            assert!(s.creator_yes == 0 || s.creator_no == 0);
        }
    }

    #[test]
    fn k_never_decreases_and_round_trip_never_profits() {
        // tiny LCG so this stays no_std-friendly
        let mut x: u64 = 0x09E3_779B_97FA_7C15;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let ry = 1_000_000 + next() % 1_000_000_000;
            let rn = 1_000_000 + next() % 1_000_000_000;
            let amt = 1 + next() % (ry.min(rn) / 2);
            let fee = (next() % 300) as u32;
            let k0 = ry * rn;
            let q = calc_buy(ry, rn, amt, fee).unwrap();
            assert!(q.new_reserve_bought * q.new_reserve_other >= k0);
            // getting `amt` back out costs at least the shares the buy paid out
            if let Ok(s) = calc_sell(q.new_reserve_bought, q.new_reserve_other, amt, fee) {
                assert!(s.shares_in >= q.shares_out, "free money");
            }
        }
    }

    #[test]
    fn void_never_overpays() {
        assert_eq!(settle_value(Settlement::Void, 3, 4), Ok(3));
        assert!(settle_value(Settlement::Void, 5, 5).unwrap() <= 5);
    }

    #[test]
    fn settle_value_checked_at_i128_edge() {
        // Out of domain, but must be an error rather than a trap.
        assert_eq!(
            settle_value(Settlement::Void, i128::MAX, 1),
            Err(MathError::Overflow)
        );
        assert_eq!(
            settle_value(Settlement::Void, MAX_SETS, MAX_SETS),
            Ok(MAX_SETS)
        );
    }

    #[test]
    fn void_half_matches_division() {
        for x in [
            0i128,
            1,
            2,
            3,
            -1,
            -2,
            -3,
            MAX_SETS,
            MAX_SETS + 1,
            -MAX_SETS - 1,
            i128::MAX,
            i128::MAX - 1,
            i128::MIN,
            i128::MIN + 1,
        ] {
            assert_eq!(half_toward_zero(x), x / 2, "x={x}");
        }
    }

    #[test]
    fn scalar_extremes_match_binary() {
        for (yes, no) in [(0i128, 7i128), (3, 4), (1_000_000, 250_000)] {
            assert_eq!(
                settle_value(Settlement::Scalar(BPS as u32), yes, no),
                settle_value(Settlement::Yes, yes, no)
            );
            assert_eq!(
                settle_value(Settlement::Scalar(0), yes, no),
                settle_value(Settlement::No, yes, no)
            );
        }
    }

    #[test]
    fn scalar_rounding_favours_pool() {
        let mut x: u64 = 0x0DDC_0FFE_E0DD_F00D;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let yes = next() % 1_000_000_000_000;
            let no = next() % 1_000_000_000_000;
            let p = (next() % (BPS + 1)) as u32;
            let paid = scalar_payout(p, yes, no).expect("in-domain inputs");
            // floor + floor never exceeds the exact rational amount
            assert!(paid * BPS <= yes * p as i128 + no * (BPS - p as i128));
        }
    }

    #[test]
    fn scalar_payout_never_exceeds_sets() {
        let mut x: u64 = 0x5EED_5EED_5EED_5EED;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let sets = 1 + next() % 1_000_000_000_000;
            let p = (next() % (BPS + 1)) as u32;
            // three holders split `sets` complete sets independently per leg
            let (mut rest_y, mut rest_n) = (sets, sets);
            let mut total: i128 = 0;
            for h in 0..3 {
                let take_y = if h == 2 {
                    rest_y
                } else {
                    next() % (rest_y + 1)
                };
                let take_n = if h == 2 {
                    rest_n
                } else {
                    next() % (rest_n + 1)
                };
                rest_y -= take_y;
                rest_n -= take_n;
                total += scalar_payout(p, take_y, take_n).expect("in-domain inputs");
            }
            assert!(total <= sets, "scalar overpaid: {total} > {sets} at p={p}");
        }
    }

    #[test]
    fn settle_upper_exact_for_yes_no() {
        assert_eq!(settle_upper(Settlement::Yes, 7, 3), Ok(7));
        assert_eq!(settle_upper(Settlement::No, 7, 3), Ok(3));
    }

    fn ledger(sets: i128, ry: i128, rn: i128, lp_fees: i128) -> SettleLedger {
        SettleLedger {
            sets_minted: sets,
            outstanding_yes: sets - ry,
            outstanding_no: sets - rn,
            reserve_yes: ry,
            reserve_no: rn,
            paid_out: 0,
            fees_paid: 0,
            lp_fees,
            lp_claimed: false,
            tracked: true,
        }
    }

    /// The arithmetic `redeem` in `lib.rs` performed before the pure layer
    /// existed, kept verbatim as a reference.
    fn lib_redeem_reference(
        kind: Settlement,
        outstanding: (i128, i128),
        paid_out: i128,
        yes: i128,
        no: i128,
    ) -> (i128, (i128, i128), i128) {
        let payout = match kind {
            Settlement::Yes => yes,
            Settlement::No => no,
            Settlement::Void => (yes + no) / 2,
            Settlement::Scalar(p) => scalar_payout(p, yes, no).expect("in-domain inputs"),
        };
        (
            payout,
            (outstanding.0 - yes, outstanding.1 - no),
            paid_out + payout,
        )
    }

    #[test]
    fn apply_redeem_matches_lib_redeem() {
        let mut x: u64 = 0x1234_5678_9abc_def0;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for kind in [Settlement::Yes, Settlement::No, Settlement::Void] {
            for _ in 0..500 {
                let sets = 1 + next() % 1_000_000_000;
                let ry = next() % (sets + 1);
                let rn = next() % (sets + 1);
                let mut l = ledger(sets, ry, rn, 0);
                l.paid_out = next() % 1_000;
                let yes = next() % (l.outstanding_yes + 1);
                let no = next() % (l.outstanding_no + 1);
                let (payout, (oy, on), paid) = lib_redeem_reference(
                    kind,
                    (l.outstanding_yes, l.outstanding_no),
                    l.paid_out,
                    yes,
                    no,
                );
                let got = apply_redeem(&mut l, kind, yes, no).unwrap();
                assert_eq!(got, payout);
                assert_eq!((l.outstanding_yes, l.outstanding_no), (oy, on));
                assert_eq!(l.paid_out, paid);
            }
        }
        // Legacy (untracked) markets pay the same amount and touch nothing.
        let mut l = ledger(100, 40, 60, 0);
        l.tracked = false;
        let before = l;
        assert_eq!(apply_redeem(&mut l, Settlement::Void, 7, 4), Ok(5));
        assert_eq!(l, before);
        // Negative positions are rejected without mutating the ledger.
        let mut l = ledger(100, 40, 60, 0);
        let before = l;
        assert_eq!(
            apply_redeem(&mut l, Settlement::Yes, -1, 0),
            Err(MathError::InvalidInput)
        );
        assert_eq!(l, before);
    }

    #[test]
    fn finalize_residual_zero_for_yes_no() {
        for kind in [Settlement::Yes, Settlement::No] {
            // sets 1000, pool 400/700, holders A (350, 100) and B (250, 200).
            let mut l = ledger(1_000, 400, 700, 0);
            assert_eq!(l.outstanding_yes, 600);
            assert_eq!(l.outstanding_no, 300);
            assert_eq!(finalize_residual(&l, kind).unwrap().2, 0);
            apply_redeem(&mut l, kind, 350, 100).unwrap();
            assert_eq!(finalize_residual(&l, kind).unwrap().2, 0);
            apply_pool_claim(&mut l, kind).unwrap();
            assert_eq!(finalize_residual(&l, kind).unwrap().2, 0);
            apply_redeem(&mut l, kind, 250, 200).unwrap();
            assert_eq!(finalize_residual(&l, kind).unwrap(), (0, 0, 0));
            assert_eq!(l.paid_out, l.sets_minted);
        }
    }

    #[test]
    fn finalize_residual_after_lp_fee_claim() {
        // Regression: the LP claims a remainder that includes LP fees before
        // the deadline. Fees live outside `sets_minted`, so counting them in
        // `paid_out` drove the residual to `-lp_fees`.
        for kind in [Settlement::Yes, Settlement::No, Settlement::Void] {
            let mut l = ledger(1_000, 400, 700, 37);
            let payout = apply_pool_claim(&mut l, kind).unwrap();
            let pool_value = settle_value(kind, 400, 700).unwrap();
            assert_eq!(payout, pool_value + 37);
            assert_eq!(l.paid_out, pool_value, "fees must not enter paid_out");
            assert_eq!(l.fees_paid, 37);
            assert_eq!(l.lp_fees, 0);
            let residual = finalize_residual(&l, kind).unwrap();
            assert!(residual.2 >= 0);
            // The sweep is exactly the market's remaining collateral.
            let fees_accrued = 11;
            let swept = finalize_sweep(&l, residual, fees_accrued).unwrap();
            assert_eq!(swept, 1_000 + 37 + fees_accrued - l.paid_out - l.fees_paid);
        }
        // A second claim is refused and leaves the ledger untouched.
        let mut l = ledger(10, 5, 5, 1);
        apply_pool_claim(&mut l, Settlement::Yes).unwrap();
        let before = l;
        assert_eq!(
            apply_pool_claim(&mut l, Settlement::Yes),
            Err(MathError::InvalidInput)
        );
        assert_eq!(l, before);
    }

    #[test]
    fn finalize_residual_rejects_negative_and_untracked() {
        let mut l = ledger(100, 50, 50, 0);
        l.paid_out = 101;
        assert_eq!(
            finalize_residual(&l, Settlement::Yes),
            Err(MathError::Overflow)
        );
        let mut l = ledger(100, 50, 50, 0);
        l.tracked = false;
        assert_eq!(
            finalize_residual(&l, Settlement::Yes),
            Err(MathError::InvalidInput)
        );
    }

    #[test]
    fn batch_fold_equals_sequential() {
        let legs = [
            (Settlement::Yes, 30, 5),
            (Settlement::Void, 7, 4),
            (Settlement::No, 9, 21),
        ];
        let base = [
            ledger(100, 40, 60, 0),
            ledger(50, 20, 20, 3),
            ledger(80, 10, 45, 0),
        ];
        let mut batch = base;
        let mut total = 0;
        for (l, (kind, yes, no)) in batch.iter_mut().zip(legs) {
            total = batch_redeem_step(total, l, kind, yes, no).unwrap();
        }
        let mut seq_total = 0;
        for (i, (kind, yes, no)) in legs.into_iter().enumerate() {
            let mut fresh = base[i];
            seq_total += apply_redeem(&mut fresh, kind, yes, no).unwrap();
            assert_eq!(fresh, batch[i]);
        }
        assert_eq!(total, seq_total);
        assert_eq!(total, 30 + 5 + 21);
    }

    #[test]
    fn void_sum_of_floors_le_floor_of_sum() {
        // The per-holder floor in `settle_value` must never add up to more
        // than the single floor over the summed claims, or finalize would
        // reserve less than holders can redeem.
        let mut x: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let a = next() % 1_000_000_000;
            let b = next() % 1_000_000_000;
            let summed = settle_upper(Settlement::Void, a, b).unwrap();
            let part = settle_value(Settlement::Void, a, 0).unwrap()
                + settle_value(Settlement::Void, 0, b).unwrap();
            assert!(part <= summed, "a={a} b={b} part={part} summed={summed}");
        }
        // Boundary shapes around odd sums.
        let v = |y, n| settle_value(Settlement::Void, y, n).unwrap();
        assert!(v(1, 0) + v(0, 1) <= 1);
        assert!(v(1, 1) + v(0, 1) <= 1);
    }

    #[test]
    fn split_fee_sums_exactly() {
        let (fee, share) = (101, 3300);
        let (proto, lp) = split_fee(fee, share).unwrap();
        assert_eq!(proto + lp, fee);
        assert_eq!(split_fee(fee, BPS as u32).unwrap(), (fee, 0));
    }

    #[test]
    fn split_fee_default_is_all_protocol() {
        assert_eq!(split_fee(12_345, 10_000).unwrap(), (12_345, 0));
        assert_eq!(split_fee(12_345, 0).unwrap(), (0, 12_345));
        assert_eq!(split_fee(0, 3_333).unwrap(), (0, 0));
    }

    #[test]
    fn buy_within_limit_boundaries() {
        // avg price exactly 1.0: passing costs the full limit, passes
        assert!(buy_within_limit(100, 100, 10_000).unwrap());
        // cheaper than the limit
        assert!(buy_within_limit(100, 101, 10_000).unwrap());
        // one unit above the limit fails
        assert!(!buy_within_limit(101, 100, 10_000).unwrap());
        // 100 in -> 200 shares = 0.5 per share, exactly at 5_000 bps
        assert!(buy_within_limit(100, 200, 5_000).unwrap());
        assert!(!buy_within_limit(101, 200, 5_000).unwrap());
    }

    #[test]
    fn sell_within_limit_boundaries() {
        assert!(sell_within_limit(100, 100, 10_000).unwrap());
        assert!(!sell_within_limit(99, 100, 10_000).unwrap());
        // 100 out from 200 shares = 0.5 per share, exactly at 5_000 bps
        assert!(sell_within_limit(100, 200, 5_000).unwrap());
        assert!(!sell_within_limit(100, 201, 5_000).unwrap());
        // a zero limit is trivially satisfied
        assert!(sell_within_limit(0, 1, 0).unwrap());
    }

    #[test]
    fn price_after_maps_both_sides() {
        assert_eq!(price_after(true, 1_000, 1_000).unwrap(), 5_000);
        assert_eq!(price_after(false, 1_000, 1_000).unwrap(), 5_000);
        // NO buy pushing NO reserve to 910 with 1100 YES: YES price is
        // 1100 / (1100 + 910), i.e. price_yes_bps(yes, no)
        assert_eq!(
            price_after(false, 910, 1_100).unwrap(),
            price_yes_bps(1_100, 910).unwrap()
        );
    }

    fn sched(base_bps: u32, max_bps: u32, ramp_secs: u64, skew_mult_bps: u32) -> FeeScheduleM {
        FeeScheduleM {
            base_bps,
            max_bps,
            ramp_secs,
            skew_mult_bps,
        }
    }

    #[test]
    fn effective_fee_within_bounds() {
        let mut x: u64 = 0xFEE1_0BEE_FEE1_0BEE;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            x >> 33
        };
        for _ in 0..2_000 {
            let base = (next() % 1_001) as u32;
            let max = base + (next() % (1_001 - base as u64)) as u32;
            let s = sched(
                base,
                max,
                next() % (MAX_RAMP_SECS + 1),
                (next() % (MAX_SKEW_MULT_BPS as u64 + 1)) as u32,
            );
            let close = 1_000_000 + next() % 1_000_000_000;
            let now = next();
            let r_yes = 1 + (next() % 1_000_000_000_000) as i128;
            let r_no = 1 + (next() % 1_000_000_000_000) as i128;
            let fee = effective_fee_bps(&s, now, close, r_yes, r_no).unwrap();
            assert!(fee >= base, "fee {fee} < base {base}");
            assert!(fee <= max, "fee {fee} > max {max}");
            assert!(max <= 1_000);
        }
    }

    #[test]
    fn effective_fee_ramp_monotonic_in_time() {
        let s = sched(100, 800, 10_000, 250);
        let (close, r_yes, r_no) = (500_000u64, 1_000i128, 3_000i128);
        let mut prev = 0u32;
        let mut t = close - 20_000;
        while t <= close + 5_000 {
            let fee = effective_fee_bps(&s, t, close, r_yes, r_no).unwrap();
            assert!(fee >= prev, "fee fell from {prev} to {fee} at t={t}");
            prev = fee;
            t += 137;
        }
        assert_eq!(prev, 800, "past close the fee clamps to max");
    }

    #[test]
    fn effective_fee_symmetric_in_skew() {
        let s = sched(200, 1_000, 0, 100);
        // exactly representable ratios: p and 10_000 - p both hold, so the
        // floored distance d is identical on either side and the fee must
        // be exactly equal
        for (a, b) in [
            (1_000i128, 3_000i128),
            (900, 1_100),
            (5_000, 5_000),
            (1, 4),
            (7, 3),
            (1, 1),
        ] {
            assert_eq!(
                effective_fee_bps(&s, 0, 1, a, b).unwrap(),
                effective_fee_bps(&s, 0, 1, b, a).unwrap(),
                "asymmetric at {a}/{b}"
            );
        }
        // inexact ratios can shift the floored price distance by 1, which
        // the floored scaling bounds by one bp while skew_mult <= 1_000
        let mut x: u64 = 0x5CE1_5CE1_5CE1_5CE1;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            x >> 33
        };
        for _ in 0..2_000 {
            let a = 1 + (next() % 1_000_000_000_000) as i128;
            let b = 1 + (next() % 1_000_000_000_000) as i128;
            let f1 = effective_fee_bps(&s, 0, 1, a, b).unwrap();
            let f2 = effective_fee_bps(&s, 0, 1, b, a).unwrap();
            assert!((f1 as i64 - f2 as i64).abs() <= 1, "{a}/{b}: {f1} vs {f2}");
        }
    }

    #[test]
    fn effective_fee_zero_ramp() {
        let s = sched(120, 900, 0, 300);
        let far = effective_fee_bps(&s, 0, u64::MAX, 1_000, 1_000).unwrap();
        let at_close = effective_fee_bps(&s, 5_000_000, 5_000_000, 1_000, 1_000).unwrap();
        let past = effective_fee_bps(&s, 6_000_000, 5_000_000, 1_000, 1_000).unwrap();
        assert_eq!(far, 120);
        assert_eq!(far, at_close);
        assert_eq!(far, past);
    }

    #[test]
    fn effective_fee_rejects_unbounded_schedule() {
        assert_eq!(
            effective_fee_bps(&sched(500, 400, 0, 0), 0, 1, 1, 1),
            Err(MathError::InvalidInput)
        );
        // max must stay strictly below BPS (calc_sell requires fee < BPS)
        assert_eq!(
            effective_fee_bps(&sched(0, 10_000, 0, 0), 0, 1, 1, 1),
            Err(MathError::InvalidInput)
        );
    }

    #[test]
    fn effective_fee_matches_fixtures() {
        // Shared cross-language table (also read by model/fpmm_model.py and
        // agents/core/fpmm.ts): one row per fixture, nine numbers —
        // [base_bps, max_bps, ramp_secs, skew_mult_bps,
        //  now, close, r_yes, r_no, expected_fee_bps]
        let raw = include_str!("../../../model/fee_fixtures.json");
        let mut nums = [0i128; 512];
        let mut n = 0usize;
        let mut cur: Option<i128> = None;
        for b in raw.bytes() {
            if b.is_ascii_digit() {
                let d = (b - b'0') as i128;
                cur = Some(cur.map_or(d, |v| v * 10 + d));
            } else if let Some(v) = cur.take() {
                assert!(n < 512, "fee_fixtures.json holds too many numbers");
                nums[n] = v;
                n += 1;
            }
        }
        if let Some(v) = cur.take() {
            assert!(n < 512, "fee_fixtures.json holds too many numbers");
            nums[n] = v;
            n += 1;
        }
        assert!(
            n > 0 && n.is_multiple_of(9),
            "expected 9 numbers per row, got {n}"
        );
        for row in nums[..n].chunks(9) {
            let s = sched(row[0] as u32, row[1] as u32, row[2] as u64, row[3] as u32);
            let fee = effective_fee_bps(&s, row[4] as u64, row[5] as u64, row[6], row[7]).unwrap();
            assert_eq!(fee, row[8] as u32, "fixture {row:?}");
        }
    }
}
