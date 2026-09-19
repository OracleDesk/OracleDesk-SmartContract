#![no_std]

use market_core::{MarketCoreClient, Outcome};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

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
        env.storage().instance().set(&DataKey::MarketCore, &market_core);
    }

    pub fn configure_price(
        env: Env,
        market_id: u64,
        config: PriceConfig,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if env.storage().persistent().has(&DataKey::Price(market_id))
            || env.storage().persistent().has(&DataKey::Signers(market_id))
        {
            return Err(Error::MarketAlreadyConfigured);
        }
        if config.threshold < 0 || config.max_staleness == 0 {
            return Err(Error::InvalidConfig);
        }
        let key = DataKey::Price(market_id);
        env.storage().persistent().set(&key, &config);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        env.storage().persistent().set(
            &DataKey::State(market_id),
            &ResolutionState::Unconfigured,
        );
        Ok(())
    }

    pub fn configure_signers(
        env: Env,
        market_id: u64,
        signers: Vec<Address>,
        threshold: u32,
        dispute_window: u64,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if env.storage().persistent().has(&DataKey::Price(market_id))
            || env.storage().persistent().has(&DataKey::Signers(market_id))
        {
            return Err(Error::MarketAlreadyConfigured);
        }
        if signers.len() == 0
            || threshold == 0
            || threshold > signers.len()
            || dispute_window == 0
        {
            return Err(Error::InvalidConfig);
        }
        let key = DataKey::Signers(market_id);
        env.storage().persistent().set(&key, &SignerConfig {
            signers,
            threshold,
            dispute_window,
        });
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        env.storage().persistent().set(
            &DataKey::State(market_id),
            &ResolutionState::SignersPending,
        );
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
                if data.price > config.threshold { Outcome::Yes } else { Outcome::No }
            }
            PriceDirection::AtOrAbove => {
                if data.price >= config.threshold { Outcome::Yes } else { Outcome::No }
            }
            PriceDirection::Below => {
                if data.price < config.threshold { Outcome::Yes } else { Outcome::No }
            }
            PriceDirection::AtOrBelow => {
                if data.price <= config.threshold { Outcome::Yes } else { Outcome::No }
            }
        };
        MarketCoreClient::new(&env, &market_core).resolve(&market_id, &outcome);
        env.storage().persistent().set(
            &DataKey::State(market_id),
            &ResolutionState::Finalized,
        );
        PriceResolution {
            market_id,
            price: data.price,
            price_timestamp: data.timestamp,
            outcome,
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
            outcome,
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
            &DataKey::Attestation(market_id, outcome, signer),
            &true,
        );
        let count_key = DataKey::Count(market_id, outcome);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let count = count + 1;
        env.storage().persistent().set(&count_key, &count);
        if count >= config.threshold {
            let proposal = SignerProposal {
                outcome,
                proposed_at: env.ledger().timestamp(),
            };
            env.storage().persistent().set(
                &DataKey::Proposal(market_id),
                &proposal,
            );
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
        let count: u32 = env.storage().persistent()
            .get(&DataKey::Count(market_id, proposal.outcome))
            .unwrap_or(0);
        if count < config.threshold {
            return Err(Error::ThresholdNotReached);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        MarketCoreClient::new(&env, &market_core).resolve(&market_id, &proposal.outcome);
        env.storage().persistent().set(
            &DataKey::State(market_id),
            &ResolutionState::Finalized,
        );
        ResolutionFinalized {
            market_id,
            outcome: proposal.outcome,
            finalized_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(proposal.outcome)
    }

    pub fn state(env: Env, market_id: u64) -> ResolutionState {
        Self::resolution_state(&env, market_id)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use market_core::{Category, MarketCore, MarketCoreArgs, MarketStatus};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger},
        token::StellarAssetClient, BytesN,
    };

    #[contract]
    struct MockReflector;

    #[contractimpl]
    impl MockReflector {
        pub fn set_price(env: Env, price: i128, timestamp: u64) {
            env.storage().instance().set(&0u32, &PriceData { price, timestamp });
        }

        pub fn price(env: Env, _asset: OracleAsset, _timestamp: u64) -> Option<PriceData> {
            env.storage().instance().get(&0u32)
        }
    }

    struct Fixture {
        env: Env,
        resolver: ResolverClient<'static>,
        market_core: MarketCoreClient<'static>,
        market_id: u64,
        signer_a: Address,
        signer_b: Address,
    }

    fn fixture() -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let signer_a = Address::generate(&env);
        let signer_b = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver_id = Address::generate(&env);

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = StellarAssetClient::new(&env, &collateral.address());
        token.mint(&creator, &(1_000 * 10_000_000_i128));

        let market_core_id = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                &admin,
                &collateral.address(),
                &treasury,
                &resolver_id,
                &100u32,
            ),
        );
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        let market_id = market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
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
            resolver,
            market_core,
            market_id,
            signer_a,
            signer_b,
        }
    }

    #[test]
    fn price_mode_resolves_from_historical_reflector_price() {
        let f = fixture();
        let reflector_id = f.env.register(MockReflector, ());
        let reflector = MockReflectorClient::new(&f.env, &reflector_id);
        reflector.set_price(&2_500_i128, &1_999_u64);

        f.resolver.configure_price(
            &f.market_id,
            &PriceConfig {
                reflector: reflector_id,
                asset: OracleAsset::Other(Symbol::new(&f.env, "XLM")),
                threshold: 2_000,
                direction: PriceDirection::Above,
                max_staleness: 10,
            },
        );
        f.env.ledger().set_timestamp(2_000);

        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    #[test]
    fn signer_mode_requires_threshold_and_waits_for_dispute_window() {
        let f = fixture();
        let signers = Vec::from_array(&f.env, [f.signer_a.clone(), f.signer_b.clone()]);
        f.resolver.configure_signers(&f.market_id, &signers, &2, &100);
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
}

impl Resolver {
    fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
    ) -> Result<V, Error> {
        env.storage().instance().get(&key).ok_or(Error::NotInitialized)
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
        env.storage().persistent().get(&key).ok_or(Error::MarketNotConfigured)
    }

    fn resolution_state(env: &Env, market_id: u64) -> ResolutionState {
        env.storage().persistent()
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
}
