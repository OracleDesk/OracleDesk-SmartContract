//! Correlated-risk caps by market category and close-date bucket (#49/#259).
//!
//! `max_trade`, `max_market` and `max_daily` don't bound correlated risk: ten
//! Crypto markets that all close the same week can each stay under
//! `max_market` and be spread across days to stay under `max_daily`, yet all
//! lose together. These helpers add the two missing dimensions, exposure per
//! `Category` and per close-date bucket.
//!
//! Notes on semantics (net / cost-basis, not lifetime):
//! - Exposure is `collateral_in - collateral_out` per market, floored at 0,
//!   and is released by sells, redemptions, claims, settlement and migration.
//! - A profitable sell can drive a market's basis to zero but never below, so
//!   profit in one market cannot create headroom in another.
//! - `close_time / bucket_secs` puts markets closing either side of a bucket
//!   boundary (e.g. 23:59 vs 00:01) in different buckets. Counting a market
//!   toward the next bucket too is out of scope.
//! - `bucket_secs` may not change while any correlated exposure is open,
//!   otherwise releases would decrement the wrong bucket.
//!
//! Storage keys use `category_index` (a `u32`), not the imported `Category`,
//! so they don't depend on the vendored enum's Rust identity.

use crate::{market_core::Category, Error};

/// Number of `Category` variants in market-core.
pub const CATEGORY_COUNT: u32 = 6;
/// Shortest allowed bucket: one day.
pub const MIN_BUCKET_SECS: u64 = 86_400;
/// Sanity ceiling for a category cap, as a multiple of `max_daily`.
pub const CATEGORY_CAP_DAILY_MULTIPLE: i128 = 30;

/// Discriminant of a market-core `Category`, in declaration order. Exhaustive
/// so a new upstream variant fails to compile here instead of mis-indexing.
pub fn category_index(category: &Category) -> u32 {
    match category {
        Category::Crypto => 0,
        Category::Macro => 1,
        Category::Geopolitics => 2,
        Category::Sports => 3,
        Category::Culture => 4,
        Category::Other => 5,
    }
}

/// Close-date bucket of a market. Fixed at first touch: `close_time` is
/// immutable in market-core.
pub fn close_bucket(close_time: u64, bucket_secs: u64) -> Result<u64, Error> {
    if bucket_secs < MIN_BUCKET_SECS {
        return Err(Error::InvalidConfig);
    }
    Ok(close_time / bucket_secs)
}

