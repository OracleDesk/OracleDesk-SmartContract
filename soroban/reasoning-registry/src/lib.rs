#![no_std]

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env, String};

const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

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
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
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
        agent.require_auth();
        if !env.storage().persistent().has(&DataKey::Agent(agent.clone())) {
            return Err(Error::AgentNotRegistered);
        }
        if action.len() == 0 {
            return Err(Error::EmptyAction);
        }
        if ipfs_cid.len() == 0 {
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
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);

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

    pub fn get_trace(env: Env, trace_id: u64) -> Result<Trace, Error> {
        let key = DataKey::Trace(trace_id);
        let trace: Trace = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TraceNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(trace)
    }

    pub fn verify_trace(env: Env, trace_id: u64, received_hash: BytesN<32>) -> Result<bool, Error> {
        let trace = Self::get_trace(env, trace_id)?;
        Ok(trace.trace_hash == received_hash)
    }

    pub fn trace_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }
}

impl ReasoningRegistry {
    fn require_admin(env: &Env) -> Result<(), Error> {
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
        testutils::Address as _,
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
        assert!(!client.verify_trace(
            &trace_id,
            &BytesN::from_array(&env, &[8u8; 32]),
        ));

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
}
