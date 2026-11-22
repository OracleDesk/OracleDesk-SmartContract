#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec,
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
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    }

    pub fn bond(env: Env, signer: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        signer.require_auth();

        let config = Self::get_config(&env);
        let token_client = token::Client::new(&env, &config.token);

        token_client.transfer(&signer, &env.current_contract_address(), &amount);

        let mut bond = Self::get_bond(&env, &signer);
        bond.amount = bond.amount.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(&env, Error::SlashAmountTooLarge);
        });

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Bond(signer.clone()), BUMP_THRESHOLD, BUMP_TO);

        Bonded { signer, amount }.publish(&env);
    }

    pub fn request_unbond(env: Env, signer: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        signer.require_auth();

        let mut bond = Self::get_bond(&env, &signer);

        let available = bond
            .amount
            .checked_sub(bond.locked)
            .unwrap_or_else(|| {
                panic_with_error!(&env, Error::UnbondingStaked);
            });

        if amount > available {
            panic_with_error!(&env, Error::UnbondingStaked);
        }

        bond.amount = bond.amount.checked_sub(amount).unwrap_or_else(|| {
            panic_with_error!(&env, Error::UnbondingStaked);
        });

        bond.unbond_amount = bond
            .unbond_amount
            .checked_add(amount)
            .unwrap_or_else(|| {
                panic_with_error!(&env, Error::SlashAmountTooLarge);
            });

        let config = Self::get_config(&env);
        bond.unbond_at = env.ledger().timestamp().checked_add(config.unbond_delay).unwrap_or_else(|| {
            panic_with_error!(&env, Error::SlashAmountTooLarge);
        });

        env.storage()
            .persistent()
            .set(&DataKey::Bond(signer.clone()), &bond);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Bond(signer.clone()), BUMP_THRESHOLD, BUMP_TO);

        UnbondRequested {
                signer,
                amount,
                unbond_at: bond.unbond_at,
            }.publish(&env);
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
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Bond(signer.clone()), BUMP_THRESHOLD, BUMP_TO);

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
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Bond(signer.clone()), BUMP_THRESHOLD, BUMP_TO);

        env.storage()
            .persistent()
            .set(&DataKey::Lock(signer.clone(), market_id), &true);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Lock(signer.clone(), market_id), BUMP_THRESHOLD, BUMP_TO);

        let locked_amount = bond.amount.checked_sub(bond.locked).unwrap_or_else(|| 0i128);
        Locked {
                signer,
                market_id,
                amount: locked_amount,
            }.publish(&env);
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
                amount: bond.amount.checked_sub(bond.locked).unwrap_or_else(|| 0i128),
            }.publish(&env);
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
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Bond(signer.clone()), BUMP_THRESHOLD, BUMP_TO);

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
            }.publish(&env);

        slash_amount
    }

    pub fn bond_of(env: Env, signer: Address) -> Bond {
        Self::get_bond(&env, &signer)
    }

    pub fn is_eligible(env: Env, signer: Address) -> bool {
        let config = Self::get_config(&env);
        let bond = Self::get_bond(&env, &signer);

        let available = bond.amount.checked_sub(bond.unbond_amount).unwrap_or_else(|| 0i128);
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
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    #[test]
    fn test_bond_and_withdraw_after_delay() {
        let env = Env::default();
        let signer = Address::generate(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let resolver = Address::generate(&env);
        let slash_recipient = Address::generate(&env);

        env.mock_all_auths();

        let contract = SignerStakeContract;
        contract.__constructor(
            env.clone(),
            admin.clone(),
            token.clone(),
            resolver,
            1_000i128,
            100,
            100,
            100,
            100,
            slash_recipient,
        );

        contract.bond(env.clone(), signer.clone(), 2_000i128);
        let bond = contract.bond_of(env.clone(), signer.clone());
        assert_eq!(bond.amount, 2_000i128);

        contract.request_unbond(env.clone(), signer.clone(), 1_000i128);
        let bond = contract.bond_of(env.clone(), signer.clone());
        assert_eq!(bond.amount, 1_000i128);
        assert_eq!(bond.unbond_amount, 1_000i128);

        env.ledger().set_timestamp(100);
        contract.withdraw(env.clone(), signer.clone());
        let bond = contract.bond_of(env.clone(), signer);
        assert_eq!(bond.unbond_amount, 0);
    }

    #[test]
    fn test_cannot_withdraw_locked_stake() {
        let env = Env::default();
        let signer = Address::generate(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let resolver = Address::generate(&env);
        let slash_recipient = Address::generate(&env);

        env.mock_all_auths();

        let contract = SignerStakeContract;
        contract.__constructor(
            env.clone(),
            admin,
            token,
            resolver.clone(),
            1_000i128,
            100,
            100,
            100,
            100,
            slash_recipient,
        );

        contract.bond(env.clone(), signer.clone(), 2_000i128);
        contract.lock(env.clone(), signer.clone(), 1u64);

        let bond = contract.bond_of(env.clone(), signer.clone());
        assert!(bond.locked > 0);

        contract.request_unbond(env.clone(), signer.clone(), 500i128);
        env.ledger().set_timestamp(100);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.withdraw(env.clone(), signer.clone());
        }));
        assert!(result.is_err());
    }
}
