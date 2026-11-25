//! Deployable SEP-40 test oracle contract for testnet and local E2E runs (Issue #133).
//!
//! Implements the SEP-40 Oracle Consumer read interface (`base`, `assets`,
//! `decimals`, `resolution`, `period`, `price`, `prices`, `lastprice`) backed
//! by an admin-controlled write API (`set_price`, `set_prices`, `add_asset`,
//! `set_period`) with resolution-slot alignment and bounded history retention.
//!
//! Deliberate differences from production Reflector:
//! - Single admin key posts prices directly (no multi-node quorum or consensus).
//! - `set_price` deliberately accepts `price <= 0` so downstream resolver
//!   validation (`Error::InvalidPrice`) can be exercised against a real deployed
//!   SEP-40 contract.
//! - Intended for Stellar testnet and local quickstart networks only — never
//!   deploy or reference this contract on mainnet.
//!
//! The `Asset` and `PriceData` `#[contracttype]` definitions match
//! `oracledesk_types::{OracleAsset, PriceData}` variant-for-variant and
//! field-for-field so their XDR encodings are identical.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
    Vec,
};

/// Maximum number of assets tracked by one test-oracle instance.
pub const MAX_ASSETS: u32 = 32;
/// Maximum records returned by a single `prices(asset, records)` query.
pub const MAX_PRICES_RECORDS: u32 = 64;

const LEDGER_SECONDS: u64 = 5;
const MIN_BUMP_LEDGERS: u32 = 17_280; // ~1 day

/// SEP-40 Asset identifier. Variant names and order match `resolver::OracleAsset`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// Alias kept for readability alongside `resolver::OracleAsset`.
pub type OracleAsset = Asset;

