#![no_std]

//! Timelock controller for OracleDesk admin roles (#63).
//!
//! Every privileged change to `market-core`, `resolver`, `treasury` and
//! `reasoning-registry` can be routed through this contract: an operator
//! `schedule`s the call, and after `effective_delay` for `(target, fn_name)`
//! has elapsed anyone (or the configured `executor`) can `execute` it.
//!
//! Security properties:
//!
//! * **Replay-safe.** The operation is removed from storage *before* the
//!   target is invoked. A failed target call aborts the whole transaction, so
//!   storage is rolled back and the operation survives; a successful call can
//!   never be replayed because the record is already gone.
//! * **Bounded delay.** Per-target delays and the global floor are clamped to
//!   `[MIN_DELAY, MAX_DELAY]`, so no one can set a zero delay.
//! * **Raising the floor needs the timelock itself.** `set_default_delay` may
//!   only *increase* the floor when `env.invoker()` is this contract, i.e.
//!   from inside `execute` of a previously scheduled self-call. Lowering the
//!   floor stays a normal admin action (it only shortens future waits).
//! * **Emergency allow-list.** `emergency` can only bypass the delay for
//!   `set_paused(true)` and `cancel_proposal`; every other call is rejected,
//!   so the emergency key cannot become an instant admin.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, Env, Symbol,
    TryFromVal, Val, Vec,
};

const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

/// Shortest delay anyone can configure (1 day).
#[cfg(not(feature = "local-short-windows"))]
pub const MIN_DELAY: u64 = 86_400;
#[cfg(feature = "local-short-windows")]
pub const MIN_DELAY: u64 = 30;
/// Longest delay anyone can configure (30 days).
pub const MAX_DELAY: u64 = 30 * 86_400;
/// How long after `eta` a scheduled operation stays executable (7 days).
#[cfg(not(feature = "local-short-windows"))]
pub const EXECUTION_GRACE: u64 = 7 * 86_400;
#[cfg(feature = "local-short-windows")]
pub const EXECUTION_GRACE: u64 = 30;

#[cfg(feature = "local-short-windows")]
soroban_sdk::contractmeta!(key = "oracledesk_build", val = "local-short-windows");
/// How long a pending admin proposal stays acceptable.
pub const ADMIN_TRANSFER_TTL: u64 = 7 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Roles {
    pub proposer: Address,
    pub canceller: Address,
    pub executor: Option<Address>,
    pub emergency: Option<Address>,
}

