//! Pure integer math for a categorical N-outcome fixed-product market maker
//! (FPMM): the generalisation of `math.rs` from 2 outcomes to `n` in
//! `2..=MAX_MARKET_OUTCOMES`.
//!
//! No Soroban types in here (no `Env`, no `alloc`), so `cargo test` exercises
//! it natively and `model/fpmm_model.py` / `agents/core/fpmm.ts` mirror it
//! for property testing.
//!
//! Conventions
//! - Same units and pool-favouring rounding as `math.rs`: everything that can
//!   round rounds so the pool never loses.
//! - The binary invariant `k = r_yes * r_no` generalises to the product of
//!   all reserves, `k = r_0 * ... * r_{n-1}`. Buys and sells never decrease
//!   `k`, which is what guarantees no sequence of trades can drain the pool.
//! - Reserves arrive as a slice of length `n` and results are fixed-size
//!   arrays whose first `n` entries are meaningful, so nothing here needs a
//!   heap.
//! - Every multiplication is `checked_*`. A reachable but extreme pool state
//!   (n = 8 with reserves near `MAX_SETS`, drained almost to zero by a huge
//!   sell) can exceed `i128` in the iterative loops; such a trade fails with
//!   `Overflow` rather than wrapping.

use crate::math::{mul_div_ceil, mul_div_floor, MathError, BPS, MIN_PROB_BPS};

/// Maximum number of outcomes a categorical market can have. Bounds every
/// loop here, so a trade's cost is linear in the outcome count at most.
pub const MAX_MARKET_OUTCOMES: u32 = 8;
const MAX_N: usize = MAX_MARKET_OUTCOMES as usize;

