//! Conformance tests for the governance TLA+ model (docs/formal/governance.tla).
//!
//! Each `model_trace_*` test replays one TLC trace (or counterexample) against
//! the real wasm of market-core, resolver and timelock. Every test says which
//! `docs/formal/governance_*.cfg` it corresponds to, and which tests must flip
//! when a finding is fixed (the "EXPECTED TO CHANGE" notes): when one of those
//! changes, the config's expected exit code in `scripts/formal.sh` changes with
//! it.
//!
//! The clients are generated from the compiled wasm (`make build` refreshes
//! `wasm/`), so these tests exercise the bytecode that ships. There is no
//! `mock_all_auths` here (`scripts/check-no-mock-all-auths.sh` enforces it):
//! every call mocks the one signer it needs, with its exact invocation, via
//! `MockAuth`. A contract that is the *direct invoker* of another contract is
//! authorised without a mock, which is exactly the Soroban rule the model
//! relies on.

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    xdr::{ScErrorCode, ScErrorType},
    Address, Env, IntoVal, Symbol, Val, Vec,
};

#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "wasm/market_core.wasm");
}
#[allow(clippy::too_many_arguments)]
mod resolver {
    soroban_sdk::contractimport!(file = "wasm/resolver.wasm");
}
mod timelock {
    soroban_sdk::contractimport!(file = "wasm/timelock.wasm");
}

const T0: u64 = 1_000_000;
const DAY: u64 = 86_400;
/// market-core / resolver `ADMIN_PROPOSAL_TTL_SECS`.
const ADMIN_TTL: u64 = 7 * DAY;

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/// A wiring peer that only answers `market_core()`.
///
/// (Used only to put an address in `PendingResolver`; see
/// `model_trace_pending_wiring_never_expires`.)
#[contract]
pub struct StubPeer;

#[contractimpl]
impl StubPeer {
    pub fn __constructor(env: Env, core: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "core"), &core);
    }
    pub fn market_core(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "core"))
            .unwrap()
    }
}

/// A target for timelock operations: records the last `set_paused` value.
#[contract]
pub struct Target;

#[contractimpl]
impl Target {
    pub fn set_paused(env: Env, paused: bool) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &paused);
    }
    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }
    pub fn noop(_env: Env) {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// One targeted signer mock: `who` authorises exactly `contract.name(args)`.
macro_rules! call_auth {
    ($who:expr, $contract:expr, $name:expr, $args:expr) => {
        MockAuth {
            address: $who,
            invoke: &MockAuthInvoke {
                contract: $contract,
                fn_name: $name,
                args: $args,
                sub_invokes: &[],
            },
        }
    };
}

fn is_context_error(
    e: &Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
    code: ScErrorCode,
) -> bool {
    matches!(e, Ok(err) if *err == soroban_sdk::Error::from_type_and_code(ScErrorType::Context, code))
}

struct Core {
    env: Env,
    admin: Address,
    id: Address,
}

impl Core {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(T0);
        env.ledger().set_network_id([7u8; 32]);
        let admin = Address::generate(&env);
        let collateral = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral,
                Address::generate(&env),
                Address::generate(&env),
                100u32,
                10_000u32,
            ),
        );
        Self { env, admin, id }
    }

    fn client(&self) -> market_core::Client<'_> {
        market_core::Client::new(&self.env, &self.id)
    }

    /// `admin.propose_resolver(r)`, with exactly that one auth mocked.
    fn propose_resolver(&self, r: &Address) {
        let args: Vec<Val> = (r.clone(),).into_val(&self.env);
        self.client()
            .mock_auths(&[call_auth!(&self.admin, &self.id, "propose_resolver", args)])
            .propose_resolver(r);
    }

    /// `admin.propose_admin(a)`, with exactly that one auth mocked.
    fn propose_admin(&self, a: &Address) {
        let args: Vec<Val> = (a.clone(),).into_val(&self.env);
        self.client()
            .mock_auths(&[call_auth!(&self.admin, &self.id, "propose_admin", args)])
            .propose_admin(a);
    }
}

// ---------------------------------------------------------------------------
// governance_wiring_callback.cfg  /  governance_wiring_peer_asserts.cfg
// ---------------------------------------------------------------------------

