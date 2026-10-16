#![no_std]

pub mod ttl;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    String,
};

/// Rolling window for trace entries, unchanged from the pre-#16 policy:
/// 60 days, extended at half that. Registration (`Agent`) instead uses
/// `ttl::long_lived_target` and is refreshed by every `publish_trace`.
const TRACE_TARGET: u32 = 60 * ttl::DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Trace {
    pub market_id: u64,
    pub agent: Address,
    pub action: String,
    pub trace_hash: BytesN<32>,
    pub ipfs_cid: String,
    pub published_at: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    NextId,
    Agent(Address),
    Trace(u64),
    /// Number of traces published for a market, so a client can page through
    /// `MarketTrace(market_id, 0..count)` without the contract ever holding
    /// an unbounded Vec of trace ids in one storage entry.
    MarketTraceCount(u64),
    MarketTrace(u64, u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    AgentAlreadyRegistered = 3,
    AgentNotRegistered = 4,
    TraceNotFound = 5,
    EmptyAction = 6,
    EmptyCid = 7,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRegistered {
    #[topic]
    pub agent: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TracePublished {
    #[topic]
    pub trace_id: u64,
    #[topic]
    pub market_id: u64,
    #[topic]
    pub agent: Address,
    pub action: String,
    pub trace_hash: BytesN<32>,
    pub ipfs_cid: String,
    pub published_at: u64,
}

#[contract]
pub struct ReasoningRegistry;

#[contractimpl]
impl ReasoningRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    pub fn register_agent(env: Env, agent: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let key = DataKey::Agent(agent.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AgentAlreadyRegistered);
        }
        env.storage().persistent().set(&key, &true);
        ttl::bump_persistent(&env, &key, ttl::long_lived_target(&env));
        AgentRegistered { agent }.publish(&env);
        Ok(())
    }

    pub fn unregister_agent(env: Env, agent: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let key = DataKey::Agent(agent);
        if !env.storage().persistent().has(&key) {
            return Err(Error::AgentNotRegistered);
        }
        env.storage().persistent().remove(&key);
        Ok(())
    }

    /// Read-only view: no TTL writes, so an indexer's simulation stays cheap.
    /// The `Agent` entry is refreshed by `register_agent`/`publish_trace`.
    pub fn is_registered(env: Env, agent: Address) -> bool {
        env.storage().persistent().has(&DataKey::Agent(agent))
    }

    pub fn publish_trace(
        env: Env,
        agent: Address,
        market_id: u64,
        action: String,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        let agent_key = DataKey::Agent(agent.clone());
        if !env.storage().persistent().has(&agent_key) {
            return Err(Error::AgentNotRegistered);
        }
        // A long-running agent is refreshed here: without this, 60+ days of
        // publishing would archive its registration and `publish_trace`
        // would fail with `AgentNotRegistered`.
        ttl::bump_persistent(&env, &agent_key, ttl::long_lived_target(&env));
        if action.is_empty() {
            return Err(Error::EmptyAction);
        }
        if ipfs_cid.is_empty() {
            return Err(Error::EmptyCid);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        let trace = Trace {
            market_id,
            agent: agent.clone(),
            action: action.clone(),
            trace_hash: trace_hash.clone(),
            ipfs_cid: ipfs_cid.clone(),
            published_at: env.ledger().timestamp(),
        };
        let key = DataKey::Trace(id);
        env.storage().persistent().set(&key, &trace);
        ttl::bump_persistent(&env, &key, TRACE_TARGET);

        let count_key = DataKey::MarketTraceCount(market_id);
        let index: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let trace_key = DataKey::MarketTrace(market_id, index);
        env.storage().persistent().set(&trace_key, &id);
        ttl::bump_persistent(&env, &trace_key, TRACE_TARGET);
        env.storage().persistent().set(&count_key, &(index + 1));
        ttl::bump_persistent(&env, &count_key, TRACE_TARGET);

        TracePublished {
            trace_id: id,
            market_id,
            agent,
            action,
            trace_hash,
            ipfs_cid,
            published_at: trace.published_at,
        }
        .publish(&env);
        Ok(id)
    }

    /// Extends `Trace` on read, as before (a write in a view: simulation
    /// footprints are read-write, kept for compatibility and noted in
    /// `docs/architecture.md`).
    pub fn get_trace(env: Env, trace_id: u64) -> Result<Trace, Error> {
        let key = DataKey::Trace(trace_id);
        let trace: Trace = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TraceNotFound)?;
        ttl::bump_persistent(&env, &key, TRACE_TARGET);
        Ok(trace)
    }

    pub fn verify_trace(env: Env, trace_id: u64, received_hash: BytesN<32>) -> Result<bool, Error> {
        let trace = Self::get_trace(env, trace_id)?;
        Ok(trace.trace_hash == received_hash)
    }

    /// Reads the instance's `NextId`; the bump keeps the instance (and with
    /// it the whole contract) alive under view-only traffic.
    pub fn trace_count(env: Env) -> u64 {
        ttl::bump_instance(&env);
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    /// Number of traces published for `market_id`.
    pub fn market_trace_count(env: Env, market_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::MarketTraceCount(market_id))
            .unwrap_or(0)
    }

    /// The `index`-th (0-based, publish order) trace id for `market_id`.
    pub fn market_trace_at(env: Env, market_id: u64, index: u64) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::MarketTrace(market_id, index))
            .ok_or(Error::TraceNotFound)
    }
}

