//! One treasury + market-core + SAC token world, the alphabet of operations
//! an agent/admin/clock can apply to it, and the invariants checked after
//! every operation.
//!
//! Invariants are stated in terms of observed token flows, timestamps and
//! contract views (not by re-deriving the treasury's window logic):
//!
//! * I1 per call: a successful buy spends `<= max_trade`, a seed `<= max_seed`.
//! * I2 per market: cumulative agent spend into a market `<= max_market`, and
//!   the treasury's own `MarketExposure.amount` equals that observed sum.
//! * I3 the treasury's reported daily window never exceeds `max_daily`, and
//!   equals the observed spends since the window's reported start.
//! * I4 sliding 24h: observed spend in any `[t, t + 86_400)` is `<= max_daily`.
//! * I5 pause: no successful buy / create / sell while the admin has paused;
//!   `close_trade` stays callable.
//! * I6 accounting: treasury balance = initial - spends + sell proceeds.
//! * I7 sell neutrality: `agent_sell` changes neither the window nor any
//!   `MarketExposure`.
//! * I8 net exposure stays within its cap.
//! * I9 completeness: an op that is within every observable cap succeeds
//!   (this is what makes an off-by-one that is too *strict* visible).
//! * A1 atomicity: a failed op leaves every observed quantity unchanged.
//!
//! Auth is mocked (`mock_all_auths`): authorization is out of scope here and
//! covered by the contracts' own wrong-caller tests.

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal, String as SorobanString, Symbol, Val, Vec as SVec,
};
use treasury::{
    CreationPolicy, DataKey, MarketExposure, PricePolicy, Treasury, TreasuryArgs, TreasuryClient,
};

/// Imported (not path-linked) so the very same bytes the treasury is built
/// against run in the wasm VM. See docs/adr/0002-cross-contract-calls.md.
#[allow(clippy::too_many_arguments)]
pub mod mc {
    soroban_sdk::contractimport!(file = "../treasury/market_core.wasm");
}

/// Collateral unit: `MIN_SEED` (100 USDC at 7 decimals). The search uses
/// caps of 1..5 of these.
pub const U: i128 = 100 * 10_000_000;
pub const HOUR: u64 = 3_600;
pub const DAY: u64 = 86_400;
/// Hour-aligned so `now % HOUR` starts at 0.
pub const T0: u64 = HOUR * 500_000;
const TREASURY_FUNDS: i128 = 60 * U;
const THIRD_PARTY_SEED: i128 = 50 * U;
const MAX_CREATED: usize = 2;
/// `max_net_exposure`: far above `max_daily`, so it never binds here.
const NET_CAP: i128 = 100 * U;
/// Granularity of the treasury's share count in the state key: about half a
/// sell (`U / 2` of proceeds needs roughly `U / 2` shares at the seeded price).
const SHARE_BUCKET: i128 = U / 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McImpl {
    /// The vendored compiled wasm, run in the Soroban VM (fidelity).
    Wasm,
    /// The `market-core` crate registered natively (speed).
    Native,
}

#[derive(Clone, Copy, Debug)]
pub struct Cfg {
    /// Rust name of the constant, printed in counterexamples.
    pub ident: &'static str,
    pub name: &'static str,
    pub max_trade: i128,
    pub max_market: i128,
    pub max_daily: i128,
    /// Cap on a single seed; `<= max_market`. Independent of `max_trade`.
    pub max_seed: i128,
    /// Seconds after `T0` at which the two pre-existing markets close.
    pub close_after: u64,
    /// Full alphabet (the one in the issue); `lean_*` is the default for the
    /// depth-6 CI run, see `Alphabet`.
    pub amounts: &'static [i128],
    pub seeds: &'static [i128],
    pub advances: &'static [u64],
    pub lean_amounts: &'static [i128],
    pub lean_seeds: &'static [i128],
    pub lean_advances: &'static [u64],
    pub alphabet: Alphabet,
    pub mc: McImpl,
}

/// How much of the alphabet a run uses. `Lean` drops the least informative
/// symbols (a 1-second clock tick, `close_trade`, seeds that always fail the
/// seed cap), a second treasury-created market (another creation is one more
/// spend into a fresh market, which the first already exercises) and sells
/// that cannot succeed (no shares); it keeps a boundary on every cap.
/// `Full` is the issue's complete alphabet and is what the deep run uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alphabet {
    Lean,
    Full,
}

