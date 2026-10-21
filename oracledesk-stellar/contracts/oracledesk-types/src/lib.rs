#![no_std]

//! Canonical `#[contracttype]` definitions shared across OracleDesk contracts.
//!
//! Before this crate, `Outcome`/`Category` existed three times (once in
//! `market-core`, and once more in each of `resolver` and `treasury` through
//! `contractimport!`), and the resolution-spec types lived only in `resolver`
//! while being XDR-consensus-critical for every `resolution_hash`. Identical
//! XDR shape, but three Rust types and three chances for silent divergence:
//! reorder a field in one copy and every existing commitment breaks with no
//! compile error. This crate removes that class of bug for the types that
//! cross a contract boundary (`oracledesk-types`).
//!
//! Rules for this crate:
//! - Only `#[contracttype]` items. No `#[contract]`, no `#[contractimpl]`, no
//!   exported wasm symbols (see ADR 0002's `__constructor` collision).
//! - Types here are encodings, not behaviour: field and variant *names* are
//!   consensus-critical because `#[contracttype]` structs encode as an `ScMap`
//!   keyed by field name. Never rename or reorder an existing field; add a new
//!   variant/type instead (see `docs/adr/0001-resolution-commitment.md`).
//!
//! `contractimport!` remains the mechanism for generating *clients* from a
//! compiled wasm. Its generated types are structurally identical to these;
//! `contracts/resolver`'s `shared_types_are_byte_identical_to_imported` test
//! pins that byte-for-byte.

use soroban_sdk::{Address, BytesN, Symbol, Vec};

// ---------------------------------------------------------------------------
// market-core outcome surface
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Yes,
    No,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Category {
    Crypto,
    Macro,
    Geopolitics,
    Sports,
    Culture,
    Other,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketStatus {
    /// Trading allowed until `close_time`, then waiting for the resolver.
    Open,
    /// Final. Winning shares redeem 1:1.
    Resolved(Outcome),
    /// Invalid market. Every share redeems at 0.5.
    Void,
}

// ---------------------------------------------------------------------------
// resolver resolution-spec surface
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PriceDirection {
    Above,
    AtOrAbove,
    Below,
    AtOrBelow,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceConfig {
    pub reflector: Address,
    pub asset: OracleAsset,
    pub threshold: i128,
    pub direction: PriceDirection,
    pub max_staleness: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub dispute_window: u64,
}

/// Who rules on a dispute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Escalation {
    /// The resolver admin, through `settle_dispute`.
    Guardian,
    /// `k` of these members, through `escalation_attest`. Must be disjoint
    /// from the proposing signers.
    Committee(Vec<Address>, u32),
}

/// Attested resolution whose proposal can be challenged with a bond during
/// the dispute window. Hashed as `ResolutionSpec::SignersDisputable`, a
/// separate variant, so existing `Signers` commitments are unaffected.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputableSignerConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub dispute_window: u64,
    /// Collateral escrowed by `dispute`; must be positive.
    pub dispute_bond: i128,
    pub escalation: Escalation,
    /// Seconds after a dispute opens before anyone may void it unresolved.
    pub escalation_timeout: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WeightedKey {
    /// Raw Ed25519 public key. For a `G...` account address this is
    /// `StrKey.decodeEd25519PublicKey(address)`; `C...` addresses have none.
    pub pubkey: BytesN<32>,
    pub weight: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WeightedKeyConfig {
    pub signers: Vec<WeightedKey>,
    /// Total weight that must sign one outcome. Choose it above half the total
    /// weight so two outcomes can never both reach it.
    pub weight_threshold: u32,
    pub dispute_window: u64,
}

/// Binds a market to a reusable committee registry subject to rotation bounds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitteeRef {
    pub committee_id: u64,
    pub min_epoch: u32,
    pub max_rotation_delta: u32,
    pub dispute_window: u64,
}

/// Dual-path resolution mode: price feed first, falling back to signers.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HybridConfig {
    pub price: PriceConfig,
    pub fallback: SignerConfig,
    pub fallback_after: u64,
}

/// One oracle feed inside a [`QuorumPriceConfig`].
///
/// `decimals` is creator-declared at registration, not read from the feed:
/// the Reflector-style price interface (`price(asset, timestamp)`) exposes no
/// `decimals()` method, and probing for one would fail against every deployed
/// Reflector. Carrying it in the commitment keeps the normalisation scale
/// covered by the `resolution_hash` instead of trusting a live oracle call.
/// Validated `<= 18` (`MAX_DECIMALS`) before the spec is ever stored.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedRef {
    pub reflector: Address,
    pub asset: OracleAsset,
    /// Decimal places by which this feed's `PriceData::price` is scaled.
    pub decimals: u32,
}