/// Reciprocal scale for `prices_bps`: `rec_i = PRICE_SCALE / r_i`. Chosen so
/// `rec_i * n` and `BPS * rec_i` stay far inside `i128` for every reachable
/// reserve (`r_i <= MAX_SETS = 1e15`), keeping the reciprocals' relative
/// rounding below ~1e-9 for any realistic pool while prices stay exact at
/// the ratios that matter.
const PRICE_SCALE: i128 = 1_000_000_000_000_000_000; // 1e18

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct CatBuyQuote {
    pub shares_out: i128,
    pub fee: i128,
    /// Collateral that actually mints complete sets (`collateral_in - fee`).
    pub net: i128,
    /// Reserves after the trade; the first `n` entries are meaningful.
    pub new_reserves: [i128; MAX_N],
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct CatSellQuote {
    pub shares_in: i128,
    pub fee: i128,
    /// Complete sets burned from the pool (`collateral_out + fee`).
    pub gross: i128,
    /// Reserves after the trade; the first `n` entries are meaningful.
    pub new_reserves: [i128; MAX_N],
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct CatSeed {
    /// Reserves after seeding; the first `n` entries are meaningful.
    pub reserves: [i128; MAX_N],
    /// Outcome shares handed back to the creator (per outcome) so the pool
    /// opens at the requested probabilities. `reserves[i] + creator_shares[i]
    /// == seed` for every i, mirroring `SeedReserves` at n = 2.
    pub creator_shares: [i128; MAX_N],
}

fn check_reserves(reserves: &[i128]) -> Result<usize, MathError> {
    let n = reserves.len();
    if !(2..=MAX_N).contains(&n) {
        return Err(MathError::InvalidInput);
    }
    if reserves.iter().any(|r| *r <= 0) {
        return Err(MathError::InvalidInput);
    }
    Ok(n)
}

fn check_index(n: usize, outcome_index: u32) -> Result<usize, MathError> {
    let j = outcome_index as usize;
    if j >= n {
        return Err(MathError::InvalidInput);
    }
    Ok(j)
}

/// Buy `collateral_in` worth of outcome `outcome_index`.
///
/// 1. fee = ceil(in * fee_bps / BPS); net = in - fee
/// 2. mint `net` complete sets: r_i' = r_i + net for every i != j
/// 3. the pool keeps r_j' = r_j * Π_{i≠j} r_i / (r_i + net)      (k preserved)
/// 4. the buyer receives r_j + net - r_j'
///
/// Step 3 is evaluated incrementally: `acc = r_j`, then for each i != j,
/// `acc = ceil(acc * r_i / (r_i + net))`.
///
/// Rounding proof. Write E_k for the exact real product after k factors and
/// q = r_i / (r_i + net) < 1 for the next one. Ceil is never below its
/// argument and multiplying by q preserves `acc >= E`, so the computed
/// reserve never drops below the ideal E. For the upper side, if
/// `acc <= E + d` then
///   `ceil(acc * q) <= acc * q + 1 <= (E + d) * q + 1 = E' + d*q + 1`,
/// and `d * q < d` because q < 1 and d >= 0: the ceil adds back at most 1
/// while the accumulated deviation shrinks. Starting from `acc = r_j = E_0`
/// (d = 0), after the n-1 steps `E <= r_j' <= E + (n-1)`. The pool therefore
/// keeps between 0 and n-1 units more than exact — the buyer can lose the
/// rounding but never gain it.
pub fn calc_buy(
    reserves: &[i128],
    outcome_index: u32,
    collateral_in: i128,
    fee_bps: u32,
) -> Result<CatBuyQuote, MathError> {
    let n = check_reserves(reserves)?;
    let j = check_index(n, outcome_index)?;
    if collateral_in <= 0 {
        return Err(MathError::InvalidInput);
    }
    let fee = mul_div_ceil(collateral_in, fee_bps as i128, BPS)?;
    let net = collateral_in - fee;
    if net <= 0 {
        return Err(MathError::InvalidInput);
    }

    let mut new_reserves = [0i128; MAX_N];
    let mut acc = reserves[j];
    for i in 0..n {
        if i == j {
            continue;
        }
        let new_other = reserves[i].checked_add(net).ok_or(MathError::Overflow)?;
        new_reserves[i] = new_other;
        acc = mul_div_ceil(acc, reserves[i], new_other)?;
    }
    new_reserves[j] = acc;
    let shares_out = reserves[j].checked_add(net).ok_or(MathError::Overflow)? - acc;
    if shares_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(CatBuyQuote {
        shares_out,
        fee,
        net,
        new_reserves,
    })
}

/// Sell outcome `outcome_index` for an exact `collateral_out`
/// (Gnosis-style, so no square root on-chain).
///
/// 1. gross = ceil(out * BPS / (BPS - fee_bps)); fee = gross - out
/// 2. burn `gross` complete sets: r_i' = r_i - gross for every i != j
/// 3. the pool must end at r_j' = r_j * Π_{i≠j} r_i / (r_i - gross)
/// 4. the seller gives r_j' + gross - r_j shares
///
/// Step 3 uses the same ceil-iterated accumulation as `calc_buy` with factor
/// `r_i / (r_i - gross) > 1`, so by the same argument `r_j'` is between the
/// ideal value and ideal + (n-1): the seller pays a rounding margin, never
/// the pool. Every other reserve must exceed `gross`, so no reserve can
/// reach zero and the product stays positive.
pub fn calc_sell(
    reserves: &[i128],
    outcome_index: u32,
    collateral_out: i128,
    fee_bps: u32,
) -> Result<CatSellQuote, MathError> {
    let n = check_reserves(reserves)?;
    let j = check_index(n, outcome_index)?;
    if collateral_out <= 0 || (fee_bps as i128) >= BPS {
        return Err(MathError::InvalidInput);
    }
    let gross = mul_div_ceil(collateral_out, BPS, BPS - fee_bps as i128)?;
    let fee = gross - collateral_out;

    let mut new_reserves = [0i128; MAX_N];
    let mut acc = reserves[j];
    for i in 0..n {
        if i == j {
            continue;
        }
        if reserves[i] <= gross {
            return Err(MathError::InsufficientLiquidity);
        }
        let new_other = reserves[i] - gross;
        new_reserves[i] = new_other;
        acc = mul_div_ceil(acc, reserves[i], new_other)?;
    }
    new_reserves[j] = acc;
    let shares_in = acc.checked_add(gross).ok_or(MathError::Overflow)? - reserves[j];
    if shares_in <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(CatSellQuote {
        shares_in,
        fee,
        gross,
        new_reserves,
    })
}

/// Spot price of every outcome in bps. The categorical price relation
/// `p_j = (1/r_j) / Σ_i (1/r_i)` (the binary formula `r_no / (r_yes + r_no)`
/// generalised) is evaluated on integer reciprocals so no division chain can
/// overflow: `rec_i = PRICE_SCALE / r_i` (floor), then
/// `p_j = floor(BPS * rec_j / Σ rec)`.
///
/// Every floor discards a fraction, so each price is at most its exact value
/// and the n prices sum to at most BPS; each floor loses less than 1, so the
/// sum is at least `BPS - n`. Clients should treat the prices as display
/// fractions (they never enter trade math) and tolerate that slack.
pub fn prices_bps(reserves: &[i128]) -> Result<[u32; MAX_N], MathError> {
    let n = check_reserves(reserves)?;
    let mut recs = [0i128; MAX_N];
    let mut sum: i128 = 0;
    for i in 0..n {
        recs[i] = PRICE_SCALE / reserves[i];
        sum = sum.checked_add(recs[i]).ok_or(MathError::Overflow)?;
    }
    if sum <= 0 {
        return Err(MathError::InsufficientLiquidity);
    }
    let mut prices = [0u32; MAX_N];
    for i in 0..n {
        prices[i] = mul_div_floor(BPS, recs[i], sum)? as u32;
    }
    Ok(prices)
}

/// Pool opens at the requested probabilities with `seed` complete sets
/// minted. Each reserve is `seed * p_min / p_i` (floored), so reserve
/// *ratios* are `1/p_i` and the derived prices approximate `probs_bps`.
///
/// The creator keeps `seed - r_i` shares of every outcome — only the likelier
/// outcomes have any, exactly as `math::seed_reserves` does at n = 2 — so
/// `r_i + creator_shares_i == seed` and the per-outcome holder total stays
/// `sets_minted` from the first trade.
///
/// Validation: `2 <= n <= MAX_MARKET_OUTCOMES`, `seed > 0`, every probability
/// in `MIN_PROB_BPS..=BPS` (each individual check) and the probabilities
/// summing to exactly BPS.
pub fn seed_reserves(seed: i128, probs_bps: &[u32]) -> Result<CatSeed, MathError> {
    let n = probs_bps.len();
    if !(2..=MAX_N).contains(&n) || seed <= 0 {
        return Err(MathError::InvalidInput);
    }
    let mut sum: u32 = 0;
    let mut p_min = u32::MAX;
    for p in probs_bps {
        if *p < MIN_PROB_BPS {
            return Err(MathError::InvalidInput);
        }
        sum = sum.checked_add(*p).ok_or(MathError::Overflow)?;
        p_min = p_min.min(*p);
    }
    if sum != BPS as u32 {
        return Err(MathError::InvalidInput);
    }

    let mut reserves = [0i128; MAX_N];
    let mut creator_shares = [0i128; MAX_N];
    for (i, p) in probs_bps.iter().enumerate() {
        let r = mul_div_floor(seed, p_min as i128, *p as i128)?;
        if r <= 0 {
            return Err(MathError::InvalidInput);
        }
        reserves[i] = r;
        creator_shares[i] = seed - r;
    }
    Ok(CatSeed {
        reserves,
        creator_shares,
    })
}

/// Collateral value of one holder's per-outcome balances once final.
/// `Some(w)` pays the winning balance; `None` (void) pays
/// `floor(Σ balances / n)`, the N-way generalisation of the binary void's
/// `(yes + no) / 2`.
///
/// Every complete set is worth exactly 1 and every rounding is a floor, so
/// the total paid out across all holders never exceeds `sets_minted`.
pub fn settle_value(resolved: Option<u32>, balances: &[i128]) -> Result<i128, MathError> {
    let n = balances.len();
    if !(2..=MAX_N).contains(&n) {
        return Err(MathError::InvalidInput);
    }
    match resolved {
        Some(w) => {
            let j = check_index(n, w)?;
            Ok(balances[j])
        }
        None => {
            let mut sum: i128 = 0;
            for b in balances {
                if *b < 0 {
                    return Err(MathError::InvalidInput);
                }
                sum = sum.checked_add(*b).ok_or(MathError::Overflow)?;
            }
            Ok(sum / n as i128)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::calc_buy as binary_calc_buy;

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 33
        }
    }

    /// Π reserves, the categorical pool invariant. Test-sized reserves keep
    /// this inside i128 (production uses checked math instead).
    fn k(reserves: &[i128], n: usize) -> i128 {
        let mut acc: i128 = 1;
        for r in &reserves[..n] {
            acc = acc.checked_mul(*r).unwrap();
        }
        acc
    }

    #[test]
    fn cat_buy_and_sell_examples_match_model() {
        // 1000/1000/1000 pool, buy 100 of outcome 0 with no fee:
        // acc = ceil(1000*1000/1100) = 910; ceil(910*1000/1100) = 828
        // shares = 1000 + 100 - 828 = 272; reserves [828, 1100, 1100]
        let q = calc_buy(&[1_000, 1_000, 1_000], 0, 100, 0).unwrap();
        assert_eq!(q.shares_out, 272);
        assert_eq!(q.new_reserves[..3], [828, 1_100, 1_100]);

        // sell 100 out of the same pool:
        // 1000 -> ceil(1000*1000/900) = 1112 -> ceil(1112*1000/900) = 1236
        // shares = 1236 + 100 - 1000 = 336; reserves [1236, 900, 900]
        let s = calc_sell(&[1_000, 1_000, 1_000], 0, 100, 0).unwrap();
        assert_eq!(s.shares_in, 336);
        assert_eq!(s.new_reserves[..3], [1_236, 900, 900]);
    }

    #[test]
    fn cat_buy_k_never_decreases() {
        let mut rng = Lcg(0x9E37_79B9_7F4A_7C15);
        for _ in 0..2_000 {
            let n = 2 + (rng.next() % 7) as usize; // 2..=8
            let mut reserves = [0i128; MAX_N];
            for r in reserves.iter_mut().take(n) {
                *r = 100 + (rng.next() % 10_000) as i128;
            }
            let j = (rng.next() % n as u64) as u32;
            let amt = 100 + (rng.next() % 100) as i128;
            let fee = (rng.next() % 300) as u32;

            let k0 = k(&reserves, n);
            let q = calc_buy(&reserves[..n], j, amt, fee).unwrap();
            assert!(
                k(&q.new_reserves, n) >= k0,
                "buy decreased k: n={n} j={j} amt={amt} fee={fee}"
            );
            // the bought outcome's reserve can shrink; every other grows by net
            for (i, r) in reserves.iter().enumerate().take(n) {
                if i != j as usize {
                    assert_eq!(q.new_reserves[i], r + q.net);
                }
            }
        }
    }

    #[test]
    fn cat_round_trip_never_profits() {
        let mut rng = Lcg(0x0DDB_1A5E_5BAD_5EED);
        for _ in 0..2_000 {
            let n = 2 + (rng.next() % 7) as usize;
            let mut reserves = [0i128; MAX_N];
            for r in reserves.iter_mut().take(n) {
                *r = 1_000 + (rng.next() % 100_000) as i128;
            }
            let j = (rng.next() % n as u64) as u32;
            let amt = 100 + (rng.next() % 400) as i128;
            let fee = (rng.next() % 300) as u32;

            let buy = calc_buy(&reserves[..n], j, amt, fee).unwrap();
            // selling the same collateral back out must cost at least the
            // shares the buy paid (A -> B -> A is never a profit)
            if let Ok(sell) = calc_sell(&buy.new_reserves[..n], j, amt, fee) {
                assert!(
                    sell.shares_in >= buy.shares_out,
                    "free money: n={n} j={j} amt={amt} fee={fee} \
                     bought={} sold={}",
                    buy.shares_out,
                    sell.shares_in
                );
            }
        }
    }

    #[test]
    fn cat_prices_sum_within_n_of_bps() {
        let mut rng = Lcg(0xB1A5_E5B1_A5B1_A5B1);
        for _ in 0..2_000 {
            let n = 2 + (rng.next() % 7) as usize;
            let mut reserves = [0i128; MAX_N];
            for r in reserves.iter_mut().take(n) {
                *r = 1_000 + (rng.next() % 1_000_000_000_000) as i128;
            }
            let prices = prices_bps(&reserves[..n]).unwrap();
            let sum: u32 = prices[..n].iter().sum();
            assert!(sum <= BPS as u32, "prices sum above BPS: n={n} sum={sum}");
            assert!(
                sum + n as u32 >= BPS as u32,
                "prices sum below BPS - n: n={n} sum={sum}"
            );
        }
        // equal reserves -> equal prices, each exactly floor(BPS / n)
        let flat = [7_777i128; MAX_N];
        for n in 2..=MAX_N {
            let prices = prices_bps(&flat[..n]).unwrap();
            let sum: u32 = prices[..n].iter().sum();
            assert!(
                sum + n as u32 >= BPS as u32 && sum <= BPS as u32,
                "n={n} sum={sum}"
            );
            for p in &prices[..n] {
                assert_eq!(*p, (BPS as u32) / n as u32);
            }
        }
    }

    #[test]
    fn cat_n2_matches_binary_calc_buy_within_1() {
        let mut rng = Lcg(0x5EED_5EED_5EED_5EED);
        for _ in 0..2_000 {
            let r_bought = 1_000 + (rng.next() % 1_000_000_000) as i128;
            let r_other = 1_000 + (rng.next() % 1_000_000_000) as i128;
            let amt = 1 + (rng.next() % (r_bought.min(r_other) / 2) as u64) as i128;
            let fee = (rng.next() % 300) as u32;

            // a 2-outcome categorical pool IS the binary FPMM
            let bin = binary_calc_buy(r_bought, r_other, amt, fee).unwrap();
            let cat = calc_buy(&[r_bought, r_other], 0, amt, fee).unwrap();
            assert!(
                (cat.shares_out - bin.shares_out).abs() <= 1,
                "shares drift: cat={} bin={}",
                cat.shares_out,
                bin.shares_out
            );
            assert_eq!(cat.net, bin.net);
            assert_eq!(cat.fee, bin.fee);
            // outcome 0 is the "bought" side, outcome 1 the "other"
            assert_eq!(cat.new_reserves[0], bin.new_reserve_bought);
            assert_eq!(cat.new_reserves[1], bin.new_reserve_other);
        }
    }

    #[test]
    fn cat_void_never_overpays() {
        let mut rng = Lcg(0xDEAD_BEEF_DEAD_BEEF);
        for _ in 0..2_000 {
            let n = 2 + (rng.next() % 7) as usize;
            let sets: i128 = 1_000_000;
            // three holders share each outcome's `sets` shares with the pool;
            // generated column-major: held_t[outcome][holder]
            let mut held_t = [[0i128; 3]; MAX_N];
            for col in held_t.iter_mut().take(n) {
                let mut rest = sets;
                for (h, take) in col.iter_mut().enumerate() {
                    *take = if h == 2 {
                        rest
                    } else {
                        (rng.next() % (rest as u64 + 1)) as i128
                    };
                    rest -= *take;
                }
                assert!(rest >= 0);
            }
            let row_of = |held_t: &[[i128; 3]; MAX_N], h: usize| -> [i128; MAX_N] {
                let mut row = [0i128; MAX_N];
                for (i, col) in held_t.iter().enumerate().take(n) {
                    row[i] = col[h];
                }
                row
            };

            // resolved(w): total paid = Σ_h bal[h][w] <= sets
            let w = (rng.next() % n as u64) as u32;
            let mut void_total: i128 = 0;
            let mut resolved_total: i128 = 0;
            for h in 0..3 {
                let row = row_of(&held_t, h);
                void_total += settle_value(None, &row[..n]).unwrap();
                resolved_total += settle_value(Some(w), &row[..n]).unwrap();
            }
            assert!(void_total <= sets, "void overpaid: {void_total} > {sets}");
            assert!(resolved_total <= sets);
        }
    }

    #[test]
    fn cat_seed_matches_requested_probs() {
        let cases: [[u32; 8]; 4] = [
            [5000, 5000, 0, 0, 0, 0, 0, 0],
            [6800, 3200, 0, 0, 0, 0, 0, 0],
            [5000, 3000, 2000, 0, 0, 0, 0, 0],
            [9000, 500, 400, 100, 0, 0, 0, 0],
        ];
        let lens = [2usize, 2, 3, 4];
        for (probs, len) in cases.iter().zip(lens) {
            let s = seed_reserves(1_000_000_000, &probs[..len]).unwrap();
            let prices = prices_bps(&s.reserves[..len]).unwrap();
            for i in 0..len {
                let drift = (prices[i] as i32 - probs[i] as i32).abs();
                assert!(drift <= 2, "price drift {drift} bps at i={i}");
                // every outcome splits exactly one set: reserve + creator = seed
                assert_eq!(s.reserves[i] + s.creator_shares[i], 1_000_000_000);
            }
            // the least likely outcome is fully held by the pool
            let min_i = (0..len).min_by_key(|i| probs[*i]).unwrap();
            assert_eq!(s.creator_shares[min_i], 0);
        }
        // 8 equal outcomes: prices are exactly equal in total
        let flat = [1250u32; 8];
        let s = seed_reserves(1_000_000_000, &flat).unwrap();
        let prices = prices_bps(&s.reserves).unwrap();
        let sum: u32 = prices.iter().sum();
        assert_eq!(sum, BPS as u32);
        for (i, p) in prices.iter().enumerate() {
            assert_eq!(s.reserves[i], 1_000_000_000);
            assert_eq!(s.creator_shares[i], 0);
            assert_eq!(*p, 1250);
        }

        // validation
        assert_eq!(
            seed_reserves(1_000, &[6000, 3000]),
            Err(MathError::InvalidInput) // sum != BPS
        );
        assert_eq!(
            seed_reserves(1_000, &[9950, 50]),
            Err(MathError::InvalidInput) // below MIN_PROB_BPS
        );
        assert_eq!(
            seed_reserves(1_000, &[10_000]),
            Err(MathError::InvalidInput) // n < 2
        );
        assert_eq!(
            seed_reserves(1_000, &[1250; 9]),
            Err(MathError::InvalidInput) // n > MAX_MARKET_OUTCOMES
        );
        assert_eq!(
            seed_reserves(0, &[5000, 5000]),
            Err(MathError::InvalidInput)
        );
    }

    #[test]
    fn cat_settle_rejects_bad_shapes() {
        assert_eq!(
            settle_value(Some(2), &[10, 10]),
            Err(MathError::InvalidInput)
        );
        assert_eq!(settle_value(None, &[10]), Err(MathError::InvalidInput));
        assert_eq!(settle_value(None, &[-1, 5]), Err(MathError::InvalidInput));
        // resolved pays exactly the winning balance
        assert_eq!(settle_value(Some(1), &[3, 7, 11]).unwrap(), 7);
        // void floors toward the pool
        assert_eq!(settle_value(None, &[3, 7, 11]).unwrap(), 7); // 21 / 3
        assert_eq!(settle_value(None, &[1, 1, 1, 1, 1, 1, 1]).unwrap(), 1);
    }

    #[test]
    fn cat_buy_and_sell_reject_bad_arguments() {
        let r = [1_000i128, 2_000, 3_000];
        assert_eq!(
            calc_buy(&r, 3, 100, 0),
            Err(MathError::InvalidInput) // index out of range
        );
        assert_eq!(calc_buy(&r, 0, 0, 0), Err(MathError::InvalidInput));
        assert_eq!(
            calc_buy(&[1_000, 0], 0, 100, 0),
            Err(MathError::InvalidInput)
        );
        // fee larger than the trade leaves nothing to mint
        assert_eq!(
            calc_buy(&[1_000, 1_000], 0, 100, 10_000),
            Err(MathError::InvalidInput)
        );
        // selling more than an "other" reserve holds is illiquid
        assert_eq!(
            calc_sell(&[1_000, 2_000, 3_000], 0, 5_000, 0),
            Err(MathError::InsufficientLiquidity)
        );
        // a sell leaves the sold reserve strictly larger (shares_in > 0)
        let q = calc_sell(&[1_000, 2_000, 3_000], 0, 100, 0).unwrap();
        assert!(q.shares_in > 0 && q.new_reserves[0] > 1_000);
        assert_eq!(q.new_reserves[1], 1_900);
        assert_eq!(q.new_reserves[2], 2_900);
    }
}