pub const ADVANCES: &[u64] = &[1, 43_200, 86_399, 86_400];
pub const LEAN_ADVANCES: &[u64] = &[43_200, 86_399, 86_400];

/// caps (2U, 3U, 4U) from the issue; seeds bounded by `max_trade`.
pub const CFG_TIGHT: Cfg = Cfg {
    ident: "CFG_TIGHT",
    name: "max_trade=2U max_market=3U max_daily=4U",
    max_trade: 2 * U,
    max_market: 3 * U,
    max_daily: 4 * U,
    max_seed: 2 * U,
    close_after: 365 * DAY,
    amounts: &[U, 2 * U, 3 * U],
    seeds: &[U, 2 * U, 3 * U],
    advances: ADVANCES,
    lean_amounts: &[U, 2 * U, 3 * U],
    lean_seeds: &[U, 2 * U],
    lean_advances: LEAN_ADVANCES,
    alphabet: Alphabet::Lean,
    mc: McImpl::Native,
};

/// All three caps equal: every cap boundary coincides.
pub const CFG_EQUAL: Cfg = Cfg {
    ident: "CFG_EQUAL",
    name: "max_trade=max_market=max_daily=2U",
    max_trade: 2 * U,
    max_market: 2 * U,
    max_daily: 2 * U,
    max_seed: 2 * U,
    close_after: 365 * DAY,
    amounts: &[U, 2 * U, 3 * U],
    seeds: &[U, 2 * U, 3 * U],
    advances: ADVANCES,
    lean_amounts: &[U, 2 * U],
    lean_seeds: &[U, 2 * U],
    lean_advances: LEAN_ADVANCES,
    alphabet: Alphabet::Lean,
    mc: McImpl::Native,
};

/// A seed above `max_trade` (the creation policy bounds seeds separately).
pub const CFG_SEED: Cfg = Cfg {
    ident: "CFG_SEED",
    name: "max_seed=3U > max_trade=2U",
    max_trade: 2 * U,
    max_market: 3 * U,
    max_daily: 4 * U,
    max_seed: 3 * U,
    close_after: 365 * DAY,
    amounts: &[U, 2 * U],
    seeds: &[U, 3 * U],
    advances: ADVANCES,
    lean_amounts: &[U, 2 * U],
    lean_seeds: &[U, 3 * U],
    lean_advances: LEAN_ADVANCES,
    alphabet: Alphabet::Lean,
    mc: McImpl::Native,
};

/// The pre-existing markets close after one day: buys and creations must
/// start failing with market-core's `MarketClosed`.
pub const CFG_CLOSING: Cfg = Cfg {
    ident: "CFG_CLOSING",
    name: "markets close after 1 day",
    max_trade: 2 * U,
    max_market: 3 * U,
    max_daily: 4 * U,
    max_seed: 2 * U,
    close_after: DAY,
    amounts: &[U, 2 * U],
    seeds: &[U],
    advances: ADVANCES,
    lean_amounts: &[U, 2 * U],
    lean_seeds: &[U],
    lean_advances: LEAN_ADVANCES,
    alphabet: Alphabet::Lean,
    mc: McImpl::Native,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Op {
    Buy { m: usize, amt: i128 },
    Sell { m: usize, out: i128 },
    Create { seed: i128 },
    Close { m: usize },
    Advance { dt: u64 },
    Pause,
    Unpause,
}

impl Op {
    /// One line of a replayable counterexample (see `Sim::buy` and friends).
    pub fn snippet(&self) -> String {
        match *self {
            Op::Buy { m, amt } => format!("f.buy({m}, {});", fmt_u(amt)),
            Op::Sell { m, out } => format!("f.sell({m}, {});", fmt_u(out)),
            Op::Create { seed } => format!("f.create({});", fmt_u(seed)),
            Op::Close { m } => format!("f.close({m});"),
            Op::Advance { dt } => format!("f.advance({dt});"),
            Op::Pause => "f.pause(true);".into(),
            Op::Unpause => "f.pause(false);".into(),
        }
    }
}

fn contract_code(e: soroban_sdk::Error) -> Res {
    if e.is_type(soroban_sdk::xdr::ScErrorType::Contract) {
        Res::Err(e.get_code())
    } else {
        Res::Trap
    }
}

fn fmt_u(v: i128) -> String {
    if v % U == 0 {
        format!("{} * U", v / U)
    } else {
        format!("U / {}", U / v)
    }
}

/// What a call to the treasury returned, reduced to what the invariants need.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Res {
    Ok(i128),
    /// A contract error. The code alone is ambiguous: a nested market-core
    /// error is re-raised under its own code, and e.g. market-core's
    /// `MarketClosed` (9) collides with the treasury's `InsufficientBalance`
    /// (9). Callers must therefore reason from the *called function and
    /// state*, never from the code alone.
    Err(u32),
    /// A host-level failure (trap, budget, auth).
    Trap,
}

