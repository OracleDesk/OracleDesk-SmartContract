//! Re-export of the shared storage TTL policy (issue #371).
//!
//! This module used to be a byte-identical copy in every contract crate,
//! because a contract crate could not depend on another contract crate's
//! wasm exports (their `#[contractimpl]` exports collide on
//! `__constructor`; see `docs/adr/0002-cross-contract-calls.md`).
//! `oracledesk-types` is a types-only crate with no `#[contract]` /
//! `#[contractimpl]` items, so it never hits that collision, and now holds
//! the single copy of this policy (`oracledesk_types::ttl`). See its doc
//! comment for the policy itself; call sites here are unaffected (`ttl::*`
//! still resolves to the same names).

pub use oracledesk_types::ttl::*;
