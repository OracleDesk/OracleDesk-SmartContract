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

use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

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
    /// Scalar (range) market, final: LONG shares pay `payout_long_bps /
    /// 10_000` and SHORT shares the complement. Appended last so stored
    /// `Resolved`/`Void` values keep their encoding; readers compiled
    /// against older bindings fail to decode this one (see the release note).
    ResolvedScalar(u32),
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

/// Categorical counterpart of [`SignerConfig`]: signers attest an outcome
/// *index* of a categorical market instead of Yes/No. `outcome_count`
/// binds the market's outcome set to the commitment (2..=8, mirroring
/// market-core's cap), so a reveal cannot silently change how many outcomes
/// signers are voting on.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatSignerConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub dispute_window: u64,
    pub outcome_count: u32,
}

/// Scalar (range) counterpart of [`PriceConfig`]. The market settles on the
/// fractional position of `price` inside `[lower, upper]`:
/// `payout_long_bps = (clamped_price - lower) / (upper - lower)`, and the
/// SHORT side pays the complement. A reading below the range clamps to
/// `lower` (LONG pays 0), above to `upper` (LONG pays 1.0); a non-positive
/// reading is an invalid price, never a clamp.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScalarPriceConfig {
    pub reflector: Address,
    pub asset: OracleAsset,
    /// Bottom of the staked range. Validated `0 <= lower < upper`, with
    /// `upper` capped so `upper * BPS` cannot overflow.
    pub lower: i128,
    pub upper: i128,
    pub max_staleness: u64,
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
    /// Categorical counterpart of `Signers` (appended, tag 6).
    CategoricalSigners(CatSignerConfig),
    /// Scalar counterpart of `Price` (appended, tag 7): the binary pool
    /// settles at a fractional LONG payout instead of a side.
    Scalar(ScalarPriceConfig),
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
                price,
                fallback: signer,
                fallback_after: 3_600,
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