impl Res {
    pub fn is_ok(&self) -> bool {
        matches!(self, Res::Ok(_))
    }
}

#[derive(Clone, Debug)]
pub struct Spend {
    pub t: u64,
    pub market: usize,
    pub amount: i128,
}

/// Everything the atomicity check compares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub treasury_bal: i128,
    pub core_bal: i128,
    pub window: (u64, Vec<i128>, u32),
    pub exposures: Vec<(i128, bool)>,
    pub net: i128,
    pub paused: bool,
}

pub struct Sim {
    pub env: Env,
    pub cfg: Cfg,
    pub admin: Address,
    pub agent: Address,
    pub treasury: Address,
    pub token: Address,
    pub core: Address,
    pub markets: usize,
    pub created: usize,
    pub nonce: u8,
    pub spends: Vec<Spend>,
    pub initial_balance: i128,
    /// Σ observed returns (sell proceeds, redeems, claims).
    pub returns: i128,
    pub paused: bool,
    /// Observation after the most recent `apply`, reused by `key`.
    pub last: Option<Observed>,
}

#[derive(Debug)]
pub struct Violation {
    pub invariant: &'static str,
    pub detail: String,
}

const PERMISSIVE: PricePolicy = PricePolicy {
    max_buy_price_bps: 10_000,
    min_sell_price_bps: 0,
    max_impact_bps: 10_000,
    max_slippage_bps: 9_999,
};

impl Sim {
    pub fn new(cfg: Cfg) -> Sim {
        // Without this every dropped Env writes a test-snapshot JSON file,
        // which costs far more than the contract calls themselves.
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.ledger().set_timestamp(T0);
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let third = Address::generate(&env);
        let resolver = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = sac.address();
        let mint = StellarAssetClient::new(&env, &token);
        mint.mint(&third, &(10 * THIRD_PARTY_SEED));
        mint.mint(&treasury, &TREASURY_FUNDS);

        let args = (
            admin.clone(),
            token.clone(),
            treasury.clone(),
            resolver,
            100u32,
            10_000u32,
        );
        let core = match cfg.mc {
            McImpl::Wasm => env.register(mc::WASM, args),
            McImpl::Native => env.register(
                ::market_core::MarketCore,
                ::market_core::MarketCoreArgs::__constructor(
                    &args.0, &args.1, &args.2, &args.3, &args.4, &args.5,
                ),
            ),
        };
        let core_client = mc::Client::new(&env, &core);
        for i in 0..2u8 {
            core_client.create_market(
                &third,
                &BytesN::from_array(&env, &[i + 1; 32]),
                &BytesN::from_array(&env, &[i + 101; 32]),
                &SorobanString::from_str(&env, "ipfs://preexisting"),
                &mc::Category::Crypto,
                &(T0 + cfg.close_after),
                &THIRD_PARTY_SEED,
                &5000u32,
            );
        }

        let policy = CreationPolicy {
            max_seed: cfg.max_seed,
            max_markets_per_window: 100,
            creation_window_secs: DAY,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY,
            allowed_categories: 0x3F,
        };
        // The net-exposure cap is set far above the daily cap so it never
        // binds: the search is about spending caps. It is still checked (I8).
        env.register_at(
            &treasury,
            Treasury,
            TreasuryArgs::__constructor(
                &admin,
                &agent,
                &token,
                &core,
                &cfg.max_trade,
                &cfg.max_market,
                &cfg.max_daily,
                &NET_CAP,
                &86_400u64,
                &(1_000 * U),
                &7u32,
                &policy,
            ),
        );
        // Cap logic, not price logic, is under test: lift the price limits
        // (as the treasury's own cap tests do) by writing storage directly.
        env.as_contract(&treasury, || {
            env.storage()
                .instance()
                .set(&DataKey::PricePolicy, &PERMISSIVE);
        });
        let initial_balance = TokenClient::new(&env, &token).balance(&treasury);
        Sim {
            env,
            cfg,
            admin,
            agent,
            treasury,
            token,
            core,
            markets: 2,
            created: 0,
            nonce: 0,
            spends: Vec::new(),
            initial_balance,
            returns: 0,
            paused: false,
            last: None,
        }
    }

