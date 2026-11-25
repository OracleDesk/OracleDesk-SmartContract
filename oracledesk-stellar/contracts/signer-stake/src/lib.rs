#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Env, Symbol,
};

const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeConfig {
    pub admin: Address,
    pub token: Address,
    pub resolver: Address,
    pub min_stake: i128,
    pub unbond_delay: u64,
    pub equivocation_slash_bps: u32,
    pub liveness_slash_bps: u32,
    pub reporter_reward_bps: u32,
    pub slash_recipient: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bond {
    pub amount: i128,
    pub locked: i128,
    pub unbond_amount: i128,
    pub unbond_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    Bond(Address),
    Lock(Address, u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    InsufficientBond = 1,
    UnbondingStaked = 2,
    TooEarlyToWithdraw = 3,
    UnauthorizedSlash = 4,
    SlashAmountTooLarge = 5,
    InsufficientSlashAmount = 6,
    InvalidConfig = 7,
    NothingToWithdraw = 8,
    TransferFailed = 9,
    AlreadyLocked = 10,
    NotLocked = 11,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bonded {
    pub signer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnbondRequested {
    pub signer: Address,
    pub amount: i128,
    pub unbond_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    pub signer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Locked {
    pub signer: Address,
    pub market_id: u64,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unlocked {
    pub signer: Address,
    pub market_id: u64,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Slashed {
    pub signer: Address,
    pub amount: i128,
    pub reason: Symbol,
    pub reporter: Option<Address>,
}

#[contract]
pub struct SignerStakeContract;

#[contractimpl]
impl SignerStakeContract {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        resolver: Address,
        min_stake: i128,
        unbond_delay: u64,
        equivocation_slash_bps: u32,
        liveness_slash_bps: u32,
        reporter_reward_bps: u32,
        slash_recipient: Address,
    ) {
        if min_stake <= 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        if unbond_delay == 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        if equivocation_slash_bps > 10_000
            || liveness_slash_bps > 10_000
            || reporter_reward_bps > 10_000
        {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        let config = StakeConfig {
            admin,
            token,
            resolver,
            min_stake,
            unbond_delay,
            equivocation_slash_bps,
            liveness_slash_bps,
            reporter_reward_bps,
            slash_recipient,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    }

    pub fn bond(env: Env, signer: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        signer.require_auth();

        let config = Self::get_config(&env);
        let token_client = token::Client::new(&env, &config.token);

        token_client.transfer(&signer, env.current_contract_address(), &amount);

        let mut bond = Self::get_bond(&env, &signer);
        bond.amount = bond.amount.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(&env, Error::SlashAmountTooLarge);
        });

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(signer.clone()),
            BUMP_THRESHOLD,
            BUMP_TO,
        );

        Bonded { signer, amount }.publish(&env);
    }

    pub fn request_unbond(env: Env, signer: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        signer.require_auth();

        let mut bond = Self::get_bond(&env, &signer);

        let available = bond.amount.checked_sub(bond.locked).unwrap_or_else(|| {
            panic_with_error!(&env, Error::UnbondingStaked);
        });

        if amount > available {
            panic_with_error!(&env, Error::UnbondingStaked);
        }

        bond.amount = bond.amount.checked_sub(amount).unwrap_or_else(|| {
            panic_with_error!(&env, Error::UnbondingStaked);
        });

        bond.unbond_amount = bond.unbond_amount.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(&env, Error::SlashAmountTooLarge);
        });

        let config = Self::get_config(&env);
        bond.unbond_at = env
            .ledger()
            .timestamp()
            .checked_add(config.unbond_delay)
            .unwrap_or_else(|| {
                panic_with_error!(&env, Error::SlashAmountTooLarge);
            });

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(signer.clone()),
            BUMP_THRESHOLD,
            BUMP_TO,
        );

        UnbondRequested {
            signer,
            amount,
            unbond_at: bond.unbond_at,
        }
        .publish(&env);
    }

    pub fn withdraw(env: Env, signer: Address) {
        signer.require_auth();

        let mut bond = Self::get_bond(&env, &signer);

        if bond.unbond_amount == 0 {
            panic_with_error!(&env, Error::NothingToWithdraw);
        }

        if env.ledger().timestamp() < bond.unbond_at {
            panic_with_error!(&env, Error::TooEarlyToWithdraw);
        }

        let amount = bond.unbond_amount;
        bond.unbond_amount = 0;
        bond.unbond_at = 0;

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(signer.clone()),
            BUMP_THRESHOLD,
            BUMP_TO,
        );

        let config = Self::get_config(&env);
        let token_client = token::Client::new(&env, &config.token);

        token_client.transfer(&env.current_contract_address(), &signer, &amount);

        Withdrawn { signer, amount }.publish(&env);
    }

    pub fn lock(env: Env, signer: Address, market_id: u64) {
        let config = Self::get_config(&env);
        config.resolver.require_auth();

        let mut bond = Self::get_bond(&env, &signer);

        if bond.locked >= bond.amount {
            panic_with_error!(&env, Error::AlreadyLocked);
        }

        bond.locked = bond
            .locked
            .checked_add(bond.amount.checked_sub(bond.locked).unwrap())
            .unwrap();

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(signer.clone()),
            BUMP_THRESHOLD,
            BUMP_TO,
        );

        env.storage()
            .persistent()
            .set(&DataKey::Lock(signer.clone(), market_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Lock(signer.clone(), market_id),
            BUMP_THRESHOLD,
            BUMP_TO,
        );

        let locked_amount = bond.amount.checked_sub(bond.locked).unwrap_or(0i128);
        Locked {
            signer,
            market_id,
            amount: locked_amount,
        }
        .publish(&env);
    }

    pub fn unlock(env: Env, signer: Address, market_id: u64) {
        let config = Self::get_config(&env);
        config.resolver.require_auth();

        let key = DataKey::Lock(signer.clone(), market_id);
        if !env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::NotLocked);
        }

        env.storage().persistent().remove(&key);

        let bond = Self::get_bond(&env, &signer);
        Unlocked {
            signer,
            market_id,
            amount: bond.amount.checked_sub(bond.locked).unwrap_or(0i128),
        }
        .publish(&env);
    }

    pub fn slash(env: Env, signer: Address, bps: u32, reporter: Option<Address>) -> i128 {
        let config = Self::get_config(&env);
        config.resolver.require_auth();

        if bps == 0 || bps > 10_000 {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        let mut bond = Self::get_bond(&env, &signer);
        let slash_amount = bond
            .amount
            .checked_mul(bps as i128)
            .unwrap_or_else(|| {
                panic_with_error!(&env, Error::SlashAmountTooLarge);
            })
            .checked_div(10_000)
            .unwrap_or_else(|| {
                panic_with_error!(&env, Error::InsufficientSlashAmount);
            });

        if slash_amount <= 0 || slash_amount > bond.amount {
            panic_with_error!(&env, Error::SlashAmountTooLarge);
        }

        bond.amount = bond.amount.checked_sub(slash_amount).unwrap_or_else(|| {
            panic_with_error!(&env, Error::InsufficientSlashAmount);
        });

        if bond.locked > bond.amount {
            bond.locked = bond.amount;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(signer.clone()),
            BUMP_THRESHOLD,
            BUMP_TO,
        );

        let token_client = token::Client::new(&env, &config.token);
        token_client.transfer(
            &env.current_contract_address(),
            &config.slash_recipient,
            &slash_amount,
        );

        let reason = Symbol::new(&env, "slashed");
        Slashed {
            signer: signer.clone(),
            amount: slash_amount,
            reason,
            reporter: reporter.clone(),
        }
        .publish(&env);

        slash_amount
    }

    pub fn bond_of(env: Env, signer: Address) -> Bond {
        Self::get_bond(&env, &signer)
    }

    pub fn is_eligible(env: Env, signer: Address) -> bool {
        let config = Self::get_config(&env);
        let bond = Self::get_bond(&env, &signer);

        let available = bond.amount.checked_sub(bond.unbond_amount).unwrap_or(0i128);
        available >= config.min_stake
    }

    fn get_config(env: &Env) -> StakeConfig {
        env.storage()
            .instance()
            .get::<_, StakeConfig>(&DataKey::Config)
            .unwrap_or_else(|| {
                panic_with_error!(env, Error::InvalidConfig);
            })
    }

    fn get_bond(env: &Env, signer: &Address) -> Bond {
        env.storage()
            .persistent()
            .get::<_, Bond>(&DataKey::Bond(signer.clone()))
            .unwrap_or(Bond {
                amount: 0,
                locked: 0,
                unbond_amount: 0,
                unbond_at: 0,
            })
    }
}