impl ReasoningRegistry {
    fn require_admin(env: &Env) -> Result<(), Error> {
        ttl::bump_instance(env);
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{
            storage::{Instance as _, Persistent as _},
            Address as _, Ledger, MockAuth, MockAuthInvoke,
        },
        IntoVal,
    };

    fn setup() -> (Env, ReasoningRegistryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let contract_id = env.register(
            ReasoningRegistry,
            ReasoningRegistryArgs::__constructor(&admin),
        );
        let client = ReasoningRegistryClient::new(&env, &contract_id);
        (env, client, admin, agent)
    }

    #[test]
    fn registered_agent_can_publish_and_buyer_can_verify_hash() {
        let (env, client, admin, agent) = setup();
        client.register_agent(&agent);

        let trace_hash = BytesN::from_array(&env, &[7u8; 32]);
        let trace_id = client.publish_trace(
            &agent,
            &42,
            &String::from_str(&env, "trade"),
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-42"),
        );

        assert_eq!(trace_id, 0);
        assert_eq!(client.trace_count(), 1);
        assert!(client.verify_trace(&trace_id, &trace_hash));
        assert!(!client.verify_trace(&trace_id, &BytesN::from_array(&env, &[8u8; 32]),));

        let trace = client.get_trace(&trace_id);
        assert_eq!(trace.market_id, 42);
        assert_eq!(trace.agent, agent);
        assert_eq!(trace.action, String::from_str(&env, "trade"));
        assert_eq!(trace.ipfs_cid, String::from_str(&env, "ipfs://trace-42"));
        assert!(client.is_registered(&agent));

        client.unregister_agent(&agent);
        assert!(!client.is_registered(&agent));
        let _ = admin;
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn unregistered_agent_cannot_publish() {
        let (env, client, _, agent) = setup();
        client.publish_trace(
            &agent,
            &1,
            &String::from_str(&env, "pass"),
            &BytesN::from_array(&env, &[1u8; 32]),
            &String::from_str(&env, "ipfs://unauthorized"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn unknown_trace_cannot_be_verified() {
        let (env, client, _, _) = setup();
        client.verify_trace(&99, &BytesN::from_array(&env, &[0u8; 32]));
    }

    #[test]
    fn traces_are_indexed_per_market() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let t0 = client.publish_trace(
            &agent,
            &7,
            &String::from_str(&env, "create_market"),
            &BytesN::from_array(&env, &[1u8; 32]),
            &String::from_str(&env, "ipfs://t0"),
        );
        let t1 = client.publish_trace(
            &agent,
            &7,
            &String::from_str(&env, "trade"),
            &BytesN::from_array(&env, &[2u8; 32]),
            &String::from_str(&env, "ipfs://t1"),
        );
        // A trace on a different market must not appear in market 7's index.
        client.publish_trace(
            &agent,
            &8,
            &String::from_str(&env, "trade"),
            &BytesN::from_array(&env, &[3u8; 32]),
            &String::from_str(&env, "ipfs://t2"),
        );

        assert_eq!(client.market_trace_count(&7), 2);
        assert_eq!(client.market_trace_at(&7, &0), t0);
        assert_eq!(client.market_trace_at(&7, &1), t1);
        assert_eq!(client.market_trace_count(&8), 1);
    }

    #[test]
    fn wrong_caller_cannot_register_agents() {
        let (env, client, _, agent) = setup();
        let not_admin = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "register_agent",
                    args: (agent.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_agent(&agent)
            .is_err());
    }

    #[test]
    fn agent_cannot_publish_trace_impersonating_another_agent() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let impostor = Address::generate(&env);
        env.set_auths(&[]);
        // `impostor` authorizes itself, but the call claims `agent` published
        // the trace; only `agent`'s own signature may satisfy that.
        assert!(client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "publish_trace",
                    args: (
                        agent.clone(),
                        1u64,
                        String::from_str(&env, "trade"),
                        BytesN::from_array(&env, &[9u8; 32]),
                        String::from_str(&env, "ipfs://impostor"),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_publish_trace(
                &agent,
                &1,
                &String::from_str(&env, "trade"),
                &BytesN::from_array(&env, &[9u8; 32]),
                &String::from_str(&env, "ipfs://impostor"),
            )
            .is_err());
    }

    fn advance_ledgers(env: &Env, secs: u64) {
        assert_eq!(secs % ttl::LEDGER_SECS, 0);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + (secs / ttl::LEDGER_SECS) as u32);
        env.ledger().set_timestamp(env.ledger().timestamp() + secs);
    }

    fn persistent_ttl(env: &Env, contract: &Address, key: &DataKey) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(key))
    }