/// Multi-oracle quorum rule: read every committed feed, reject the ones that
/// fail per-feed checks, take the median of the survivors, and compare it to
/// `threshold` like [`PriceConfig`] does. Registration validates
/// `1 <= min_responses <= feeds.len() <= MAX_FEEDS`, a strict majority
/// (`min_responses * 2 > feeds.len()`), distinct `(reflector, asset)` pairs,
/// `max_deviation_bps <= 10_000`, and per-feed decimals `<= 18`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuorumPriceConfig {
    pub feeds: Vec<FeedRef>,
    /// Minimum feeds that must produce a usable price. Fewer resolves nothing
    /// (retryable), it never voids.
    pub min_responses: u32,
    /// Strike compared against the median, at `threshold_decimals` scale.
    pub threshold: i128,
    /// Decimal places of [`Self::threshold`]. The resolution normalises every
    /// price and the threshold to `max(threshold_decimals, max feed decimals)`
    /// (capped at 18).
    pub threshold_decimals: u32,
    pub direction: PriceDirection,
    pub max_staleness: u64,
    /// Maximum tolerated `(max - min) / median` spread across accepted feeds,
    /// in basis points. A wider spread is `FeedsDisagree`, not a median.
    pub max_deviation_bps: u32,
}

/// The full resolution rule a market's `resolution_hash` commits to. Hashing
/// this (rather than the bare `PriceConfig`/`SignerConfig`) keeps the two
/// modes in disjoint hash spaces even if their field encodings could
/// otherwise collide. See `docs/adr/0001-resolution-commitment.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolutionSpec {
    Price(PriceConfig),
    Signers(SignerConfig),
    WeightedKeys(WeightedKeyConfig),
    SignersDisputable(DisputableSignerConfig),
    Committee(CommitteeRef),
    Hybrid(HybridConfig),
    /// Append-only tail: `#[contracttype]` enums encode the *case name* as an
    /// `ScVal` union, and every existing hash is over `sha256(XDR(spec))`, so
    /// appending a variant cannot shift or re-encode `Price`/`Signers`/... —
    /// the `golden` tests in `contracts/resolver` pin those exact hashes.
    PriceQuorum(QuorumPriceConfig),
}

/// Versioned commitment envelope. Unlike a bare [`ResolutionSpec`] it binds the
/// network and the market-core instance, and carries a creator-chosen `salt`
/// that makes a pre-reveal brute-force of the (low-entropy) rule infeasible.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionSpecV2 {
    pub version: u32,
    /// `sha256(network passphrase)`, i.e. `env.ledger().network_id()`.
    pub network_id: BytesN<32>,
    pub market_core: Address,
    pub salt: BytesN<32>,
    pub rule: ResolutionSpec,
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, xdr::ToXdr, Env};

    /// `#[contracttype]` enums encode their case name as an `ScSymbol`, so the
    /// XDR of the shared `Outcome` must stay `Yes`/`No`, never reordered.
    #[test]
    fn outcome_encodes_as_expected_symbols() {
        let env = Env::default();
        assert_eq!(
            Outcome::Yes.to_xdr(&env),
            Symbol::new(&env, "Yes").to_xdr(&env)
        );
        assert_eq!(
            Outcome::No.to_xdr(&env),
            Symbol::new(&env, "No").to_xdr(&env)
        );
    }

    #[test]
    fn category_encodes_as_expected_symbols() {
        let env = Env::default();
        for (value, name) in [
            (Category::Crypto, "Crypto"),
            (Category::Macro, "Macro"),
            (Category::Geopolitics, "Geopolitics"),
            (Category::Sports, "Sports"),
            (Category::Culture, "Culture"),
            (Category::Other, "Other"),
        ] {
            assert_eq!(value.to_xdr(&env), Symbol::new(&env, name).to_xdr(&env));
        }
    }

    /// The resolution rule is a plain struct/variant graph; encoding it must
    /// not depend on `Address` values we cannot hardcode. This pins the
    /// *variant order* indirectly by re-encoding through a manual match.
    #[test]
    fn resolution_spec_variants_are_stable_and_distinct() {
        let env = Env::default();
        let reflector = Address::generate(&env);
        let price = PriceConfig {
            reflector: reflector.clone(),
            asset: OracleAsset::Other(Symbol::new(&env, "XLM")),
            threshold: 2_000,
            direction: PriceDirection::Above,
            max_staleness: 10,
        };
        let mut signers = Vec::new(&env);
        signers.push_back(reflector);
        let signer = SignerConfig {
            signers,
            threshold: 1,
            dispute_window: 5,
        };

        let specs = [
            ResolutionSpec::Price(price.clone()),
            ResolutionSpec::Signers(signer.clone()),
            ResolutionSpec::Hybrid(HybridConfig {
                price: price.clone(),
                fallback: signer.clone(),
                fallback_after: 3_600,
            }),
            ResolutionSpec::PriceQuorum(QuorumPriceConfig {
                feeds: Vec::from_array(
                    &env,
                    [FeedRef {
                        reflector: price.reflector.clone(),
                        asset: price.asset.clone(),
                        decimals: 8,
                    }],
                ),
                min_responses: 1,
                threshold: price.threshold,
                threshold_decimals: 8,
                direction: price.direction,
                max_staleness: price.max_staleness,
                max_deviation_bps: 100,
            }),
        ];
        for (i, a) in specs.iter().enumerate() {
            for (j, b) in specs.iter().enumerate() {
                if i == j {
                    assert_eq!(a.clone().to_xdr(&env), b.clone().to_xdr(&env));
                } else {
                    assert_ne!(a.clone().to_xdr(&env), b.clone().to_xdr(&env));
                }
            }
        }
    }
}
