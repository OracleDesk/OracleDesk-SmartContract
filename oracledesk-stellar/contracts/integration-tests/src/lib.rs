//! This crate ships no contract. Its tests drive several contracts together:
//! see `tests/treasury_caps_exhaustive/`.

pub mod world;

pub mod market_core {
    #![allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "wasm/market_core.wasm");
}

pub mod resolver {
    #![allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "wasm/resolver.wasm");
}

pub mod treasury {
    #![allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "wasm/treasury.wasm");
}

pub mod reasoning_registry {
    #![allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "wasm/reasoning_registry.wasm");
}
