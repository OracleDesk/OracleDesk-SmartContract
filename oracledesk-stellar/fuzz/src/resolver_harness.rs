//! Shared world builder for the resolver fuzz targets (issue #278).
//!
//! Both contracts are registered **natively** (`market_core::MarketCore`,
//! `resolver::Resolver`), like `fuzz_market_core_sequence`, so the host does
//! not instantiate wasm for every input. Auth is never mocked globally: the
//! admin setup runs under `mock_all_auths` and is then cleared, and every
//! later call that needs a signature mocks exactly that one invocation (see
//! [`World::auth`]). `submit_signatures` needs no auth at all: the Ed25519
//! signatures carry the authority.

use ed25519_dalek::{Signer, SigningKey};
use market_core::{Category, MarketCore, MarketCoreArgs, MarketCoreClient};
use resolver::{
    legacy_spec_hash, CommitteeRef, Outcome, Resolver, ResolverArgs, ResolverClient,
    ResolutionSpec, WeightedKey, WeightedKeyConfig,
};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Val, Vec,
};

/// Network id every world runs on (`sha256` of an arbitrary passphrase).
pub const NETWORK_ID: [u8; 32] = [7u8; 32];
/// Market close time; worlds start exactly at close so attestations are
/// accepted from the first op.
pub const CLOSE_TIME: u64 = 2_000;
/// Domain tag of the weighted-key attestation message (`ATTEST_DOMAIN` in
/// contracts/resolver/src/lib.rs).
pub const ATTEST_DOMAIN: &[u8] = b"oracledesk-attest-v1";
/// Dispute window of every weighted / committee spec the targets build.
pub const DISPUTE_WINDOW: u64 = 100;
/// Hard cap on ops per input (issue #278).
pub const MAX_OPS: usize = 24;
/// Size of the key / address pools.
pub const POOL: usize = 8;
/// Seed offset for keys that are never committee members (`NonMember`).
pub const NON_MEMBER_SEED: u8 = 100;

pub struct World {
    pub env: Env,
    pub core: Address,
    pub resolver: Address,
    pub admin: Address,
    /// Funded market creator.
    pub creator: Address,
    /// Deterministic Ed25519 keys, seeds `1..=8`.
    pub keys: [SigningKey; POOL],
    /// Plain addresses for committee members, index-aligned with `keys`.
    pub members: [Address; POOL],
    pub market_id: u64,
}

/// Rotation bounds of a committee market (`CommitteeRef` minus the id).
#[derive(Clone, Copy, Debug)]
pub struct CommitteeRefParams {
    pub min_epoch: u32,
    pub max_rotation_delta: u32,
    pub dispute_window: u64,
}

pub fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

pub fn pubkey(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, key.verifying_key().as_bytes())
}

impl World {
    /// Env, collateral, market-core and a resolver wired to each other, plus
    /// one market committing to `rule` (or to `commitment` when given).
    pub fn new(rule_for: impl FnOnce(&Env, &Address) -> (ResolutionSpec, BytesN<32>)) -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.ledger().set_timestamp(1_000);
        env.ledger().set_network_id(NETWORK_ID);
        env.cost_estimate().budget().reset_unlimited();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver = Address::generate(&env);
        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        StellarAssetClient::new(&env, &collateral.address())
            .mint(&creator, &(1_000 * 10_000_000_i128));
        let core = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                &admin,
                &collateral.address(),
                &treasury,
                &resolver,
                &100u32,
                &10_000u32,
            ),
        );
        let (_rule, commitment) = rule_for(&env, &core);
        let market_id = MarketCoreClient::new(&env, &core).create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &commitment,
            &String::from_str(&env, "ipfs://fuzz"),
            &Category::Crypto,
            &CLOSE_TIME,
            &(100 * 10_000_000_i128),
            &5_000u32,
        );
        env.register_at(
            &resolver,
            Resolver,
            ResolverArgs::__constructor(&admin, &core),
        );
        let keys: [SigningKey; POOL] = core::array::from_fn(|i| signing_key(i as u8 + 1));
        let members: [Address; POOL] = core::array::from_fn(|_| Address::generate(&env));
        // Admin setup done: from here on every auth is mocked per call.
        env.set_auths(&[]);
        Self {
            env,
            core,
            resolver,
            admin,
            creator,
            keys,
            members,
            market_id,
        }
    }

    pub fn client(&self) -> ResolverClient<'_> {
        ResolverClient::new(&self.env, &self.resolver)
    }

    /// Mocks exactly one invocation of `fn_name(args)` on the resolver by
    /// `who`; the next call consumes it.
    pub fn auth(&self, who: &Address, fn_name: &str, args: Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.resolver,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    /// Creates another market (same parameters) committing to `commitment`.
    pub fn create_market_committing(&self, commitment: &BytesN<32>) -> u64 {
        self.env.mock_all_auths();
        let id = MarketCoreClient::new(&self.env, &self.core).create_market(
            &self.creator,
            &BytesN::from_array(&self.env, &[43u8; 32]),
            commitment,
            &String::from_str(&self.env, "ipfs://fuzz"),
            &Category::Crypto,
            &CLOSE_TIME,
            &(100 * 10_000_000_i128),
            &5_000u32,
        );
        self.env.set_auths(&[]);
        id
    }

    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    pub fn advance(&self, secs: u64) {
        self.env.ledger().set_timestamp(self.now().saturating_add(secs));
    }

    pub fn resolution_hash(&self) -> BytesN<32> {
        MarketCoreClient::new(&self.env, &self.core)
            .get_market(&self.market_id)
            .resolution_hash
    }
}

