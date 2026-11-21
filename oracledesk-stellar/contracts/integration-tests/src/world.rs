//! One deployed world used by every auth-matrix test.
//!
//! The four wasm-backed contracts are registered from their wasm (the same
//! artifacts `make build` produces); router and timelock use their native
//! contract types because their wasm is not vendored here yet. They are wired
//! exactly as the deploy scripts wire them: market-core knows the resolver and
//! treasury addresses, the resolver knows market-core, and the treasury knows
//! both. The Stellar Asset Contract is the collateral.
//!
//! Setup uses *targeted* `mock_auths`; this crate never calls
//! `mock_all_auths`. The grep guard in `scripts/check-no-mock-all-auths.sh`
//! enforces that.

#![allow(dead_code)]

use crate::{market_core, reasoning_registry, resolver, router, timelock, treasury};
use resolver_contract as resolver_native;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal, Symbol,
};

pub const USDC: i128 = 10_000_000;
pub const SEED: i128 = 100 * USDC;
pub const MARKET_CLOSE: u64 = 2_000;
pub const START_TIME: u64 = 1_000;

/// A native test oracle shaped like the resolver's `ReflectorPrice`
/// interface. It exists only in the integration-test process; the deployable
/// local-network oracle lives in `contracts/test-oracle`.
#[contract]
pub struct MockOracle;

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

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, _asset: OracleAsset, timestamp: u64, price: i128) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "p"), &price);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "t"), &timestamp);
    }

    pub fn price(env: Env, _asset: OracleAsset, timestamp: u64) -> Option<PriceData> {
        let stored: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "t"))
            .unwrap_or(0);
        if stored != timestamp {
            return None;
        }
        Some(PriceData {
            price: env
                .storage()
                .instance()
                .get(&Symbol::new(&env, "p"))
                .unwrap_or(0),
            timestamp: stored,
        })
    }
}

pub struct World {
    pub env: Env,
    pub admin: Address,
    pub agent: Address,
    pub creator: Address,
    pub trader: Address,
    pub signer_a: Address,
    pub signer_b: Address,
    pub random: Address,
    /// Distinct timelock roles; kept on the world so target mocks are exact.
    pub proposer: Address,
    pub canceller: Address,
    pub executor: Address,
    pub emergency: Address,

    pub core_id: Address,
    pub core: market_core::Client<'static>,
    pub resolver_id: Address,
    pub resolver: resolver::Client<'static>,
    pub treasury_id: Address,
    pub treasury: treasury::Client<'static>,
    pub registry_id: Address,
    pub registry: reasoning_registry::Client<'static>,
    pub router_id: Address,
    pub router: router::Client<'static>,
    pub timelock_id: Address,
    pub timelock: timelock::Client<'static>,
    pub collateral: Address,
    pub token: TokenClient<'static>,
    pub oracle_id: Address,

    /// Price-mode market with two signers configured as a fallback? It is
    /// price-only so `resolve_price` exercises the resolver → market-core path.
    pub price_market: u64,
    /// Signer-mode market committed to `signer_a`/`signer_b` with threshold 2.
    pub signer_market: u64,
}

impl World {
    pub fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(START_TIME);
        env.ledger().set_network_id([7u8; 32]);

        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let creator = Address::generate(&env);
        let trader = Address::generate(&env);
        let signer_a = Address::generate(&env);
        let signer_b = Address::generate(&env);
        let random = Address::generate(&env);
        let proposer = Address::generate(&env);
        let canceller = Address::generate(&env);
        let executor = Address::generate(&env);
        let emergency = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let collateral = sac.address();
        let token = TokenClient::new(&env, &collateral);
        fund(&env, &collateral, &admin, &admin, 2_000 * USDC);
        fund(&env, &collateral, &admin, &creator, 1_000 * USDC);
        fund(&env, &collateral, &admin, &trader, 1_000 * USDC);

        let oracle_id = env.register(MockOracle, ());