    fn instance_ttl(env: &Env, contract: &Address) -> u32 {
        env.as_contract(contract, || env.storage().instance().get_ttl())
    }

    fn publish_trace_at_day(
        client: &ReasoningRegistryClient,
        env: &Env,
        agent: &Address,
        day: u64,
    ) {
        let trace_hash = BytesN::from_array(env, &[day as u8; 32]);
        let cid = String::from_str(env, "ipfs://publish-refresh");
        client.publish_trace(
            agent,
            &(100 + day),
            &String::from_str(env, "trade"),
            &trace_hash,
            &cid,
        );
    }

    #[test]
    fn agent_entry_extended_on_publish() {
        let (env, client, _, agent) = setup();
        let max_ttl = 3_110_400u32;
        env.ledger().set_max_entry_ttl(max_ttl);
        env.ledger().set_min_persistent_entry_ttl(4_096);
        let agent_key = DataKey::Agent(agent.clone());

        client.register_agent(&agent);
        assert!(persistent_ttl(&env, &client.address, &agent_key) >= max_ttl - 1);

        // Day 0 and day 59 publishes; the day-100 publish only succeeds if the
        // registration was not archived in between (it would be past the old
        // 60-day window with no `Agent` extension on publish).
        publish_trace_at_day(&client, &env, &agent, 0);
        advance_ledgers(&env, 59 * ttl::DAY_SECS);
        publish_trace_at_day(&client, &env, &agent, 59);

        advance_ledgers(&env, 41 * ttl::DAY_SECS);
        let before = persistent_ttl(&env, &client.address, &agent_key);
        assert!(before < max_ttl / 2, "refresh was already due at day 100");
        assert!(client.is_registered(&agent));

        publish_trace_at_day(&client, &env, &agent, 100);
        assert!(
            persistent_ttl(&env, &client.address, &agent_key) >= max_ttl - 1,
            "publish_trace did not refresh the Agent entry"
        );
        assert_eq!(instance_ttl(&env, &client.address), ttl::INSTANCE_TARGET);
    }
}
