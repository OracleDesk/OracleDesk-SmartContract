//! Minimal cross-contract interfaces the registry calls (issue #322).
//!
//! The registry used to `contractimport!` a vendored `market_core.wasm` just
//! to call `market_count`/`get_market`. That copy was a third, unpinned build
//! of market-core, and importing the resolver's wasm the same way would
//! create a vendored-wasm cycle (the resolver already imports
//! `reasoning_registry.wasm`). Instead the registry declares the handful of
//! read-only views it needs with `#[contractclient]` and mirrors the return
//! types here.
//!
//! **XDR mirrors.** `#[contracttype]` structs encode as an `ScMap` keyed by
//! field *name*, and decoding requires exactly the same field set, so each
//! mirror below carries every field of the original with the same name and
//! type. Enums encode positionally, so `ResolutionRole` keeps the resolver's
//! variant order. `contracts/integration-tests` decodes real market-core and
//! resolver results with these mirrors, so a drift fails CI.

use oracledesk_types::{Category, MarketStatus};
use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env, String, Vec};

/// Mirror of market-core's `Market` (same field names, same types).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub creator: Address,
    pub question_hash: BytesN<32>,
    pub resolution_hash: BytesN<32>,
    pub meta_uri: String,
    pub category: Category,
    pub close_time: u64,
    pub fee_bps: u32,
    pub status: MarketStatus,
    pub reserve_yes: i128,
    pub reserve_no: i128,
    pub sets_minted: i128,
    pub fees_accrued: i128,
    pub lp_claimed: bool,
}

/// Mirror of market-core's `Config` (same field names, same types).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoreConfig {
    pub admin: Address,
    pub collateral: Address,
    pub treasury: Address,
    pub resolver: Address,
    pub default_fee_bps: u32,
    pub protocol_fee_share_bps: u32,
    pub paused: bool,
}

/// Mirror of the resolver's `ResolutionRole` (same variant order).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolutionRole {
    None,
    Signer,
    CommitteeMember(u32),
    WeightedKey(u32),
    Guardian,
}

#[allow(dead_code)]
#[contractclient(name = "CoreView")]
pub trait CoreViewIface {
    fn market_count(env: Env) -> u64;
    fn get_market(env: Env, market_id: u64) -> Market;
    fn get_config(env: Env) -> CoreConfig;
}

#[allow(dead_code)]
#[contractclient(name = "ResolverView")]
pub trait ResolverViewIface {
    fn resolution_role(
        env: Env,
        market_id: u64,
        who: Address,
        keys: Vec<BytesN<32>>,
    ) -> ResolutionRole;
}