/// Which part of the attestation message a forged signature changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Real,
    /// A different domain tag (same length).
    Tag,
    /// A different network id.
    Network,
    /// A different resolver address.
    Resolver,
}

/// Local copy of `Resolver::attestation_message`:
/// `ATTEST_DOMAIN || network_id || resolver.to_xdr() || market_id (BE) ||
/// round (BE) || outcome byte (Yes 0, No 1) || resolution_hash`.
/// `attestation_layout_matches` proves it equal to the contract's.
pub fn message(w: &World, round: u32, outcome: Outcome, domain: Domain) -> Bytes {
    let env = &w.env;
    let mut tag = ATTEST_DOMAIN.to_vec();
    if domain == Domain::Tag {
        tag[ATTEST_DOMAIN.len() - 1] ^= 0x01;
    }
    let mut network = NETWORK_ID;
    if domain == Domain::Network {
        network[0] ^= 0xff;
    }
    let resolver = if domain == Domain::Resolver {
        w.core.clone()
    } else {
        w.resolver.clone()
    };
    let mut m = Bytes::from_slice(env, &tag);
    m.append(&Bytes::from_array(env, &network));
    m.append(&resolver.to_xdr(env));
    m.extend_from_array(&w.market_id.to_be_bytes());
    m.extend_from_array(&round.to_be_bytes());
    m.push_back(match outcome {
        Outcome::Yes => 0,
        Outcome::No => 1,
    });
    m.append(&Bytes::from_array(env, &w.resolution_hash().to_array()));
    m
}

fn to_vec(b: &Bytes) -> std::vec::Vec<u8> {
    let mut out = std::vec![0u8; b.len() as usize];
    b.copy_into_slice(&mut out);
    out
}

/// Signs `message` with `key`.
pub fn sign_bytes(w: &World, key: &SigningKey, message: &Bytes) -> (BytesN<32>, BytesN<64>) {
    let sig = key.sign(&to_vec(message)).to_bytes();
    (pubkey(&w.env, key), BytesN::from_array(&w.env, &sig))
}

/// A valid weighted-key signature of `outcome` in `round` by pool key `key`.
pub fn sign(w: &World, key: u8, round: u32, outcome: Outcome) -> (BytesN<32>, BytesN<64>) {
    let k = &w.keys[key as usize % POOL];
    sign_bytes(w, k, &message(w, round, outcome, Domain::Real))
}

/// Weighted config over pool keys: `(key index, weight)`. Indices may
/// repeat and weights may be 0 so invalid configs are reachable.
pub fn weighted_config(env: &Env, keys: &[SigningKey; POOL], entries: &[(u8, u8)], threshold: u16) -> WeightedKeyConfig {
    let mut signers = Vec::new(env);
    for (k, weight) in entries {
        signers.push_back(WeightedKey {
            pubkey: pubkey(env, &keys[*k as usize % POOL]),
            weight: *weight as u32,
        });
    }
    WeightedKeyConfig {
        signers,
        weight_threshold: threshold as u32,
        dispute_window: DISPUTE_WINDOW,
    }
}