    /// Field-wise copy sharing the same `Env` (the caller replaces it).
    pub fn shallow(&self) -> Sim {
        Sim {
            env: self.env.clone(),
            cfg: self.cfg,
            admin: self.admin.clone(),
            agent: self.agent.clone(),
            treasury: self.treasury.clone(),
            token: self.token.clone(),
            core: self.core.clone(),
            markets: self.markets,
            created: self.created,
            nonce: self.nonce,
            spends: Vec::new(),
            initial_balance: self.initial_balance,
            returns: self.returns,
            paused: self.paused,
            last: None,
        }
    }

    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn tre(&self) -> TreasuryClient<'_> {
        TreasuryClient::new(&self.env, &self.treasury)
    }

    fn core(&self) -> mc::Client<'_> {
        mc::Client::new(&self.env, &self.core)
    }

    fn bal(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    pub fn exposure(&self, m: usize) -> MarketExposure {
        self.env.as_contract(&self.treasury, || {
            self.env
                .storage()
                .persistent()
                .get::<_, MarketExposure>(&DataKey::Market(m as u64))
                .unwrap_or(MarketExposure {
                    amount: 0,
                    open: false,
                })
        })
    }

    pub fn observe(&self) -> Observed {
        let w = self.tre().daily_usage_detail();
        // One contract frame for every storage read instead of one per value.
        let (exposures, paused) = self.env.as_contract(&self.treasury, || {
            let p = self.env.storage().persistent();
            let exposures = (0..self.markets)
                .map(|m| {
                    let e = p
                        .get::<_, MarketExposure>(&DataKey::Market(m as u64))
                        .unwrap_or(MarketExposure {
                            amount: 0,
                            open: false,
                        });
                    (e.amount, e.open)
                })
                .collect();
            let paused = self
                .env
                .storage()
                .instance()
                .get::<_, bool>(&DataKey::AdminPaused)
                .unwrap_or(false);
            (exposures, paused)
        });
        Observed {
            treasury_bal: self.bal(&self.treasury),
            core_bal: self.bal(&self.core),
            window: (w.head_hour, w.amounts.iter().collect(), w.head_idx),
            exposures,
            net: self.tre().net_exposure(),
            paused,
        }
    }

    /// Window amounts newest-first (independent of the ring's rotation).
    fn newest_first(window: &(u64, Vec<i128>, u32)) -> Vec<i128> {
        let n = window.1.len();
        (0..n)
            .map(|i| window.1[(window.2 as usize + n - i) % n])
            .collect()
    }

    // ---- operations -----------------------------------------------------

    fn invoke(&self, name: &str, args: SVec<Val>) -> Res {
        let sym = Symbol::new(&self.env, name);
        match self
            .env
            .try_invoke_contract::<i128, soroban_sdk::Error>(&self.treasury, &sym, args)
        {
            Ok(Ok(v)) => Res::Ok(v),
            Ok(Err(_)) => Res::Trap,
            Err(Ok(e)) => contract_code(e),
            Err(Err(_)) => Res::Trap,
        }
    }

    fn invoke_create(&self, seed: i128) -> Res {
        let e = &self.env;
        let n = self.nonce;
        let args: SVec<Val> = soroban_sdk::vec![
            e,
            self.agent.into_val(e),
            BytesN::from_array(e, &[n + 50; 32]).into_val(e),
            BytesN::from_array(e, &[n + 150; 32]).into_val(e),
            SorobanString::from_str(e, "ipfs://agent").into_val(e),
            mc::Category::Crypto.into_val(e),
            (self.now() + 30 * DAY).into_val(e),
            seed.into_val(e),
            5000u32.into_val(e),
        ];
        let sym = Symbol::new(e, "agent_create_market");
        match e.try_invoke_contract::<u64, soroban_sdk::Error>(&self.treasury, &sym, args) {
            Ok(Ok(v)) => Res::Ok(v as i128),
            Ok(Err(_)) => Res::Trap,
            Err(Ok(err)) => contract_code(err),
            Err(Err(_)) => Res::Trap,
        }
    }

    /// Applies `op`; with `check` it also asserts the invariants.
    pub fn apply(&mut self, op: Op, check: bool) -> Result<Res, Violation> {
        // Clock and pause ops cannot fail, so they need no before-image.
        let cheap = matches!(op, Op::Advance { .. } | Op::Pause | Op::Unpause);
        let before = (!cheap).then(|| self.observe());
        let paused = before
            .as_ref()
            .map(|b| b.paused)
            .unwrap_or_else(|| self.paused);
        let expect_ok = if check {
            self.expected_ok(op, paused)
        } else {
            None
        };
        let now = self.now();
        let e = self.env.clone();
        let res = match op {
            Op::Buy { m, amt } => {
                let args: SVec<Val> = soroban_sdk::vec![
                    &e,
                    self.agent.into_val(&e),
                    (m as u64).into_val(&e),
                    mc::Outcome::Yes.into_val(&e),
                    amt.into_val(&e),
                    0i128.into_val(&e),
                ];
                self.invoke("agent_buy", args)
            }
            Op::Sell { m, out } => {
                let args: SVec<Val> = soroban_sdk::vec![
                    &e,
                    self.agent.into_val(&e),
                    (m as u64).into_val(&e),
                    mc::Outcome::Yes.into_val(&e),
                    out.into_val(&e),
                    (100 * U).into_val(&e),
                ];
                self.invoke("agent_sell", args)
            }
            Op::Create { seed } => self.invoke_create(seed),
            Op::Close { m } => {
                let args: SVec<Val> =
                    soroban_sdk::vec![&e, self.agent.into_val(&e), (m as u64).into_val(&e)];
                self.invoke("close_trade", args)
            }
            Op::Advance { dt } => {
                e.ledger().set_timestamp(now + dt);
                Res::Ok(0)
            }
            Op::Pause => {
                self.tre().set_paused(&true);
                self.paused = true;
                Res::Ok(0)
            }
            Op::Unpause => {
                self.tre().set_paused(&false);
                self.paused = false;
                Res::Ok(0)
            }
        };

        // Bookkeeping from observed flows.
        if let Res::Ok(v) = res {
            match op {
                Op::Buy { m, amt } => self.spends.push(Spend {
                    t: now,
                    market: m,
                    amount: amt,
                }),
                Op::Create { seed } => {
                    self.spends.push(Spend {
                        t: now,
                        market: v as usize,
                        amount: seed,
                    });
                    self.markets += 1;
                    self.created += 1;
                    self.nonce += 1;
                }
                Op::Sell { out, .. } => self.returns += out,
                _ => {}
            }
        }
        let after = self.observe();
        let before_ref = before.as_ref().unwrap_or(&after);
        let delta = after.treasury_bal - before_ref.treasury_bal;
        let outcome = if check {
            self.check(op, res, before_ref, &after, delta, paused, expect_ok)
        } else {
            Ok(())
        };
        self.last = Some(after);
        outcome.map(|()| res)
    }

    /// `redeem` / `claim_pool_remainder` for market `m`: not part of the
    /// search alphabet (a market must be final first), but part of I6, so
    /// the proceeds are folded into `returns`.
    pub fn settle(&mut self, name: &str, m: usize) -> Res {
        let e = self.env.clone();
        let args: SVec<Val> =
            soroban_sdk::vec![&e, self.agent.into_val(&e), (m as u64).into_val(&e)];
        let before = self.bal(&self.treasury);
        let res = self.invoke(name, args);
        if let Res::Ok(v) = res {
            assert_eq!(
                self.bal(&self.treasury) - before,
                v,
                "{name} payout != balance change"
            );
            self.returns += v;
        }
        res
    }

    /// Finalizes market `m` in market-core as its resolver (auth is mocked).
    pub fn resolve_yes(&self, m: usize) {
        self.core().resolve(&(m as u64), &mc::Outcome::Yes);
    }

    pub fn expected_balance(&self) -> i128 {
        let spent: i128 = self.spends.iter().map(|s| s.amount).sum();
        self.initial_balance - spent + self.returns
    }

    pub fn balance(&self) -> i128 {
        self.bal(&self.treasury)
    }

    // ---- replayable-counterexample API: each call applies one operation with
    // every invariant checked and panics at the first violation, so a printed
    // counterexample fails on the same line when pasted into a test.

    fn step(&mut self, op: Op) {
        if let Err(v) = self.apply(op, true) {
            panic!("{}: {}", v.invariant, v.detail);
        }
    }

    #[allow(dead_code)] // part of the printed-counterexample API
    pub fn buy(&mut self, m: usize, amt: i128) {
        self.step(Op::Buy { m, amt });
    }

    #[allow(dead_code)] // part of the printed-counterexample API
    pub fn sell(&mut self, m: usize, out: i128) {
        self.step(Op::Sell { m, out });
    }

    pub fn create(&mut self, seed: i128) {
        self.step(Op::Create { seed });
    }

    pub fn close(&mut self, m: usize) {
        self.step(Op::Close { m });
    }

    pub fn advance(&mut self, dt: u64) {
        self.step(Op::Advance { dt });
    }

    pub fn pause(&mut self, on: bool) {
        self.step(if on { Op::Pause } else { Op::Unpause });
    }

    /// I9 oracle: `Some(true)` when the op is within every *observable* cap
    /// and must therefore succeed. Reads only views and storage, never the
    /// window logic itself.
    fn expected_ok(&self, op: Op, paused: bool) -> Option<bool> {
        let bal = self.bal(&self.treasury);
        let headroom = self.tre().daily_headroom();
        let cfg = &self.cfg;
        match op {
            Op::Buy { m, amt } => {
                let mk = self.core().get_market(&(m as u64));
                let open = mk.status == mc::MarketStatus::Open && self.now() < mk.close_time;
                let cum = self.exposure(m).amount;
                Some(
                    !paused
                        && open
                        && amt <= cfg.max_trade
                        && cum + amt <= cfg.max_market
                        && amt <= headroom
                        && amt <= bal,
                )
            }
            Op::Create { seed } => Some(
                !paused
                    && self.created < MAX_CREATED
                    && seed <= cfg.max_seed
                    && seed <= cfg.max_market
                    && seed >= U
                    && seed <= headroom
                    && seed <= bal,
            ),
            _ => None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn check(
        &mut self,
        op: Op,
        res: Res,
        before: &Observed,
        after: &Observed,
        delta: i128,
        was_paused: bool,
        expect_ok: Option<bool>,
    ) -> Result<(), Violation> {
        let v = |invariant: &'static str, detail: String| Err(Violation { invariant, detail });
        let cfg = self.cfg;

        // A1: atomicity. A failed treasury call changes nothing observable.
        if !res.is_ok() && before != after {
            return v(
                "A1 atomicity",
                format!("{op:?} failed ({res:?}) but state changed:\n{before:?}\n{after:?}"),
            );
        }

        match op {
            Op::Buy { m, amt } => {
                if res.is_ok() {
                    if amt > cfg.max_trade {
                        return v(
                            "I1 per-call",
                            format!("buy {amt} > max_trade {}", cfg.max_trade),
                        );
                    }
                    if delta != -amt {
                        return v(
                            "I6 accounting",
                            format!("buy {amt} moved treasury balance by {delta}"),
                        );
                    }
                    if was_paused {
                        return v("I5 pause", "agent_buy succeeded while paused".into());
                    }
                } else if was_paused && res != Res::Err(treasury::Error::Paused as u32) {
                    return v(
                        "I5 pause",
                        format!("paused buy failed with {res:?}, expected Paused"),
                    );
                }
                let _ = m;
            }
            Op::Create { seed } => {
                if res.is_ok() {
                    if seed > cfg.max_seed {
                        return v(
                            "I1 per-call",
                            format!("seed {seed} > max_seed {}", cfg.max_seed),
                        );
                    }
                    if delta != -seed {
                        return v(
                            "I6 accounting",
                            format!("seed {seed} moved treasury balance by {delta}"),
                        );
                    }
                    if was_paused {
                        return v(
                            "I5 pause",
                            "agent_create_market succeeded while paused".into(),
                        );
                    }
                } else if was_paused && res != Res::Err(treasury::Error::Paused as u32) {
                    return v(
                        "I5 pause",
                        format!("paused create failed with {res:?}, expected Paused"),
                    );
                }
            }
            Op::Sell { m, out } => {
                if res.is_ok() {
                    if was_paused {
                        return v("I5 pause", "agent_sell succeeded while admin-paused".into());
                    }
                    if delta != out {
                        return v(
                            "I6 accounting",
                            format!("sell out={out} moved treasury balance by {delta}"),
                        );
                    }
                    // I7: no cap bookkeeping moved.
                    if before.window != after.window || before.exposures != after.exposures {
                        return v(
                            "I7 sell neutrality",
                            format!("sell changed window/exposure:\n{before:?}\n{after:?}"),
                        );
                    }
                } else if was_paused && res != Res::Err(treasury::Error::Paused as u32) {
                    return v(
                        "I5 pause",
                        format!("paused sell failed with {res:?}, expected Paused"),
                    );
                }
                let _ = m;
            }
            Op::Close { .. } => {
                // I5 (documented): close_trade has no pause check. It must
                // succeed iff the exposure is open, paused or not.
                let was_open = before
                    .exposures
                    .get(match op {
                        Op::Close { m } => m,
                        _ => 0,
                    })
                    .map(|e| e.1)
                    .unwrap_or(false);
                if was_open != res.is_ok() {
                    return v(
                        "I5 close_trade",
                        format!(
                            "close_trade open={was_open} returned {res:?} (paused={was_paused})"
                        ),
                    );
                }
            }
            Op::Advance { .. } | Op::Pause | Op::Unpause => {}
        }

        // I9: completeness. Within every observable cap => must succeed.
        if let Some(true) = expect_ok {
            if !res.is_ok() {
                return v(
                    "I9 completeness",
                    format!("{op:?} is within every observable cap but failed with {res:?}"),
                );
            }
        }

        // I2 + exposure accounting, per market.
        for m in 0..self.markets {
            let observed: i128 = self
                .spends
                .iter()
                .filter(|s| s.market == m)
                .map(|s| s.amount)
                .sum();
            let e = after.exposures[m];
            if e.0 != observed {
                return v(
                    "I2 accounting",
                    format!(
                        "m{m}: MarketExposure.amount {} != observed spends {observed}",
                        e.0
                    ),
                );
            }
            if observed > cfg.max_market {
                return v(
                    "I2 per-market",
                    format!(
                        "m{m}: cumulative spend {observed} > max_market {}",
                        cfg.max_market
                    ),
                );
            }
        }

        // I3: the treasury's own window, cross-checked with observed flows.
        let usage = self.tre().daily_usage();
        if usage.amount > cfg.max_daily {
            return v(
                "I3 daily",
                format!("daily_usage {} > max_daily {}", usage.amount, cfg.max_daily),
            );
        }
        let observed_in_window: i128 = self
            .spends
            .iter()
            .filter(|s| s.t >= usage.day_start)
            .map(|s| s.amount)
            .sum();
        if observed_in_window != usage.amount {
            return v(
                "I3 window accounting",
                format!(
                    "window since {} reports {} but observed spends are {observed_in_window}",
                    usage.day_start, usage.amount
                ),
            );
        }

        // I4: sliding 24h over the observed spend log.
        for (i, s) in self.spends.iter().enumerate() {
            let sum: i128 = self.spends[i..]
                .iter()
                .filter(|x| x.t < s.t + DAY)
                .map(|x| x.amount)
                .sum();
            if sum > cfg.max_daily {
                return v(
                    "I4 sliding 24h",
                    format!(
                        "{sum} spent in [{}, {}) > max_daily {}",
                        s.t,
                        s.t + DAY,
                        cfg.max_daily
                    ),
                );
            }
        }

        // I6: whole-run accounting from the operation parameters.
        let spent: i128 = self.spends.iter().map(|s| s.amount).sum();
        let expected_bal = self.initial_balance - spent + self.returns;
        if after.treasury_bal != expected_bal {
            return v(
                "I6 accounting",
                format!(
                    "balance {} != initial {} - spent {spent} + returns {}",
                    after.treasury_bal, self.initial_balance, self.returns
                ),
            );
        }

        // I8: net exposure cap (set high; asserts the view never exceeds it).
        if after.net > NET_CAP {
            return v(
                "I8 net exposure",
                format!("net {} > cap {NET_CAP}", after.net),
            );
        }
        Ok(())
    }

    // ---- abstract state for memoization / symmetry -------------------------

    /// Per-market behavioural summary, shared by `key` and `ops`: what the
    /// invariants can distinguish between two markets.
    fn market_summary(&self, m: usize, obs: &Observed) -> Vec<i128> {
        let now = self.now();
        let mk = self.core().get_market(&(m as u64));
        let pos = self.core().get_position(&(m as u64), &self.treasury);
        let e = obs.exposures[m];
        let closed = mk.status != mc::MarketStatus::Open || now >= mk.close_time;
        vec![
            e.0,
            e.1 as i128,
            (pos.yes / SHARE_BUCKET).min(8),
            (pos.no / SHARE_BUCKET).min(8),
            closed as i128,
        ]
    }

    /// The enabled alphabet in this state. Symmetry reduction: markets in the
    /// same interchangeable group (the two pre-existing ones; the treasury's
    /// own) with identical summaries behave identically, so only the lowest
    /// index of each such class is exercised.
    pub fn ops(&self) -> Vec<Op> {
        let obs = self.last.clone().unwrap_or_else(|| self.observe());
        let summaries: Vec<Vec<i128>> = (0..self.markets)
            .map(|m| self.market_summary(m, &obs))
            .collect();
        let representative = |m: usize| {
            let group = |i: usize| i >= 2;
            !(0..m).any(|j| group(j) == group(m) && summaries[j] == summaries[m])
        };
        let lean = self.cfg.alphabet == Alphabet::Lean;
        let (amounts, seeds, advances) = if lean {
            (
                self.cfg.lean_amounts,
                self.cfg.lean_seeds,
                self.cfg.lean_advances,
            )
        } else {
            (self.cfg.amounts, self.cfg.seeds, self.cfg.advances)
        };
        let mut ops = Vec::new();
        for m in (0..self.markets).filter(|&m| representative(m)) {
            for &amt in amounts {
                ops.push(Op::Buy { m, amt });
            }
            // Lean: a sell needs shares, otherwise the call fails and moves
            // nothing; `close_trade` only flips a bookkeeping flag that no
            // cap reads, so it is left to the dedicated paused-close test.
            // Full keeps both so failed-call atomicity (A1) and `close_trade`
            // are exercised in every state.
            if !lean || summaries[m][2] > 0 {
                ops.push(Op::Sell { m, out: U / 2 });
            }
            if !lean {
                ops.push(Op::Close { m });
            }
        }
        if self.created < if lean { 1 } else { MAX_CREATED } {
            for &seed in seeds {
                ops.push(Op::Create { seed });
            }
        }
        for &dt in advances {
            ops.push(Op::Advance { dt });
        }
        ops.push(if self.paused { Op::Unpause } else { Op::Pause });
        ops
    }

    /// Canonical key of the *behaviourally relevant* state. Absolute time is
    /// normalized to what the code can see: `now % HOUR`, the window buckets
    /// newest-first, spend ages (capped past the 25h horizon) and each
    /// market's close status. Markets are canonicalized by sorting within the
    /// interchangeable groups.
    ///
    /// Market reserves are deliberately *not* in the key: the caps and every
    /// invariant are functions of token flows that equal the operation
    /// parameters, and reserves only decide whether a trade clears market-core
    /// (which the key covers through the treasury's share count, bucketed at
    /// `SHARE_BUCKET`, and the market's close status). Including them exactly
    /// makes almost every trade ordering a distinct state, for no behavioural
    /// difference. Sell proceeds are not in the key either: the balance only
    /// matters to behaviour through "funded or not" (the treasury is funded
    /// far above any cap), and I6 is checked exactly along the explored path.
    pub fn key(&self) -> Vec<i128> {
        let obs = self.last.clone().unwrap_or_else(|| self.observe());
        let mut k: Vec<i128> = Vec::new();
        let now = self.now();
        k.push(obs.paused as i128);
        k.push((now % HOUR) as i128);
        k.extend(Self::newest_first(&obs.window));
        // I4/I2 history: the spends that can still matter, by age.
        let mut recent: Vec<(i128, i128)> = self
            .spends
            .iter()
            .filter(|s| now - s.t < DAY + HOUR)
            .map(|s| ((now - s.t) as i128, s.amount))
            .collect();
        recent.sort();
        k.push(recent.len() as i128);
        for (age, amt) in recent {
            k.push(age);
            k.push(amt);
        }
        k.push(self.created as i128);
        let mut groups: [Vec<Vec<i128>>; 2] = [Vec::new(), Vec::new()];
        for m in 0..self.markets {
            groups[(m >= 2) as usize].push(self.market_summary(m, &obs));
        }
        for g in groups.iter_mut() {
            g.sort();
            k.push(g.len() as i128);
            for t in g.iter() {
                k.extend(t);
            }
        }
        k
    }
}