/// SEP-40 price record returned by `price`, `prices`, and `lastprice`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Base,
    Decimals,
    Resolution,
    Period,
    Assets,
    Price(Asset, u64),
    LastSlot(Asset),
    OldestSlot(Asset),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    UnknownAsset = 3,
    MisalignedTimestamp = 4,
    FutureTimestamp = 5,
    TooManyRecords = 6,
    InvalidConfig = 7,
    TooManyAssets = 8,
}

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    /// Initializes the SEP-40 test oracle.
    ///
    /// `resolution` is the slot cadence in seconds (e.g. `300` for 5 minutes).
    /// `period` is the retention horizon in seconds (e.g. `86400` for 24 hours).
    pub fn __constructor(
        env: Env,
        admin: Address,
        base: Asset,
        decimals: u32,
        resolution: u32,
        period: u64,
    ) {
        if resolution == 0 || period == 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Base, &base);
        s.set(&DataKey::Decimals, &decimals);
        s.set(&DataKey::Resolution, &resolution);
        s.set(&DataKey::Period, &period);
        let empty: Vec<Asset> = Vec::new(&env);
        s.set(&DataKey::Assets, &empty);
    }

    // -----------------------------------------------------------------------
    // SEP-40 read interface
    // -----------------------------------------------------------------------

    /// Base asset that prices are quoted in (for example `Asset::Other("USD")`).
    pub fn base(env: Env) -> Asset {
        env.storage()
            .instance()
            .get(&DataKey::Base)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Supported assets registered via `add_asset`.
    pub fn assets(env: Env) -> Vec<Asset> {
        env.storage()
            .instance()
            .get(&DataKey::Assets)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Fixed-point decimal places for returned prices.
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Feed cadence in seconds. Timestamps align to multiples of `resolution`.
    pub fn resolution(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Resolution)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Retention period in seconds. Records older than `latest_slot - period`
    /// are pruned on subsequent writes.
    pub fn period(env: Env) -> Option<u64> {
        env.storage().instance().get(&DataKey::Period)
    }

    /// Returns the price record for `asset` at `timestamp`, rounded down to
    /// the resolution slot `timestamp - (timestamp % resolution)`.
    pub fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        let res = Self::resolution_u64(&env);
        let slot = timestamp - (timestamp % res);
        env.storage().persistent().get(&DataKey::Price(asset, slot))
    }

    /// Returns up to `records` most recent price records for `asset`, ordered
    /// newest-first. Returns `None` if `asset` has no stored prices or
    /// `records == 0`. Capped at [`MAX_PRICES_RECORDS`].
    pub fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        if records == 0 {
            return None;
        }
        let cap = records.min(MAX_PRICES_RECORDS);
        let last_slot: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::LastSlot(asset.clone()))?;
        let res = Self::resolution_u64(&env);
        let period: u64 = env.storage().instance().get(&DataKey::Period).unwrap_or(0);
        let floor_slot = last_slot.saturating_sub(period);

        let mut out: Vec<PriceData> = Vec::new(&env);
        let mut slot = last_slot;
        let mut scanned = 0u32;
        let max_scan = MAX_PRICES_RECORDS.saturating_mul(4);
        loop {
            if let Some(pd) = env
                .storage()
                .persistent()
                .get::<_, PriceData>(&DataKey::Price(asset.clone(), slot))
            {
                out.push_back(pd);
                if out.len() >= cap {
                    break;
                }
            }
            scanned += 1;
            if slot <= floor_slot || slot < res || scanned >= max_scan {
                break;
            }
            slot -= res;
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    /// Returns the newest recorded price for `asset`, if any.
    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        let last_slot: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::LastSlot(asset.clone()))?;
        env.storage()
            .persistent()
            .get(&DataKey::Price(asset, last_slot))
    }

    // -----------------------------------------------------------------------
    // Admin write API
    // -----------------------------------------------------------------------

    /// Registers an asset so prices may be posted for it. Idempotent.
    pub fn add_asset(env: Env, asset: Asset) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let mut list: Vec<Asset> = env
            .storage()
            .instance()
            .get(&DataKey::Assets)
            .unwrap_or_else(|| Vec::new(&env));
        for existing in list.iter() {
            if existing == asset {
                return Ok(());
            }
        }
        if list.len() >= MAX_ASSETS {
            return Err(Error::TooManyAssets);
        }
        list.push_back(asset);
        env.storage().instance().set(&DataKey::Assets, &list);
        Ok(())
    }

    /// Updates the retention horizon in seconds.
    pub fn set_period(env: Env, period: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if period == 0 {
            return Err(Error::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Period, &period);
        Ok(())
    }

    /// Posts a single price observation for a registered `asset` at `timestamp`.
    ///
    /// `timestamp` must be aligned to `resolution()` and must not exceed the
    /// current ledger timestamp (`FutureTimestamp`). Note that `price <= 0` is
    /// deliberately permitted so resolver validation of invalid prices can be
    /// tested against a deployed oracle.
    pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        Self::validate_timestamp(&env, timestamp)?;
        Self::assert_known_asset(&env, &asset)?;
        Self::write_price(&env, &asset, price, timestamp);
        Ok(())
    }

    /// Posts a batch of `(asset, price)` observations for the same `timestamp`.
    pub fn set_prices(env: Env, entries: Vec<(Asset, i128)>, timestamp: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if entries.len() > MAX_PRICES_RECORDS {
            return Err(Error::TooManyRecords);
        }
        Self::validate_timestamp(&env, timestamp)?;
        for (asset, _) in entries.iter() {
            Self::assert_known_asset(&env, &asset)?;
        }
        for (asset, price) in entries.iter() {
            Self::write_price(&env, &asset, price, timestamp);
        }
        Ok(())
    }
}