/// TLC: `governance_wiring_callback.cfg`, WiringLiveness violated; the trace's
/// `lastStack = <<resolver, core, resolver>>`. market-core's `accept_resolver`
/// calls back into the resolver for `market_core()` while the resolver is
/// already executing `accept_market_core_role`, and Soroban forbids that
/// re-entry. This is the `Error(Context, InvalidAction)` the formal README
/// recorded and never investigated.
///
/// EXPECTED TO CHANGE with the PeerAsserts fix (market-core drops the callback,
/// the resolver asserts its own `market_core()`): this call then succeeds and
/// `governance_wiring_callback.cfg` is replaced by
/// `governance_wiring_peer_asserts.cfg` as the production configuration.
#[test]
fn model_trace_wiring_callback_reenters() {
    let w = Core::new();
    let resolver_id = w
        .env
        .register(resolver::WASM, (w.admin.clone(), w.id.clone()));
    // An honest, correctly configured resolver, proposed by the core's admin.
    w.propose_resolver(&resolver_id);
    assert_eq!(
        resolver::Client::new(&w.env, &resolver_id).market_core(),
        w.id,
        "the peer is wired to this core"
    );

    w.env.set_auths(&[]);
    let result = resolver::Client::new(&w.env, &resolver_id).try_accept_market_core_role();
    match result {
        Err(e) => assert!(
            is_context_error(&e, ScErrorCode::InvalidAction),
            "expected Error(Context, InvalidAction) from the re-entrant callback, got {e:?}"
        ),
        Ok(r) => panic!("the callback handshake unexpectedly succeeded: {r:?}"),
    }
    assert_ne!(
        w.client().get_config().resolver,
        resolver_id,
        "wiring did not change"
    );
}

/// TLC: `governance_stale_wiring.cfg`, StalePendingWiring violated. A
/// `PendingResolver` carries no expiry: a proposal made a year ago is still
/// stored and `accept_resolver` has no time check (unlike `accept_admin`, which
/// rejects `now > expires_at`). The proposal is asserted at the storage level,
/// because the real resolver can never complete the handshake (see the test
/// above) and a stub peer cannot be driven through `accept_resolver` in native
/// test dispatch.
///
/// EXPECTED TO CHANGE if `PendingResolver`/`PendingTreasury` gain an expiry:
/// the entry is then cleared or rejected after the TTL, and
/// `governance_stale_wiring.cfg` (12) flips to 0.
#[test]
fn model_trace_pending_wiring_never_expires() {
    let w = Core::new();
    let peer = w.env.register(StubPeer, (w.id.clone(),));
    w.propose_resolver(&peer);

    // `DataKey::PendingResolver` is a unit variant: encoded as a one-element vec.
    let key: Vec<Val> = Vec::from_array(
        &w.env,
        [Symbol::new(&w.env, "PendingResolver").into_val(&w.env)],
    );
    let pending = |env: &Env, id: &Address| -> Option<Address> {
        env.as_contract(id, || env.storage().instance().get(&key))
    };
    assert_eq!(pending(&w.env, &w.id), Some(peer.clone()));

    // Well past any plausible expiry (the admin TTL is 7 days).
    w.env.ledger().set_timestamp(T0 + 400 * DAY);
    assert_eq!(
        pending(&w.env, &w.id),
        Some(peer),
        "a PendingResolver proposed 400 days ago is still pending"
    );
}

// ---------------------------------------------------------------------------
// governance_admin.cfg
// ---------------------------------------------------------------------------

/// TLC: `governance_admin.cfg`, NoExpiredAccept violated. market-core accepts
/// at `now == expires_at` and rejects from `expires_at + 1`; ADR 0007 says the
/// proposal is inert once `expires_at <= now`.
///
/// EXPECTED TO CHANGE when code and ADR are aligned (either side): flip the
/// first assertion, and `governance_admin.cfg` (12) becomes
/// `governance_admin_aligned.cfg` (0).
#[test]
fn model_trace_admin_accept_at_expiry_boundary() {
    let w = Core::new();
    let next = Address::generate(&w.env);
    w.propose_admin(&next);

    // One second after the proposal expires: rejected.
    w.env.ledger().set_timestamp(T0 + ADMIN_TTL + 1);
    let accept: Vec<Val> = ().into_val(&w.env);
    let late = w
        .client()
        .mock_auths(&[call_auth!(&next, &w.id, "accept_admin", accept.clone())])
        .try_accept_admin();
    assert!(
        matches!(late, Err(Ok(market_core::Error::PendingAdminExpired))),
        "expires_at + 1 must be rejected, got {late:?}"
    );

    // Exactly at expires_at: accepted (the finding).
    w.env.ledger().set_timestamp(T0 + ADMIN_TTL);
    w.client()
        .mock_auths(&[call_auth!(&next, &w.id, "accept_admin", accept)])
        .accept_admin();
    assert_eq!(w.client().admin(), next);
}