/// A scheduled call. It exists in storage only while pending; `execute` and
/// `cancel` both remove it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Operation {
    pub proposer: Address,
    pub target: Address,
    pub fn_name: Symbol,
    pub args: Vec<Val>,
    pub eta: u64,
    pub expires: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    PendingAdminAt,
    Roles,
    DefaultDelay,
    Delay(Address, Symbol),
    NextId,
    Op(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    OperationNotFound = 4,
    OperationNotReady = 5,
    OperationExpired = 6,
    OperationNotPending = 7,
    EmergencyNotAllowed = 8,
    DelayOutOfRange = 9,
    FloorRaiseRequiresTimelock = 10,
    NoPendingAdmin = 11,
    AdminTransferExpired = 12,
    /// A scheduled self-call to a function the timelock cannot apply itself.
    SelfCallUnsupported = 13,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationScheduled {
    #[topic]
    pub id: u64,
    pub target: Address,
    pub fn_name: Symbol,
    pub eta: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationExecuted {
    #[topic]
    pub id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationCancelled {
    #[topic]
    pub id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyExecuted {
    pub target: Address,
    pub fn_name: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RolesSet {
    pub proposer: Address,
    pub canceller: Address,
    pub executor: Option<Address>,
    pub emergency: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefaultDelaySet {
    pub delay: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelaySet {
    pub target: Address,
    pub fn_name: Symbol,
    pub delay: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferProposed {
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferred {
    pub old: Address,
    pub new: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferCancelled {}

#[contract]
pub struct Timelock;

#[contractimpl]
impl Timelock {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        proposer: Address,
        canceller: Address,
        executor: Option<Address>,
        emergency: Option<Address>,
        default_delay: u64,
    ) {
        #[cfg(feature = "local-short-windows")]
        {
            let standalone =
                env.crypto().sha256(&Bytes::from_slice(&env, b"Standalone Network ; February 2017"));
            if env.ledger().network_id() != standalone.to_bytes() {
                soroban_sdk::panic_with_error!(&env, Error::InvalidConfig);
            }
        }
        if !(MIN_DELAY..=MAX_DELAY).contains(&default_delay) {
            soroban_sdk::panic_with_error!(&env, Error::InvalidConfig);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(
            &DataKey::Roles,
            &Roles {
                proposer,
                canceller,
                executor,
                emergency,
            },
        );
        s.set(&DataKey::DefaultDelay, &default_delay);
        s.set(&DataKey::NextId, &0u64);
    }

    // ----- scheduling -----------------------------------------------------

    /// Schedules `target.fn_name(args)`. The proposer must hold the proposer
    /// role; the effective delay is the larger of the global floor and any
    /// `(target, fn_name)` override.
    pub fn schedule(
        env: Env,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Result<u64, Error> {
        let roles = Self::roles(env.clone())?;
        roles.proposer.require_auth();

        let delay = Self::effective_delay(&env, &target, &fn_name);
        let now = env.ledger().timestamp();
        let eta = now + delay;
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        let op = Operation {
            proposer: roles.proposer,
            target: target.clone(),
            fn_name: fn_name.clone(),
            args,
            eta,
            expires: eta + EXECUTION_GRACE,
        };
        let key = DataKey::Op(id);
        env.storage().persistent().set(&key, &op);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);

        OperationScheduled {
            id,
            target,
            fn_name,
            eta,
        }
        .publish(&env);
        Ok(id)
    }

    /// Executes a due operation. Callable by the configured `executor`, or by
    /// anyone when `executor` is `None`.
    pub fn execute(env: Env, id: u64) -> Result<(), Error> {
        let op: Operation = Self::load_op(&env, id)?;
        let roles = Self::roles(env.clone())?;
        if let Some(exec) = &roles.executor {
            exec.require_auth();
        }

        let now = env.ledger().timestamp();
        if now < op.eta {
            return Err(Error::OperationNotReady);
        }
        if now > op.expires {
            env.storage().persistent().remove(&DataKey::Op(id));
            return Err(Error::OperationExpired);
        }

        // Remove before invoking: a reverting call rolls back storage and
        // leaves the operation in place, while a successful one cannot replay.
        env.storage().persistent().remove(&DataKey::Op(id));

        if op.target == env.current_contract_address() {
            // Soroban forbids contract re-entry, so a self-call is applied
            // in-process rather than through `invoke_contract`.
            let set_delay = Symbol::new(&env, "set_default_delay");
            if op.fn_name != set_delay {
                return Err(Error::SelfCallUnsupported);
            }
            let delay = u64::try_from_val(&env, &op.args.get_unchecked(0))
                .map_err(|_| Error::InvalidConfig)?;
            Self::apply_default_delay(&env, delay, true)?;
        } else {
            env.invoke_contract::<()>(&op.target, &op.fn_name, op.args);
        }

        OperationExecuted { id }.publish(&env);
        Ok(())
    }

    /// Cancels a pending operation. Only the canceller role may call this.
    pub fn cancel(env: Env, id: u64) -> Result<(), Error> {
        let op: Operation = Self::load_op(&env, id)?;
        let roles = Self::roles(env.clone())?;
        roles.canceller.require_auth();
        let _ = op.proposer;
        env.storage().persistent().remove(&DataKey::Op(id));
        OperationCancelled { id }.publish(&env);
        Ok(())
    }

    /// Bypasses the delay for a small allow-list of safety calls. The
    /// `emergency` role must be configured and hold auth.
    pub fn emergency(
        env: Env,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Result<(), Error> {
        let roles = Self::roles(env.clone())?;
        let emergency = roles.emergency.ok_or(Error::EmergencyNotAllowed)?;
        emergency.require_auth();
        if !Self::is_emergency_allowed(&env, &fn_name, &args) {
            return Err(Error::EmergencyNotAllowed);
        }
        env.invoke_contract::<()>(&target, &fn_name, args);
        EmergencyExecuted { target, fn_name }.publish(&env);
        Ok(())
    }

    // ----- configuration --------------------------------------------------

    /// Sets the roles. Admin action (redirect it through `schedule` in
    /// production so operators cannot silently swap each other).
    pub fn set_roles(
        env: Env,
        proposer: Address,
        canceller: Address,
        executor: Option<Address>,
        emergency: Option<Address>,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(
            &DataKey::Roles,
            &Roles {
                proposer: proposer.clone(),
                canceller: canceller.clone(),
                executor: executor.clone(),
                emergency: emergency.clone(),
            },
        );
        RolesSet {
            proposer,
            canceller,
            executor,
            emergency,
        }
        .publish(&env);
        Ok(())
    }

    /// Sets or clears a `(target, fn_name)` delay override.
    pub fn set_delay(
        env: Env,
        target: Address,
        fn_name: Symbol,
        delay: Option<u64>,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let key = DataKey::Delay(target.clone(), fn_name.clone());
        match delay {
            Some(d) => {
                Self::check_delay_bounds(d)?;
                env.storage().instance().set(&key, &d);
                DelaySet {
                    target,
                    fn_name,
                    delay: d,
                }
                .publish(&env);
            }
            None => {
                env.storage().instance().remove(&key);
            }
        }
        Ok(())
    }

    /// Sets the global delay floor. Increasing it must go through the timelock
    /// itself (schedule a self-call), so an operator cannot quietly extend
    /// every in-flight delay; decreasing it is a normal admin action.
    pub fn set_default_delay(env: Env, delay: u64) -> Result<(), Error> {
        Self::apply_default_delay(&env, delay, false)?;
        DefaultDelaySet { delay }.publish(&env);
        Ok(())
    }

    // ----- admin (two-step, same shape as the other contracts) ------------

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let s = env.storage().instance();
        s.set(&DataKey::PendingAdmin, &new_admin);
        s.set(
            &DataKey::PendingAdminAt,
            &(env.ledger().timestamp() + ADMIN_TRANSFER_TTL),
        );
        AdminTransferProposed { new_admin }.publish(&env);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending = Self::pending_admin_entry(&env)?.ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();
        let old: Address = Self::instance_get(&env, &DataKey::Admin)?;
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &pending);
        s.remove(&DataKey::PendingAdmin);
        s.remove(&DataKey::PendingAdminAt);
        AdminTransferred { old, new: pending }.publish(&env);
        Ok(())
    }

    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if Self::pending_admin_entry(&env)?.is_none() {
            return Err(Error::NoPendingAdmin);
        }
        let s = env.storage().instance();
        s.remove(&DataKey::PendingAdmin);
        s.remove(&DataKey::PendingAdminAt);
        AdminTransferCancelled {}.publish(&env);
        Ok(())
    }

    // ----- views ----------------------------------------------------------

    pub fn admin(env: Env) -> Result<Address, Error> {
        Self::instance_get(&env, &DataKey::Admin)
    }

    pub fn pending_admin(env: Env) -> Option<Address> {
        Self::pending_admin_entry(&env).ok().flatten()
    }

    pub fn roles(env: Env) -> Result<Roles, Error> {
        Self::instance_get(&env, &DataKey::Roles)
    }

    pub fn default_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::DefaultDelay)
            .unwrap_or(MIN_DELAY)
    }

    /// The delay a call to `(target, fn_name)` would wait right now.
    pub fn delay_for(env: Env, target: Address, fn_name: Symbol) -> u64 {
        Self::effective_delay(&env, &target, &fn_name)
    }

    pub fn operation(env: Env, id: u64) -> Option<Operation> {
        env.storage().persistent().get(&DataKey::Op(id))
    }

    pub fn operation_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    // ----- internals ------------------------------------------------------

    fn effective_delay(env: &Env, target: &Address, fn_name: &Symbol) -> u64 {
        let floor = Self::default_delay(env.clone());
        let base = env
            .storage()
            .instance()
            .get::<_, u64>(&DataKey::Delay(target.clone(), fn_name.clone()))
            .unwrap_or_default();
        if base > floor {
            base
        } else {
            floor
        }
    }

    fn is_emergency_allowed(env: &Env, fn_name: &Symbol, args: &Vec<Val>) -> bool {
        if fn_name == &Symbol::new(env, "set_paused") {
            if args.len() != 1 {
                return false;
            }
            let val = args.get_unchecked(0);
            let paused = bool::try_from_val(env, &val).unwrap_or(false);
            return paused;
        }
        fn_name == &Symbol::new(env, "cancel_proposal")
    }

    /// `scheduled` is true when this runs from `execute` for a timelocked
    /// self-call: raising the floor is only allowed then, and no admin auth is
    /// needed because `schedule` already authenticated the proposer.
    fn apply_default_delay(env: &Env, delay: u64, scheduled: bool) -> Result<(), Error> {
        Self::check_delay_bounds(delay)?;
        let current = Self::default_delay(env.clone());
        if delay > current {
            if !scheduled {
                return Err(Error::FloorRaiseRequiresTimelock);
            }
        } else if !scheduled {
            Self::require_admin(env)?;
        }
        env.storage().instance().set(&DataKey::DefaultDelay, &delay);
        Ok(())
    }

    fn check_delay_bounds(delay: u64) -> Result<(), Error> {
        if (MIN_DELAY..=MAX_DELAY).contains(&delay) {
            Ok(())
        } else {
            Err(Error::DelayOutOfRange)
        }
    }

    fn load_op(env: &Env, id: u64) -> Result<Operation, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Op(id))
            .ok_or(Error::OperationNotFound)
    }

    fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
    ) -> Result<V, Error> {
        env.storage()
            .instance()
            .get(key)
            .ok_or(Error::NotInitialized)
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = Self::instance_get(env, &DataKey::Admin)?;
        admin.require_auth();
        Ok(())
    }

    fn pending_admin_entry(env: &Env) -> Result<Option<Address>, Error> {
        let s = env.storage().instance();
        let pending: Option<Address> = s.get(&DataKey::PendingAdmin);
        match pending {
            None => Ok(None),
            Some(p) => {
                let at: u64 = s
                    .get(&DataKey::PendingAdminAt)
                    .ok_or(Error::NoPendingAdmin)?;
                if env.ledger().timestamp() > at {
                    Err(Error::AdminTransferExpired)
                } else {
                    Ok(Some(p))
                }
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
        IntoVal,
    };

    #[contract]
    pub struct MockTarget;

    #[contractimpl]
    impl MockTarget {
        pub fn set_paused(env: Env, paused: bool) {
            env.storage()
                .instance()
                .set(&symbol_short!("paused"), &paused);
        }

        pub fn paused(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("paused"))
                .unwrap_or(false)
        }

        pub fn noop(env: Env, x: u32) -> u32 {
            env.storage().instance().set(&symbol_short!("noop"), &x);
            x
        }

        pub fn cancel_proposal(_env: Env, _market_id: u64, _reason: u32) {}
    }

    #[allow(dead_code)]
    struct Fixture {
        env: Env,
        admin: Address,
        proposer: Address,
        canceller: Address,
        executor: Option<Address>,
        emergency: Option<Address>,
        timelock: TimelockClient<'static>,
        target: MockTargetClient<'static>,
    }

    fn fixture_with(executor: Option<Address>, emergency: bool) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(10_000);
        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let canceller = Address::generate(&env);
        let emergency = if emergency {
            Some(Address::generate(&env))
        } else {
            None
        };
        let target = env.register(MockTarget, ());
        let timelock = env.register(
            Timelock,
            TimelockArgs::__constructor(
                &admin, &proposer, &canceller, &executor, &emergency, &MIN_DELAY,
            ),
        );
        Fixture {
            env: env.clone(),
            admin,
            proposer,
            canceller,
            executor,
            emergency,
            timelock: TimelockClient::new(&env, &timelock),
            target: MockTargetClient::new(&env, &target),
        }
    }

    fn fixture() -> Fixture {
        fixture_with(None, false)
    }

    fn args_bool(env: &Env, value: bool) -> Vec<Val> {
        Vec::from_array(env, [value.into_val(env)])
    }

    #[test]
    fn scheduled_call_executes_after_the_delay() {
        let f = fixture();
        let fn_name = Symbol::new(&f.env, "set_paused");
        let args = args_bool(&f.env, true);
        let id = f.timelock.schedule(&f.target.address, &fn_name, &args);
        assert!(!f.target.paused());

        // Not ready yet.
        assert_eq!(
            f.timelock.try_execute(&id),
            Err(Ok(Error::OperationNotReady))
        );

        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY);
        assert_eq!(f.timelock.delay_for(&f.target.address, &fn_name), MIN_DELAY);
        f.timelock.execute(&id);
        assert!(f.target.paused());
        // Removed, so cannot replay.
        assert_eq!(f.timelock.operation(&id), None);
        assert_eq!(
            f.timelock.try_execute(&id),
            Err(Ok(Error::OperationNotFound))
        );
        assert_eq!(f.timelock.operation_count(), 1);
    }

    #[test]
    fn per_function_delay_override_wins_when_longer() {
        let f = fixture();
        let fn_name = Symbol::new(&f.env, "set_paused");
        f.timelock
            .set_delay(&f.target.address, &fn_name, &Some(MIN_DELAY * 2));
        let args = args_bool(&f.env, true);
        let id = f.timelock.schedule(&f.target.address, &fn_name, &args);
        assert_eq!(
            f.timelock.delay_for(&f.target.address, &fn_name),
            MIN_DELAY * 2
        );
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY);
        assert_eq!(
            f.timelock.try_execute(&id),
            Err(Ok(Error::OperationNotReady))
        );
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY);
        f.timelock.execute(&id);
        assert!(f.target.paused());
    }

    #[test]
    fn expired_operation_cannot_execute() {
        let f = fixture();
        let fn_name = Symbol::new(&f.env, "set_paused");
        let args = args_bool(&f.env, true);
        let id = f.timelock.schedule(&f.target.address, &fn_name, &args);
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY + EXECUTION_GRACE + 1);
        assert_eq!(
            f.timelock.try_execute(&id),
            Err(Ok(Error::OperationExpired))
        );
    }

    #[test]
    fn canceller_can_cancel_a_pending_operation() {
        let f = fixture();
        let fn_name = Symbol::new(&f.env, "set_paused");
        let args = args_bool(&f.env, true);
        let id = f.timelock.schedule(&f.target.address, &fn_name, &args);
        f.timelock.cancel(&id);
        assert_eq!(f.timelock.operation(&id), None);
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY);
        assert_eq!(
            f.timelock.try_execute(&id),
            Err(Ok(Error::OperationNotFound))
        );
        assert!(!f.target.paused());
    }

    #[test]
    fn only_proposer_can_schedule() {
        let f = fixture();
        let attacker = Address::generate(&f.env);
        let fn_name = Symbol::new(&f.env, "set_paused");
        let args = args_bool(&f.env, true);
        f.env.set_auths(&[]);
        assert!(f
            .timelock
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &f.timelock.address,
                    fn_name: "schedule",
                    args: (f.target.address.clone(), fn_name.clone(), args.clone(),)
                        .into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_schedule(&f.target.address, &fn_name, &args)
            .is_err());
    }

    #[test]
    fn executor_role_is_enforced() {
        let env = Env::default();
        let executor = Address::generate(&env);
        let f = fixture_with(Some(executor.clone()), false);

        let fn_name = Symbol::new(&f.env, "set_paused");
        let args = args_bool(&f.env, true);
        let id = f.timelock.schedule(&f.target.address, &fn_name, &args);
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY);

        let attacker = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .timelock
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &f.timelock.address,
                    fn_name: "execute",
                    args: (id,).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_execute(&id)
            .is_err());
        assert!(!f.target.paused());
    }

    #[test]
    fn emergency_only_allows_pause_true_and_cancel_proposal() {
        let f = fixture_with(None, true);
        let fn_name = Symbol::new(&f.env, "set_paused");

        // set_paused(true) is allowed, instantly.
        f.timelock
            .emergency(&f.target.address, &fn_name, &args_bool(&f.env, true));
        assert!(f.target.paused());

        // set_paused(false) is not.
        assert_eq!(
            f.timelock
                .try_emergency(&f.target.address, &fn_name, &args_bool(&f.env, false)),
            Err(Ok(Error::EmergencyNotAllowed))
        );

        // cancel_proposal is allowed.
        let cancel_args = Vec::from_array(&f.env, [7u64.into_val(&f.env), 1u32.into_val(&f.env)]);
        f.timelock.emergency(
            &f.target.address,
            &Symbol::new(&f.env, "cancel_proposal"),
            &cancel_args,
        );

        // Anything else is not, even from the emergency address.
        let noop_args = Vec::from_array(&f.env, [5u32.into_val(&f.env)]);
        assert_eq!(
            f.timelock
                .try_emergency(&f.target.address, &symbol_short!("noop"), &noop_args),
            Err(Ok(Error::EmergencyNotAllowed))
        );
    }

    #[test]
    fn no_emergency_role_means_no_emergency_calls() {
        let f = fixture();
        assert_eq!(
            f.timelock.try_emergency(
                &f.target.address,
                &Symbol::new(&f.env, "set_paused"),
                &args_bool(&f.env, true)
            ),
            Err(Ok(Error::EmergencyNotAllowed))
        );
    }

    #[test]
    fn raising_the_floor_requires_a_timelocked_self_call() {
        let f = fixture();
        let higher = MIN_DELAY * 2;

        // Direct admin call is rejected.
        assert_eq!(
            f.timelock.try_set_default_delay(&higher),
            Err(Ok(Error::FloorRaiseRequiresTimelock))
        );

        // Scheduled self-call works.
        let fn_name = Symbol::new(&f.env, "set_default_delay");
        let args = Vec::from_array(&f.env, [higher.into_val(&f.env)]);
        let id = f.timelock.schedule(&f.timelock.address, &fn_name, &args);
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + MIN_DELAY);
        f.timelock.execute(&id);
        assert_eq!(f.timelock.default_delay(), higher);

        // Lowering is a plain admin call.
        f.timelock.set_default_delay(&MIN_DELAY);
        assert_eq!(f.timelock.default_delay(), MIN_DELAY);
    }

    #[test]
    fn delays_outside_the_bounds_are_rejected() {
        let f = fixture();
        assert_eq!(
            f.timelock.try_set_default_delay(&(MIN_DELAY - 1)),
            Err(Ok(Error::DelayOutOfRange))
        );
        assert_eq!(
            f.timelock
                .try_set_delay(&f.target.address, &symbol_short!("noop"), &Some(0)),
            Err(Ok(Error::DelayOutOfRange))
        );
    }

    #[test]
    fn two_step_admin_transfer() {
        let f = fixture();
        let new_admin = Address::generate(&f.env);
        assert_eq!(f.timelock.admin(), f.admin);
        f.timelock.propose_admin(&new_admin);
        assert_eq!(f.timelock.pending_admin(), Some(new_admin.clone()));
        f.timelock.accept_admin();
        assert_eq!(f.timelock.admin(), new_admin);
        assert_eq!(f.timelock.pending_admin(), None);
    }

    #[test]
    fn expired_admin_transfer_cannot_be_accepted() {
        let f = fixture();
        let new_admin = Address::generate(&f.env);
        f.timelock.propose_admin(&new_admin);
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + ADMIN_TRANSFER_TTL + 1);
        assert_eq!(
            f.timelock.try_accept_admin(),
            Err(Ok(Error::AdminTransferExpired))
        );
    }
}