#[cfg(test)]
#[soroban_sdk::contractclient(name = "SignerStakeClient")]
pub trait SignerStakeInterface {
    fn bond(env: Env, signer: Address, amount: i128);
    fn request_unbond(env: Env, signer: Address, amount: i128);
    fn withdraw(env: Env, signer: Address);
    fn lock(env: Env, signer: Address, market_id: u64);
    fn bond_of(env: Env, signer: Address) -> Bond;
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    const MIN_STAKE: i128 = 1_000;
    const UNBOND_DELAY: u64 = 100;
    const MINTED: i128 = 10_000;

    struct Fixture {
        env: Env,
        client: SignerStakeClient<'static>,
        token: Address,
        signer: Address,
    }

    fn setup() -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let signer = Address::generate(&env);
        let resolver = Address::generate(&env);
        let slash_recipient = Address::generate(&env);

        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &token).mint(&signer, &MINTED);

        let contract_id = env.register(
            SignerStakeContract,
            (
                admin,
                token.clone(),
                resolver,
                MIN_STAKE,
                UNBOND_DELAY,
                100u32,
                100u32,
                100u32,
                slash_recipient,
            ),
        );
        let client = SignerStakeClient::new(&env, &contract_id);

        Fixture {
            env,
            client,
            token,
            signer,
        }
    }

    #[test]
    fn test_bond_and_withdraw_after_delay() {
        let f = setup();
        let token = TokenClient::new(&f.env, &f.token);

        f.client.bond(&f.signer, &2_000i128);
        assert_eq!(token.balance(&f.signer), MINTED - 2_000);
        assert_eq!(f.client.bond_of(&f.signer).amount, 2_000i128);

        f.client.request_unbond(&f.signer, &1_000i128);
        let bond = f.client.bond_of(&f.signer);
        assert_eq!(bond.amount, 1_000i128);
        assert_eq!(bond.unbond_amount, 1_000i128);
        assert_eq!(bond.unbond_at, UNBOND_DELAY);

        f.env.ledger().set_timestamp(UNBOND_DELAY);
        f.client.withdraw(&f.signer);

        let bond = f.client.bond_of(&f.signer);
        assert_eq!(bond.unbond_amount, 0);
        assert_eq!(bond.unbond_at, 0);
        assert_eq!(token.balance(&f.signer), MINTED - 1_000);
    }

    #[test]
    fn test_cannot_withdraw_before_unbond_delay() {
        let f = setup();
        f.client.bond(&f.signer, &2_000i128);
        f.client.request_unbond(&f.signer, &1_000i128);

        let err = f.client.try_withdraw(&f.signer);
        assert!(err.is_err(), "withdraw before unbond_at must be rejected");
        assert_eq!(f.client.bond_of(&f.signer).unbond_amount, 1_000i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_cannot_unbond_locked_stake() {
        let f = setup();
        f.client.bond(&f.signer, &2_000i128);
        f.client.lock(&f.signer, &1u64);

        // `lock` locks the signer's whole bond, and `request_unbond` caps the
        // request at `amount - locked`, so any amount over zero is rejected.
        let bond = f.client.bond_of(&f.signer);
        assert_eq!(bond.locked, 2_000i128);
        assert_eq!(bond.amount, 2_000i128);

        f.client.request_unbond(&f.signer, &500i128);
    }
}