        let resolver_id = Address::generate(&env);
        let treasury_id = Address::generate(&env);
        let core_id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral.clone(),
                treasury_id.clone(),
                resolver_id.clone(),
                100u32,
                10_000u32,
            ),
        );
        env.register_at(
            &resolver_id,
            resolver::WASM,
            resolver::Args::__constructor(&admin, &core_id),
        );
        let policy = treasury::CreationPolicy {
            max_seed: 200 * USDC,
            max_markets_per_window: 100,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 10_000_000,
            allowed_categories: 0x3F,
        };
        env.register_at(
            &treasury_id,
            treasury::WASM,
            treasury::Args::__constructor(
                &admin,
                &agent,
                &collateral,
                &core_id,
                &(200 * USDC),
                &(1_000 * USDC),
                &(2_000 * USDC),
                &(1_000 * USDC),
                &86_400u64,
                &(10_000 * USDC),
                &7u32,
                &policy,
            ),
        );
        let registry_id = env.register(reasoning_registry::WASM, (admin.clone(),));
        // The router is stateless after construction; the native type is used
        // because this crate does not ship a router.wasm yet.
        let router_id = env.register(
            router::Router,
            (
                core_id.clone(),
                resolver_id.clone(),
                Some(registry_id.clone()),
            ),
        );
        let timelock_id = env.register(
            timelock::Timelock,
            (
                admin.clone(),
                proposer.clone(),
                canceller.clone(),
                Some(executor.clone()),
                Some(emergency.clone()),
                timelock::MIN_DELAY,
            ),
        );

        let core = market_core::Client::new(&env, &core_id);
        let resolver = resolver::Client::new(&env, &resolver_id);
        let treasury = treasury::Client::new(&env, &treasury_id);
        let registry = reasoning_registry::Client::new(&env, &registry_id);
        let router = router::Client::new(&env, &router_id);
        let timelock = timelock::Client::new(&env, &timelock_id);

        // Seed vault shares through the real deposit path. Minting straight to
        // the treasury would leave supply at zero and make NAV per share
        // nonsensical; the auth matrix must exercise the deployable path.
        let deposit_args: soroban_sdk::Vec<soroban_sdk::Val> =
            (admin.clone(), 1_000 * USDC).into_val(&env);
        let deposit_transfer = MockAuthInvoke {
            contract: &collateral,
            fn_name: "transfer",
            args: (admin.clone(), treasury_id.clone(), 1_000 * USDC).into_val(&env),
            sub_invokes: &[],
        };
        treasury
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &treasury_id,
                    fn_name: "deposit",
                    args: deposit_args,
                    sub_invokes: &[deposit_transfer],
                },
            }])
            .deposit(&admin, &(1_000 * USDC));
        env.set_auths(&[]);

        let price_spec = price_spec(&env, &oracle_id);
        let price_hash = resolver_native::legacy_spec_hash(
            &env,
            &resolver_native::ResolutionSpec::Price(price_spec.clone()),
        );
        let price_market = create_market(
            &env,
            &core,
            &collateral,
            &creator,
            price_hash,
            MARKET_CLOSE,
            5_000,
        );
        env.set_auths(&[]);
        resolver.register_price_spec(&price_market, &import_price_spec(&price_spec));

        let signer_spec = signer_spec(&env, &signer_a, &signer_b);
        let signer_hash = resolver_native::legacy_spec_hash(
            &env,
            &resolver_native::ResolutionSpec::Signers(signer_spec.clone()),
        );
        let signer_market = create_market(
            &env,
            &core,
            &collateral,
            &creator,
            signer_hash,
            MARKET_CLOSE,
            5_000,
        );
        env.set_auths(&[]);
        resolver.register_signer_spec(&signer_market, &import_signer_spec(&signer_spec));

        env.set_auths(&[]);
        Self {
            env,
            admin,
            agent,
            creator,
            trader,
            signer_a,
            signer_b,
            random,
            proposer,
            canceller,
            executor,
            emergency,
            core_id,
            core,
            resolver_id,
            resolver,
            treasury_id,
            treasury,
            registry_id,
            registry,
            router_id,
            router,
            timelock_id,
            timelock,
            collateral,
            token,
            oracle_id,
            price_market,
            signer_market,
        }
    }

    /// Register the treasury with a non-zero balance after construction so
    /// `deposit`/`agent_buy` have capital to move. Kept as a separate method
    /// so tests that care about empty-vault accounting can skip it.
    pub fn mint_to(&self, to: &Address, amount: i128) {
        fund(&self.env, &self.collateral, &self.admin, to, amount);
        self.env.set_auths(&[]);
    }

    pub fn set_time(&self, timestamp: u64) {
        self.env.ledger().set_timestamp(timestamp);
    }

    pub fn create_market(&self, close_time: u64, yes_bps: u32) -> u64 {
        self.create_market_with_hash(
            BytesN::from_array(&self.env, &[42u8; 32]),
            close_time,
            yes_bps,
        )
    }

    pub fn create_market_with_hash(
        &self,
        resolution_hash: BytesN<32>,
        close_time: u64,
        yes_bps: u32,
    ) -> u64 {
        self.env.set_auths(&[]);
        let id = create_market(
            &self.env,
            &self.core,
            &self.collateral,
            &self.creator,
            resolution_hash,
            close_time,
            yes_bps,
        );
        self.env.set_auths(&[]);
        id
    }

    pub fn set_oracle_price(&self, timestamp: u64, price: i128) {
        MockOracleClient::new(&self.env, &self.oracle_id).set_price(
            &OracleAsset::Other(Symbol::new(&self.env, "XLM")),
            &timestamp,
            &price,
        );
    }

    pub fn resolve_signer_market(&self) {
        self.set_time(MARKET_CLOSE + 1);
        self.env.set_auths(&[]);
        // Two targeted signer mocks, one per attestation.
        let a_invoke = MockAuthInvoke {
            contract: &self.resolver_id,
            fn_name: "attest",
            args: (
                self.signer_market,
                self.signer_a.clone(),
                resolver::AttestedOutcome::Yes,
            )
                .into_val(&self.env),
            sub_invokes: &[],
        };
        self.resolver
            .mock_auths(&[MockAuth {
                address: &self.signer_a,
                invoke: &a_invoke,
            }])
            .attest(
                &self.signer_market,
                &self.signer_a,
                &resolver::AttestedOutcome::Yes,
            );
        let b_invoke = MockAuthInvoke {
            contract: &self.resolver_id,
            fn_name: "attest",
            args: (
                self.signer_market,
                self.signer_b.clone(),
                resolver::AttestedOutcome::Yes,
            )
                .into_val(&self.env),
            sub_invokes: &[],
        };
        self.resolver
            .mock_auths(&[MockAuth {
                address: &self.signer_b,
                invoke: &b_invoke,
            }])
            .attest(
                &self.signer_market,
                &self.signer_b,
                &resolver::AttestedOutcome::Yes,
            );
        self.set_time(MARKET_CLOSE + 1 + 101);
        self.env.set_auths(&[]);
        self.resolver.finalize_signers(&self.signer_market);
        self.env.set_auths(&[]);
    }
}

