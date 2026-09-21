#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, xdr::ToXdr, Address,
    BytesN, Env, Symbol, Vec,
};

// market-core is imported from its compiled wasm rather than as a normal
// Cargo path dependency: `#[contractimpl]` exports every contract entrypoint
// as a `#[no_mangle]` wasm symbol, and a crate's wasm build merges in *all*
// contract functions reachable through its dependency graph (soroban-sdk's
// own docs on `#[contract]` note this). Depending on the market-core crate
// directly made `resolver`'s wasm build fail with "symbol `__constructor`
// multiply defined" — both contracts define one. `contractimport!` instead
// generates client bindings from the wasm's interface spec, with no such
// collision. See `docs/adr/0002-cross-contract-calls.md`; regenerating
// `market_core.wasm` here after a market-core change is a `make build` step.
#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::{Client as MarketCoreClient, Outcome};

const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolutionState {
    Unconfigured,
    SignersPending,
    Finalized,
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerProposal {
    pub outcome: Outcome,
    pub proposed_at: u64,
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
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    MarketAlreadyConfigured = 4,
    MarketNotConfigured = 5,
    WrongMode = 6,
    MarketNotClosed = 7,
    PriceUnavailable = 8,
    StalePrice = 9,
    InvalidPrice = 10,
    NotSigner = 11,
    AlreadyAttested = 12,
    ThresholdNotReached = 13,
    DisputeActive = 14,
    DisputeWindowOpen = 15,
    NoProposal = 16,
    AlreadyFinalized = 17,
    SpecHashMismatch = 18,
}

#[contracttype]
pub enum DataKey {
    Admin,
    MarketCore,
    Price(u64),
    Signers(u64),
    Proposal(u64),
    Attestation(u64, Outcome, Address),
    Count(u64, Outcome),
    State(u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceResolution {
    #[topic]
    pub market_id: u64,
    pub price: i128,
    pub price_timestamp: u64,
    pub outcome: Outcome,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionFinalized {
    #[topic]
    pub market_id: u64,
    pub outcome: Outcome,
    pub finalized_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionProposed {
    #[topic]
    pub market_id: u64,
    pub outcome: Outcome,
    pub proposed_at: u64,
}

#[soroban_sdk::contractclient(name = "ReflectorPriceClient")]
pub trait ReflectorPrice {
    fn price(env: Env, asset: OracleAsset, timestamp: u64) -> Option<PriceData>;
}

#[contract]
pub struct Resolver;

#[contractimpl]
impl Resolver {
    pub fn __constructor(env: Env, admin: Address, market_core: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MarketCore, &market_core);
    }

    /// Reveals the resolution rule committed to at market creation. Anyone
    /// may call this (there is no admin gate) because the only thing that
    /// makes a spec acceptable is that it hashes to `market.resolution_hash`
    /// — the commitment, not the caller, is the authority. Fails if a spec
    /// was already registered for this market.
    pub fn register_price_spec(env: Env, market_id: u64, spec: PriceConfig) -> Result<(), Error> {
        Self::assert_unconfigured(&env, market_id)?;
        if spec.threshold < 0 || spec.max_staleness == 0 {
            return Err(Error::InvalidConfig);
        }
        Self::assert_matches_commitment(&env, market_id, &ResolutionSpec::Price(spec.clone()))?;

        let key = DataKey::Price(market_id);
        env.storage().persistent().set(&key, &spec);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        env.storage()
            .persistent()
            .set(&DataKey::State(market_id), &ResolutionState::Unconfigured);
        Ok(())
    }

    /// See `register_price_spec` — same commit/reveal rule, signer mode.
    pub fn register_signer_spec(env: Env, market_id: u64, spec: SignerConfig) -> Result<(), Error> {
        Self::assert_unconfigured(&env, market_id)?;
        if spec.signers.is_empty()
            || spec.threshold == 0
            || spec.threshold > spec.signers.len()
            || spec.dispute_window == 0
        {
            return Err(Error::InvalidConfig);
        }
        Self::assert_matches_commitment(&env, market_id, &ResolutionSpec::Signers(spec.clone()))?;

        let key = DataKey::Signers(market_id);
        env.storage().persistent().set(&key, &spec);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        env.storage()
            .persistent()
            .set(&DataKey::State(market_id), &ResolutionState::SignersPending);
        Ok(())
    }

    /// Guardian action: withdraws an unfinalized signer proposal, e.g. because
    /// evidence surfaced during the dispute window that it is wrong. Voting
    /// can restart once the counts are cleared by re-attesting.
    pub fn cancel_proposal(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let key = DataKey::Proposal(market_id);
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoProposal);
        }
        env.storage().persistent().remove(&key);
        Ok(())
    }

    /// Guardian action: voids an unresolvable market directly through
    /// market-core. The resolver is the direct caller, so market-core's
    /// `require_resolver` check passes the same way `resolve_price` does.
    pub fn guardian_void_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if Self::resolution_state(&env, market_id) == ResolutionState::Finalized {
            return Err(Error::AlreadyFinalized);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        MarketCoreClient::new(&env, &market_core).void_market(&market_id);
        env.storage()
            .persistent()
            .set(&DataKey::State(market_id), &ResolutionState::Finalized);
        Ok(())
    }

    pub fn resolve_price(env: Env, market_id: u64) -> Result<Outcome, Error> {
        let config: PriceConfig = Self::load(&env, DataKey::Price(market_id))?;
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = MarketCoreClient::new(&env, &market_core).get_market(&market_id);
        if env.ledger().timestamp() < market.close_time {
            return Err(Error::MarketNotClosed);
        }
        if Self::resolution_state(&env, market_id) == ResolutionState::Finalized {
            return Err(Error::AlreadyFinalized);
        }
        let data = ReflectorPriceClient::new(&env, &config.reflector)
            .price(&config.asset, &market.close_time)
            .ok_or(Error::PriceUnavailable)?;
        if data.timestamp > market.close_time
            || market.close_time - data.timestamp > config.max_staleness
        {
            return Err(Error::StalePrice);
        }
        let outcome = match config.direction {
            PriceDirection::Above => {
                if data.price > config.threshold {
                    Outcome::Yes
                } else {
                    Outcome::No
                }
            }
            PriceDirection::AtOrAbove => {
                if data.price >= config.threshold {
                    Outcome::Yes
                } else {
                    Outcome::No
                }
            }
            PriceDirection::Below => {
                if data.price < config.threshold {
                    Outcome::Yes
                } else {
                    Outcome::No
                }
            }
            PriceDirection::AtOrBelow => {
                if data.price <= config.threshold {
                    Outcome::Yes
                } else {
                    Outcome::No
                }
            }
        };
        MarketCoreClient::new(&env, &market_core).resolve(&market_id, &outcome);
        env.storage()
            .persistent()
            .set(&DataKey::State(market_id), &ResolutionState::Finalized);
        PriceResolution {
            market_id,
            price: data.price,
            price_timestamp: data.timestamp,
            outcome: outcome.clone(),
        }
        .publish(&env);
        Ok(outcome)
    }

    pub fn attest(
        env: Env,
        market_id: u64,
        signer: Address,
        outcome: Outcome,
    ) -> Result<(), Error> {
        signer.require_auth();
        let config: SignerConfig = Self::load(&env, DataKey::Signers(market_id))?;
        if !Self::is_signer(&config.signers, &signer) {
            return Err(Error::NotSigner);
        }
        if Self::resolution_state(&env, market_id) == ResolutionState::Finalized {
            return Err(Error::AlreadyFinalized);
        }
        if env.storage().persistent().has(&DataKey::Attestation(
            market_id,
            outcome.clone(),
            signer.clone(),
        )) {
            return Err(Error::AlreadyAttested);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = MarketCoreClient::new(&env, &market_core).get_market(&market_id);
        if env.ledger().timestamp() < market.close_time {
            return Err(Error::MarketNotClosed);
        }
        env.storage().persistent().set(
            &DataKey::Attestation(market_id, outcome.clone(), signer),
            &true,
        );
        let count_key = DataKey::Count(market_id, outcome.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let count = count + 1;
        env.storage().persistent().set(&count_key, &count);
        if count >= config.threshold {
            let proposal = SignerProposal {
                outcome: outcome.clone(),
                proposed_at: env.ledger().timestamp(),
            };
            env.storage()
                .persistent()
                .set(&DataKey::Proposal(market_id), &proposal);
            ResolutionProposed {
                market_id,
                outcome,
                proposed_at: proposal.proposed_at,
            }
            .publish(&env);
        }
        Ok(())
    }

    pub fn finalize_signers(env: Env, market_id: u64) -> Result<Outcome, Error> {
        let config: SignerConfig = Self::load(&env, DataKey::Signers(market_id))?;
        let proposal: SignerProposal =
            Self::load(&env, DataKey::Proposal(market_id)).map_err(|_| Error::NoProposal)?;
        if env.ledger().timestamp() < proposal.proposed_at + config.dispute_window {
            return Err(Error::DisputeWindowOpen);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Count(market_id, proposal.outcome.clone()))
            .unwrap_or(0);
        if count < config.threshold {
            return Err(Error::ThresholdNotReached);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        MarketCoreClient::new(&env, &market_core).resolve(&market_id, &proposal.outcome);
        env.storage()
            .persistent()
            .set(&DataKey::State(market_id), &ResolutionState::Finalized);
        ResolutionFinalized {
            market_id,
            outcome: proposal.outcome.clone(),
            finalized_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(proposal.outcome)
    }

    pub fn state(env: Env, market_id: u64) -> ResolutionState {
        Self::resolution_state(&env, market_id)
    }
}

impl Resolver {
    fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
    ) -> Result<V, Error> {
        env.storage()
            .instance()
            .get(&key)
            .ok_or(Error::NotInitialized)
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = Self::instance_get(env, DataKey::Admin)?;
        admin.require_auth();
        Ok(())
    }

    fn load<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
    ) -> Result<V, Error> {
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotConfigured)
    }

    fn resolution_state(env: &Env, market_id: u64) -> ResolutionState {
        env.storage()
            .persistent()
            .get(&DataKey::State(market_id))
            .unwrap_or(ResolutionState::Unconfigured)
    }

    fn is_signer(signers: &Vec<Address>, signer: &Address) -> bool {
        for candidate in signers.iter() {
            if candidate == *signer {
                return true;
            }
        }
        false
    }

    fn assert_unconfigured(env: &Env, market_id: u64) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::Price(market_id))
            || env.storage().persistent().has(&DataKey::Signers(market_id))
        {
            return Err(Error::MarketAlreadyConfigured);
        }
        Ok(())
    }

    /// Verifies `spec` hashes to the market's `resolution_hash` commitment.
    fn assert_matches_commitment(
        env: &Env,
        market_id: u64,
        spec: &ResolutionSpec,
    ) -> Result<(), Error> {
        let market_core: Address = Self::instance_get(env, DataKey::MarketCore)?;
        let market = MarketCoreClient::new(env, &market_core).get_market(&market_id);
        let bytes = spec.clone().to_xdr(env);
        let hash: BytesN<32> = env.crypto().sha256(&bytes).into();
        if hash != market.resolution_hash {
            return Err(Error::SpecHashMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use market_core::{Category, MarketStatus};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        BytesN, IntoVal,
    };

    #[contract]
    struct MockReflector;

    #[contractimpl]
    impl MockReflector {
        pub fn set_price(env: Env, price: i128, timestamp: u64) {
            env.storage()
                .instance()
                .set(&0u32, &PriceData { price, timestamp });
        }

        pub fn price(env: Env, _asset: OracleAsset, _timestamp: u64) -> Option<PriceData> {
            env.storage().instance().get(&0u32)
        }
    }

    struct Fixture {
        env: Env,
        admin: Address,
        resolver: ResolverClient<'static>,
        resolver_id: Address,
        market_core: MarketCoreClient<'static>,
        market_id: u64,
        signer_a: Address,
        signer_b: Address,
        reflector_id: Address,
        spec: ResolutionSpec,
    }

    /// Builds a market whose `resolution_hash` commits to whatever
    /// `ResolutionSpec` the closure returns, mirroring the real flow: the
    /// creator decides the resolution rule up front, then it is revealed
    /// later via `register_price_spec` / `register_signer_spec`.
    fn fixture(
        spec_fn: impl FnOnce(&Env, &Address, &Address, &Address) -> ResolutionSpec,
    ) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let signer_a = Address::generate(&env);
        let signer_b = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver_id = Address::generate(&env);
        let reflector_id = env.register(MockReflector, ());

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = StellarAssetClient::new(&env, &collateral.address());
        token.mint(&creator, &(1_000 * 10_000_000_i128));

        let spec = spec_fn(&env, &reflector_id, &signer_a, &signer_b);
        let resolution_hash: BytesN<32> = env.crypto().sha256(&spec.clone().to_xdr(&env)).into();

        let market_core_id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral.address(),
                treasury.clone(),
                resolver_id.clone(),
                100u32,
            ),
        );
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        let market_id = market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &resolution_hash,
            &soroban_sdk::String::from_str(&env, "ipfs://resolver-test"),
            &Category::Crypto,
            &2_000,
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        env.register_at(
            &resolver_id,
            Resolver,
            ResolverArgs::__constructor(&admin, &market_core_id),
        );
        let resolver = ResolverClient::new(&env, &resolver_id);

        Fixture {
            env,
            admin,
            resolver,
            resolver_id,
            market_core,
            market_id,
            signer_a,
            signer_b,
            reflector_id,
            spec,
        }
    }

    fn price_spec(env: &Env, reflector: &Address) -> PriceConfig {
        PriceConfig {
            reflector: reflector.clone(),
            asset: OracleAsset::Other(Symbol::new(env, "XLM")),
            threshold: 2_000,
            direction: PriceDirection::Above,
            max_staleness: 10,
        }
    }

    fn signer_spec(env: &Env, a: &Address, b: &Address) -> SignerConfig {
        SignerConfig {
            signers: Vec::from_array(env, [a.clone(), b.clone()]),
            threshold: 2,
            dispute_window: 100,
        }
    }

    #[test]
    fn price_mode_resolves_from_historical_reflector_price() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);
        reflector.set_price(&2_500_i128, &1_999_u64);

        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    #[test]
    fn signer_mode_requires_threshold_and_waits_for_dispute_window() {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_signer_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        f.resolver.attest(&f.market_id, &f.signer_a, &Outcome::No);
        f.resolver.attest(&f.market_id, &f.signer_b, &Outcome::No);

        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(f.resolver.finalize_signers(&f.market_id), Outcome::No);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::No)
        );
    }

    #[test]
    fn rejects_revealed_spec_with_wrong_commitment() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let ResolutionSpec::Price(mut wrong_spec) = f.spec.clone() else {
            unreachable!()
        };
        wrong_spec.threshold = 9_999;

        assert_eq!(
            f.resolver
                .try_register_price_spec(&f.market_id, &wrong_spec),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    #[test]
    fn rejects_re_registering_an_already_configured_market() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        assert_eq!(
            f.resolver.try_register_price_spec(&f.market_id, &spec),
            Err(Ok(Error::MarketAlreadyConfigured))
        );
    }

    #[test]
    fn guardian_can_cancel_a_disputed_proposal() {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_signer_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);
        f.resolver.attest(&f.market_id, &f.signer_a, &Outcome::No);
        f.resolver.attest(&f.market_id, &f.signer_b, &Outcome::No);

        f.resolver.cancel_proposal(&f.market_id);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
    }

    #[test]
    fn wrong_caller_cannot_use_guardian_functions() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let not_admin = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .resolver
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.resolver_id,
                    fn_name: "guardian_void_market",
                    args: (f.market_id,).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_guardian_void_market(&f.market_id)
            .is_err());
        let _ = f.admin;
    }
}
