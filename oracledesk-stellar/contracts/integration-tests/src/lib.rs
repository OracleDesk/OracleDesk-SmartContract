//! This crate ships no contract. Its tests drive several contracts together:
//! see `tests/treasury_caps_exhaustive/`.

pub mod world;

#[allow(clippy::too_many_arguments)]
pub mod market_core {
    soroban_sdk::contractimport!(file = "wasm/market_core.wasm");
}

#[allow(clippy::too_many_arguments)]
pub mod resolver {
    soroban_sdk::contractimport!(file = "wasm/resolver.wasm");
}

pub mod treasury {
    soroban_sdk::contractimport!(file = "wasm/treasury.wasm");
}

#[allow(clippy::too_many_arguments)]
pub mod reasoning_registry {
    soroban_sdk::contractimport!(file = "wasm/reasoning_registry.wasm");
}