/// TLC: `governance_admin_aligned.cfg` (accepts only the pending address).
/// A different address cannot accept, even before expiry.
#[test]
fn model_trace_admin_accept_requires_the_pending_address() {
    let w = Core::new();
    let next = Address::generate(&w.env);
    let intruder = Address::generate(&w.env);
    w.propose_admin(&next);

    let accept: Vec<Val> = ().into_val(&w.env);
    let attempt = w
        .client()
        .mock_auths(&[call_auth!(&intruder, &w.id, "accept_admin", accept)])
        .try_accept_admin();
    assert!(attempt.is_err(), "only the proposed address may accept");
    assert_eq!(w.client().admin(), w.admin);
}

// ---------------------------------------------------------------------------
// Timelock: governance_timelock.cfg / governance_single_key.cfg
// ---------------------------------------------------------------------------

struct Tl {
    env: Env,
    id: Address,
    admin: Address,
    proposer: Address,
    canceller: Address,
    emergency: Address,
}

impl Tl {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(T0);
        let (admin, proposer, canceller, emergency) = (
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        );
        let id = env.register(
            timelock::WASM,
            (
                admin.clone(),
                proposer.clone(),
                canceller.clone(),
                None::<Address>,
                Some(emergency.clone()),
                DAY,
            ),
        );
        Self {
            env,
            id,
            admin,
            proposer,
            canceller,
            emergency,
        }
    }

    fn client(&self) -> timelock::Client<'_> {
        timelock::Client::new(&self.env, &self.id)
    }

    fn schedule(&self, as_proposer: &Address, target: &Address, f: &str, args: Vec<Val>) -> u64 {
        let sym = Symbol::new(&self.env, f);
        let call: Vec<Val> = (target.clone(), sym.clone(), args.clone()).into_val(&self.env);
        self.client()
            .mock_auths(&[call_auth!(as_proposer, &self.id, "schedule", call)])
            .schedule(target, &sym, &args)
    }
}

fn paused_true(env: &Env) -> Vec<Val> {
    (true,).into_val(env)
}

/// TLC: `governance_timelock.cfg`, CancelWinsBeforeExecute. A cancelled
/// operation is gone: executing it afterwards fails with OperationNotFound.
#[test]
fn model_trace_timelock_cancel_before_execute() {
    let t = Tl::new();
    let target = t.env.register(Target, ());
    let id = t.schedule(&t.proposer, &target, "set_paused", paused_true(&t.env));

    let cancel_args: Vec<Val> = (id,).into_val(&t.env);
    t.client()
        .mock_auths(&[call_auth!(&t.canceller, &t.id, "cancel", cancel_args)])
        .cancel(&id);

    t.env.ledger().set_timestamp(T0 + DAY + 1);
    let executed = t.client().try_execute(&id);
    assert!(
        matches!(executed, Err(Ok(timelock::Error::OperationNotFound))),
        "a cancelled operation must not execute, got {executed:?}"
    );
    assert!(!TargetClient::new(&t.env, &target).paused());
}

/// TLC: `governance_timelock.cfg`, NoExecuteBeforeEta.
#[test]
fn model_trace_execute_before_eta_rejected() {
    let t = Tl::new();
    let target = t.env.register(Target, ());
    let id = t.schedule(&t.proposer, &target, "set_paused", paused_true(&t.env));

    t.env.ledger().set_timestamp(T0 + DAY - 1);
    let early = t.client().try_execute(&id);
    assert!(
        matches!(early, Err(Ok(timelock::Error::OperationNotReady))),
        "eta - 1 must be rejected, got {early:?}"
    );

    t.env.ledger().set_timestamp(T0 + DAY);
    t.client().execute(&id);
    assert!(TargetClient::new(&t.env, &target).paused());
}