pub fn fund(env: &Env, sac: &Address, admin: &Address, to: &Address, amount: i128) {
    env.set_auths(&[]);
    StellarAssetClient::new(env, sac)
        .mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: sac,
                fn_name: "mint",
                args: (to.clone(), amount).into_val(env),
                sub_invokes: &[],
            },
        }])
        .mint(to, &amount);
    env.set_auths(&[]);
}

fn create_market(
    env: &Env,
    core: &market_core::Client,
    collateral: &Address,
    creator: &Address,
    resolution_hash: BytesN<32>,
    close_time: u64,
    yes_bps: u32,
) -> u64 {
    let qh = BytesN::from_array(env, &[1u8; 32]);
    let uri = soroban_sdk::String::from_str(env, "ipfs://matrix");
    let args = (
        creator.clone(),
        qh.clone(),
        resolution_hash.clone(),
        uri.clone(),
        market_core::Category::Crypto,
        close_time,
        SEED,
        yes_bps,
    );
    let transfer = MockAuthInvoke {
        contract: collateral,
        fn_name: "transfer",
        args: (creator.clone(), core.address.clone(), SEED).into_val(env),
        sub_invokes: &[],
    };
    core.mock_auths(&[MockAuth {
        address: creator,
        invoke: &MockAuthInvoke {
            contract: &core.address,
            fn_name: "create_market",
            args: args.into_val(env),
            sub_invokes: &[transfer],
        },
    }])
    .create_market(
        creator,
        &qh,
        &resolution_hash,
        &uri,
        &market_core::Category::Crypto,
        &close_time,
        &SEED,
        &yes_bps,
    )
}

fn price_spec(env: &Env, oracle: &Address) -> resolver_native::PriceConfig {
    resolver_native::PriceConfig {
        reflector: oracle.clone(),
        asset: resolver_native::OracleAsset::Other(Symbol::new(env, "XLM")),
        threshold: 2_000,
        direction: resolver_native::PriceDirection::Above,
        max_staleness: 10,
    }
}

fn signer_spec(env: &Env, a: &Address, b: &Address) -> resolver_native::SignerConfig {
    resolver_native::SignerConfig {
        signers: soroban_sdk::Vec::from_array(env, [a.clone(), b.clone()]),
        threshold: 2,
        dispute_window: 100,
    }
}

fn import_price_spec(spec: &resolver_native::PriceConfig) -> resolver::PriceConfig {
    resolver::PriceConfig {
        reflector: spec.reflector.clone(),
        asset: match &spec.asset {
            resolver_native::OracleAsset::Stellar(a) => resolver::OracleAsset::Stellar(a.clone()),
            resolver_native::OracleAsset::Other(s) => resolver::OracleAsset::Other(s.clone()),
        },
        threshold: spec.threshold,
        direction: match spec.direction {
            resolver_native::PriceDirection::Above => resolver::PriceDirection::Above,
            resolver_native::PriceDirection::AtOrAbove => resolver::PriceDirection::AtOrAbove,
            resolver_native::PriceDirection::Below => resolver::PriceDirection::Below,
            resolver_native::PriceDirection::AtOrBelow => resolver::PriceDirection::AtOrBelow,
        },
        max_staleness: spec.max_staleness,
    }
}

fn import_signer_spec(spec: &resolver_native::SignerConfig) -> resolver::SignerConfig {
    resolver::SignerConfig {
        signers: spec.signers.clone(),
        threshold: spec.threshold,
        dispute_window: spec.dispute_window,
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}