impl TestOracle {
    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn resolution_u64(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get::<_, u32>(&DataKey::Resolution)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized)) as u64
    }

    fn validate_timestamp(env: &Env, timestamp: u64) -> Result<(), Error> {
        let res = Self::resolution_u64(env);
        if !timestamp.is_multiple_of(res) {
            return Err(Error::MisalignedTimestamp);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::FutureTimestamp);
        }
        Ok(())
    }

    fn assert_known_asset(env: &Env, asset: &Asset) -> Result<(), Error> {
        let list: Vec<Asset> = env
            .storage()
            .instance()
            .get(&DataKey::Assets)
            .unwrap_or_else(|| Vec::new(env));
        for existing in list.iter() {
            if &existing == asset {
                return Ok(());
            }
        }
        Err(Error::UnknownAsset)
    }

    fn write_price(env: &Env, asset: &Asset, price: i128, slot: u64) {
        let period: u64 = env.storage().instance().get(&DataKey::Period).unwrap_or(0);
        let res = Self::resolution_u64(env);
        let ttl_ledgers = ((period / LEDGER_SECONDS) as u32)
            .saturating_mul(2)
            .max(MIN_BUMP_LEDGERS);
        let threshold = (ttl_ledgers / 2).max(1);

        let key = DataKey::Price(asset.clone(), slot);
        let persistent = env.storage().persistent();
        persistent.set(
            &key,
            &PriceData {
                price,
                timestamp: slot,
            },
        );
        persistent.extend_ttl(&key, threshold, ttl_ledgers);

        let last_key = DataKey::LastSlot(asset.clone());
        let prev_last: Option<u64> = persistent.get(&last_key);
        let new_last = match prev_last {
            Some(prev) if prev > slot => prev,
            _ => slot,
        };
        persistent.set(&last_key, &new_last);
        persistent.extend_ttl(&last_key, threshold, ttl_ledgers);

        let oldest_key = DataKey::OldestSlot(asset.clone());
        let mut oldest: u64 = persistent.get(&oldest_key).unwrap_or(slot);
        if slot < oldest {
            oldest = slot;
        }

        // Prune records strictly older than `new_last - period` (as well as
        // the exact `slot - period` boundary if `slot >= period`).
        if period > 0 && new_last > period {
            let cutoff = new_last - period;
            let mut cur = oldest;
            let mut steps = 0u32;
            while cur <= cutoff && steps < MAX_PRICES_RECORDS.saturating_mul(4) {
                persistent.remove(&DataKey::Price(asset.clone(), cur));
                cur = cur.saturating_add(res);
                steps += 1;
            }
            oldest = cur;
        }
        persistent.set(&oldest_key, &oldest);
        persistent.extend_ttl(&oldest_key, threshold, ttl_ledgers);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
        vec, Env, IntoVal,
    };

    const RES: u32 = 300;
    const PERIOD: u64 = 1_500; // 5 slots

    fn setup() -> (Env, TestOracleClient<'static>, Address, Address, Asset) {
        let env = Env::default();
        env.ledger().with_mut(|l| {
            l.timestamp = 10_000;
        });
        let admin = Address::generate(&env);
        let base = Asset::Other(Symbol::new(&env, "USD"));
        let id = env.register(TestOracle, (admin.clone(), base, 14u32, RES, PERIOD));
        let client = TestOracleClient::new(&env, &id);
        let xlm = Asset::Other(Symbol::new(&env, "XLM"));
        env.mock_all_auths();
        client.add_asset(&xlm);
        (env, client, id, admin, xlm)
    }

    #[test]
    fn price_aligns_to_resolution_slot() {
        let (env, client, _, _, xlm) = setup();
        // Ledger timestamp is 10_000; slot 9_900 is aligned to 300.
        client.set_price(&xlm, &2_100, &9_900);
        // Any timestamp in [9_900, 10_199] rounds down to 9_900.
        assert_eq!(
            client.price(&xlm, &9_900),
            Some(PriceData {
                price: 2_100,
                timestamp: 9_900
            })
        );
        assert_eq!(
            client.price(&xlm, &10_045),
            Some(PriceData {
                price: 2_100,
                timestamp: 9_900
            })
        );
        assert_eq!(client.base(), Asset::Other(Symbol::new(&env, "USD")));
        assert_eq!(client.decimals(), 14);
        assert_eq!(client.resolution(), RES);
        assert_eq!(client.period(), Some(PERIOD));
        assert_eq!(client.assets().len(), 1);
    }

    #[test]
    fn price_returns_none_for_missing_slot() {
        let (_, client, _, _, xlm) = setup();
        client.set_price(&xlm, &2_100, &9_900);
        assert_eq!(client.price(&xlm, &9_600), None);
        assert_eq!(client.price(&xlm, &10_200), None);
    }

    #[test]
    fn lastprice_returns_newest() {
        let (_, client, _, _, xlm) = setup();
        assert_eq!(client.lastprice(&xlm), None);
        client.set_price(&xlm, &1_500, &9_300);
        client.set_price(&xlm, &2_200, &9_900);
        // Posting an older backfill must not overwrite lastprice.
        client.set_price(&xlm, &1_800, &9_600);
        assert_eq!(
            client.lastprice(&xlm),
            Some(PriceData {
                price: 2_200,
                timestamp: 9_900
            })
        );
    }

    #[test]
    fn prices_returns_newest_first_capped() {
        let (_, client, _, _, xlm) = setup();
        client.set_price(&xlm, &1_000, &9_000);
        client.set_price(&xlm, &1_100, &9_300);
        client.set_price(&xlm, &1_200, &9_600);
        client.set_price(&xlm, &1_300, &9_900);

        let top2 = client.prices(&xlm, &2).unwrap();
        assert_eq!(top2.len(), 2);
        assert_eq!(
            top2.get(0).unwrap(),
            PriceData {
                price: 1_300,
                timestamp: 9_900
            }
        );
        assert_eq!(
            top2.get(1).unwrap(),
            PriceData {
                price: 1_200,
                timestamp: 9_600
            }
        );

        let all = client.prices(&xlm, &10).unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(client.prices(&xlm, &0), None);
    }

    #[test]
    fn set_price_rejects_misaligned_timestamp() {
        let (_, client, _, _, xlm) = setup();
        let err = client.try_set_price(&xlm, &2_000, &9_901).unwrap_err();
        assert_eq!(err.unwrap(), Error::MisalignedTimestamp);
    }

    #[test]
    fn set_price_rejects_future_timestamp() {
        let (_, client, _, _, xlm) = setup();
        // Ledger timestamp is 10_000; 10_200 is aligned but in the future.
        let err = client.try_set_price(&xlm, &2_000, &10_200).unwrap_err();
        assert_eq!(err.unwrap(), Error::FutureTimestamp);
    }

    #[test]
    fn old_records_pruned_after_period() {
        let (env, client, _, _, xlm) = setup();
        // PERIOD = 1_500, RES = 300.
        client.set_price(&xlm, &1_000, &9_000);
        client.set_price(&xlm, &1_100, &9_300);
        assert!(client.price(&xlm, &9_000).is_some());

        // Advance ledger and write at 10_500 => cutoff = 10_500 - 1_500 = 9_000,
        // so slot 9_000 is pruned while 9_300 remains retained.
        env.ledger().with_mut(|l| {
            l.timestamp = 10_600;
        });
        client.set_price(&xlm, &1_500, &10_500);
        assert_eq!(client.price(&xlm, &9_000), None);
        assert!(client.price(&xlm, &9_300).is_some());
        assert!(client.price(&xlm, &10_500).is_some());
    }

    #[test]
    fn unknown_asset_rejected() {
        let (env, client, _, _, _) = setup();
        let btc = Asset::Other(Symbol::new(&env, "BTC"));
        let err = client.try_set_price(&btc, &50_000, &9_900).unwrap_err();
        assert_eq!(err.unwrap(), Error::UnknownAsset);
    }

    #[test]
    fn wrong_caller_cannot_set_price() {
        let (env, client, id, admin, xlm) = setup();
        let attacker = Address::generate(&env);

        // Targeted mock_auths (no mock_all_auths): attacker must fail.
        env.set_auths(&[]);
        let res = client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &id,
                    fn_name: "set_price",
                    args: (xlm.clone(), 2_100_i128, 9_900u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_price(&xlm, &2_100_i128, &9_900u64);
        assert!(res.is_err());

        // Admin with matching targeted auth succeeds (including non-positive price for resolver tests).
        env.set_auths(&[]);
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &id,
                    fn_name: "set_price",
                    args: (xlm.clone(), 0_i128, 9_900u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_price(&xlm, &0_i128, &9_900u64);
        assert_eq!(
            client.price(&xlm, &9_900),
            Some(PriceData {
                price: 0,
                timestamp: 9_900
            })
        );
    }

    #[test]
    fn set_prices_batch_and_set_period_work() {
        let (env, client, _, _, xlm) = setup();
        let eth = Asset::Other(Symbol::new(&env, "ETH"));
        client.add_asset(&eth);
        client.set_prices(
            &vec![&env, (xlm.clone(), 2_000), (eth.clone(), 30_000)],
            &9_900,
        );
        assert_eq!(client.price(&xlm, &9_900).unwrap().price, 2_000);
        assert_eq!(client.price(&eth, &9_900).unwrap().price, 30_000);
        client.set_period(&3_600);
        assert_eq!(client.period(), Some(3_600));
    }
}