/// TLC: `governance_timelock.cfg`, EmergencyAllowListOnly. `emergency` runs
/// `set_paused(true)` on ANY target address, with no delay, and nothing else.
/// (The allow-list is on the function name and argument, not on the target.)
#[test]
fn model_trace_emergency_any_target() {
    let t = Tl::new();
    let (a, b) = (t.env.register(Target, ()), t.env.register(Target, ()));
    for target in [&a, &b] {
        let sym = Symbol::new(&t.env, "set_paused");
        let call: Vec<Val> = (target.clone(), sym.clone(), paused_true(&t.env)).into_val(&t.env);
        t.client()
            .mock_auths(&[call_auth!(&t.emergency, &t.id, "emergency", call)])
            .emergency(target, &sym, &paused_true(&t.env));
        assert!(TargetClient::new(&t.env, target).paused());
    }

    // Anything else is refused: un-pausing, and any other function.
    for (f, args) in [
        ("set_paused", (false,).into_val(&t.env)),
        ("noop", Vec::<Val>::new(&t.env)),
    ] {
        let sym = Symbol::new(&t.env, f);
        let call: Vec<Val> = (a.clone(), sym.clone(), args.clone()).into_val(&t.env);
        let refused = t
            .client()
            .mock_auths(&[call_auth!(&t.emergency, &t.id, "emergency", call)])
            .try_emergency(&a, &sym, &args);
        assert!(
            matches!(refused, Err(Ok(timelock::Error::EmergencyNotAllowed))),
            "{f}: {refused:?}"
        );
    }
}

/// TLC: `governance_single_key.cfg`, NoInstantPowerFromSingleKey violated. The
/// timelock admin swaps the roles instantly, with no delay and nobody able to
/// object: the old canceller loses the power to cancel the new proposer's
/// operations. This is the residual trust in the timelock admin.
///
/// EXPECTED TO CHANGE if `set_roles` becomes a scheduled self-call (the
/// TIMELOCK_SELF_ADMIN design): the first call then needs `schedule` + delay,
/// and `governance_single_key.cfg` (12) is superseded by
/// `governance_selfadmin.cfg` (0).
#[test]
fn model_trace_timelock_admin_set_roles_instant() {
    let t = Tl::new();
    let attacker = Address::generate(&t.env);
    let roles_args: Vec<Val> = (
        attacker.clone(),
        attacker.clone(),
        None::<Address>,
        Some(t.emergency.clone()),
    )
        .into_val(&t.env);
    t.client()
        .mock_auths(&[call_auth!(&t.admin, &t.id, "set_roles", roles_args)])
        .set_roles(&attacker, &attacker, &None, &Some(t.emergency.clone()));
    // No time passed.
    assert_eq!(t.env.ledger().timestamp(), T0);

    let target = t.env.register(Target, ());
    let id = t.schedule(&attacker, &target, "set_paused", paused_true(&t.env));

    // The honest watchdog is no longer the canceller: its cancel is rejected.
    let cancel_args: Vec<Val> = (id,).into_val(&t.env);
    let blocked = t
        .client()
        .mock_auths(&[call_auth!(&t.canceller, &t.id, "cancel", cancel_args)])
        .try_cancel(&id);
    assert!(
        blocked.is_err(),
        "the old canceller must have lost the role"
    );

    t.env.ledger().set_timestamp(T0 + DAY);
    t.client().execute(&id);
    assert!(TargetClient::new(&t.env, &target).paused());
}

/// Model note: `TIMELOCK_SELF_ADMIN = FALSE` today. `execute` supports exactly
/// one self-call (`set_default_delay`), so the timelock can never accept its
/// own admin role and cannot apply `set_roles` to itself through a schedule.
///
/// EXPECTED TO CHANGE with the TIMELOCK_SELF_ADMIN fix.
#[test]
fn model_trace_timelock_cannot_accept_its_own_admin() {
    let t = Tl::new();
    let id = t.schedule(&t.proposer, &t.id, "accept_admin", Vec::new(&t.env));
    t.env.ledger().set_timestamp(T0 + DAY);
    let result = t.client().try_execute(&id);
    assert!(
        matches!(result, Err(Ok(timelock::Error::SelfCallUnsupported))),
        "got {result:?}"
    );
}