/// A world whose market commits to `cfg` (built from pool keys by
/// `make_cfg`). The spec is **not** registered: the target compares the
/// registration result with its own validity model first.
pub fn world_with_weighted(
    make_cfg: impl FnOnce(&Env, &[SigningKey; POOL]) -> WeightedKeyConfig,
) -> (World, WeightedKeyConfig) {
    let keys: [SigningKey; POOL] = core::array::from_fn(|i| signing_key(i as u8 + 1));
    let mut cfg_out = None;
    let w = World::new(|env, _core| {
        let cfg = make_cfg(env, &keys);
        let rule = ResolutionSpec::WeightedKeys(cfg.clone());
        let hash = legacy_spec_hash(env, &rule);
        cfg_out = Some(cfg);
        (rule, hash)
    });
    (w, cfg_out.expect("config built"))
}

/// A world with a committee of pool members (`members` are pool indices)
/// and a market committing to a `CommitteeRef` on it. Returns the world and
/// the committee id; `register_committee_spec` is left to the target.
pub fn world_with_committee(
    members: &[u8],
    threshold: u32,
    ref_: CommitteeRefParams,
) -> (World, Result<u64, resolver::Error>, CommitteeRef) {
    // The committee id is deterministic (first committee of a fresh
    // resolver), so the commitment can be computed before it exists.
    let committee_ref = |env: &Env| {
        let _ = env;
        CommitteeRef {
            committee_id: 0,
            min_epoch: ref_.min_epoch,
            max_rotation_delta: ref_.max_rotation_delta,
            dispute_window: ref_.dispute_window,
        }
    };
    let mut spec_out = None;
    let w = World::new(|env, _core| {
        let spec = committee_ref(env);
        let rule = ResolutionSpec::Committee(spec.clone());
        let hash = legacy_spec_hash(env, &rule);
        spec_out = Some(spec);
        (rule, hash)
    });
    let mut list = Vec::new(&w.env);
    for m in members {
        list.push_back(w.members[*m as usize % POOL].clone());
    }
    w.env.mock_all_auths();
    let id = match w.client().try_create_committee(
        &w.admin,
        &list,
        &threshold,
        &resolver::MIN_ROTATION_DELAY,
    ) {
        Ok(Ok(id)) => Ok(id),
        Err(Ok(e)) => Err(e),
        other => panic!("create_committee trapped: {other:?}"),
    };
    w.env.set_auths(&[]);
    (w, id, spec_out.expect("spec built"))
}

/// Byte reader shared by the resolver targets. Every multi-byte value is
/// little-endian; `seed_encoding.rs` writes the same layout.
pub struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }
    pub fn u8(&mut self) -> Option<u8> {
        let v = *self.data.get(self.at)?;
        self.at += 1;
        Some(v)
    }
    pub fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes([self.u8()?, self.u8()?]))
    }
    pub fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes([self.u8()?, self.u8()?, self.u8()?, self.u8()?]))
    }
    pub fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes([
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
        ]))
    }
    pub fn rest(&mut self) -> &'a [u8] {
        let r = &self.data[self.at.min(self.data.len())..];
        self.at = self.data.len();
        r
    }
}

/// Converts a soroban try-call result into `Ok(v)`, `Err(Some(code))` for a
/// contract error, or `Err(None)` for a trap / host error.
pub fn outcome_of<T, C, E>(r: Result<Result<T, C>, Result<E, soroban_sdk::InvokeError>>) -> Result<T, Option<E>> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Err(Ok(e)) => Err(Some(e)),
        Ok(Err(_)) | Err(Err(_)) => Err(None),
    }
}

/// `true` when `ORACLEDESK_FUZZ_ALLOW` lists `finding` (comma-separated).
/// Used only for findings that are tracked with a regression test and a
/// follow-up fix, so CI smoke runs stay green while still exploring past
/// them. Never set it locally when hunting.
pub fn allowed(finding: &str) -> bool {
    std::env::var("ORACLEDESK_FUZZ_ALLOW")
        .map(|v| v.split(',').any(|f| f.trim() == finding))
        .unwrap_or(false)
}

/// Helper for building `Vec<Val>` auth arguments.
pub fn args<T: IntoVal<Env, Vec<Val>>>(env: &Env, t: T) -> Vec<Val> {
    t.into_val(env)
}