/// Validates correlation caps against the existing market/daily caps.
pub fn validate_correlation_caps(
    max_per_category: &[i128],
    max_per_bucket: i128,
    bucket_secs: u64,
    max_market: i128,
    max_daily: i128,
) -> Result<(), Error> {
    if max_per_category.len() != CATEGORY_COUNT as usize {
        return Err(Error::InvalidConfig);
    }
    let ceiling = max_daily
        .checked_mul(CATEGORY_CAP_DAILY_MULTIPLE)
        .ok_or(Error::InvalidConfig)?;
    // Below `max_market`, a single market could never reach its own cap.
    if max_per_category
        .iter()
        .any(|&cap| cap < max_market || cap > ceiling)
    {
        return Err(Error::InvalidConfig);
    }
    if max_per_bucket < max_market || bucket_secs < MIN_BUCKET_SECS {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

/// Checks a new reservation against the category and bucket caps and returns
/// the new totals. Writes nothing, so callers can keep "check all, then write
/// all": a failure here must leave market/daily accounting untouched.
pub fn check_correlated(
    max_per_category: &[i128],
    max_per_bucket: i128,
    category_idx: u32,
    category_exposure: i128,
    bucket_exposure: i128,
    amount: i128,
) -> Result<(i128, i128), Error> {
    let cap = *max_per_category
        .get(category_idx as usize)
        .ok_or(Error::InvalidConfig)?;
    let new_category = category_exposure
        .checked_add(amount)
        .ok_or(Error::InvalidAmount)?;
    if new_category > cap {
        return Err(Error::CategoryCapExceeded);
    }
    let new_bucket = bucket_exposure
        .checked_add(amount)
        .ok_or(Error::InvalidAmount)?;
    if new_bucket > max_per_bucket {
        return Err(Error::BucketCapExceeded);
    }
    Ok((new_category, new_bucket))
}

#[cfg(test)]
mod test {
    use super::*;

    const WEEK: u64 = 604_800;
    const CAPS: [i128; 6] = [500, 400, 400, 400, 400, 400];

    #[test]
    fn category_indexes_match_market_core_order() {
        let order = [
            Category::Crypto,
            Category::Macro,
            Category::Geopolitics,
            Category::Sports,
            Category::Culture,
            Category::Other,
        ];
        for (i, c) in order.iter().enumerate() {
            assert_eq!(category_index(c), i as u32);
        }
    }

    #[test]
    fn category_cap_blocks_correlated_buys_across_markets() {
        // Five Crypto markets of 100 fill the 500 cap; the sixth is refused
        // even though each market is far below max_market.
        let mut exposure = 0;
        for _ in 0..5 {
            let (cat, _) = check_correlated(&CAPS, 10_000, 0, exposure, 0, 100).unwrap();
            exposure = cat;
        }
        assert_eq!(
            check_correlated(&CAPS, 10_000, 0, exposure, 0, 100),
            Err(Error::CategoryCapExceeded)
        );
    }

    #[test]
    fn category_cap_does_not_affect_other_categories() {
        assert_eq!(
            check_correlated(&CAPS, 10_000, 1, 0, 0, 400),
            Ok((400, 400))
        );
        assert_eq!(
            check_correlated(&CAPS, 10_000, 0, 500, 0, 1),
            Err(Error::CategoryCapExceeded)
        );
    }

    #[test]
    fn bucket_cap_blocks_markets_closing_same_week() {
        assert_eq!(
            check_correlated(&CAPS, 300, 0, 0, 250, 100),
            Err(Error::BucketCapExceeded)
        );
    }

    #[test]
    fn markets_in_adjacent_buckets_are_independent() {
        let monday = 20_000 * WEEK;
        assert_eq!(close_bucket(monday + WEEK - 1, WEEK), Ok(20_000));
        assert_eq!(close_bucket(monday + WEEK, WEEK), Ok(20_001));
    }

    #[test]
    fn check_reports_unknown_category_and_overflow() {
        assert_eq!(
            check_correlated(&CAPS, 300, 6, 0, 0, 1),
            Err(Error::InvalidConfig)
        );
        assert_eq!(
            check_correlated(&CAPS, 300, 0, i128::MAX, 0, 1),
            Err(Error::InvalidAmount)
        );
    }

    #[test]
    fn constructor_rejects_category_cap_below_max_market() {
        assert_eq!(
            validate_correlation_caps(&CAPS, 500, WEEK, 100, 100),
            Ok(())
        );
        let low = [50, 400, 400, 400, 400, 400];
        assert_eq!(
            validate_correlation_caps(&low, 500, WEEK, 100, 100),
            Err(Error::InvalidConfig)
        );
        assert_eq!(
            validate_correlation_caps(&CAPS[..5], 500, WEEK, 100, 100),
            Err(Error::InvalidConfig)
        );
        assert_eq!(
            validate_correlation_caps(&CAPS, 50, WEEK, 100, 100),
            Err(Error::InvalidConfig)
        );
        assert_eq!(
            validate_correlation_caps(&CAPS, 500, 3_600, 100, 100),
            Err(Error::InvalidConfig)
        );
        // Above the max_daily * 30 sanity ceiling.
        assert_eq!(
            validate_correlation_caps(&CAPS, 500, WEEK, 100, 10),
            Err(Error::InvalidConfig)
        );
        assert_eq!(close_bucket(1, 3_600), Err(Error::InvalidConfig));
    }
}
