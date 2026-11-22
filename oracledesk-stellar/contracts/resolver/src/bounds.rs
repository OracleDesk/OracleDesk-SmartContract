//! Protocol-wide bounds for resolution-spec parameters (#315).
//!
//! Every revealed spec must pass `validate_spec_bounds` before it is stored.
//! The constants below are deliberately conservative: they guard against
//! configs that would make a market permanently unresolvable (e.g. a
//! `dispute_window` longer than the market's total lifetime) or that use
//! arithmetic the resolver applies without overflow guards.

use soroban_sdk::Env;

use crate::{
    DisputableSignerConfig, Error, FallbackAuthority, HybridConfigV2, PriceConfig, ResolutionSpec,
    SignerConfig, WeightedKeyConfig,
};

/// Minimum `dispute_window` / `escalation_timeout` / `fallback_after` (1 minute).
pub const MIN_WINDOW_SECS: u64 = 60;
/// Maximum `dispute_window` or `escalation_timeout` (30 days).
pub const MAX_WINDOW_SECS: u64 = 30 * 86_400;
/// Maximum `max_staleness` for price configs (7 days).
pub const MAX_STALENESS_SECS: u64 = 7 * 86_400;
/// Minimum `max_staleness` for price configs (1 second).
pub const MIN_STALENESS_SECS: u64 = 1;

/// Returns `Err(InvalidConfig)` if `window` is outside `[MIN_WINDOW_SECS,
/// MAX_WINDOW_SECS]`.
fn check_window(window: u64) -> Result<(), Error> {
    if window < MIN_WINDOW_SECS || window > MAX_WINDOW_SECS {
        Err(Error::InvalidConfig)
    } else {
        Ok(())
    }
}

/// Returns `Err(InvalidConfig)` if `staleness` is outside `[MIN_STALENESS_SECS,
/// MAX_STALENESS_SECS]`.
fn check_staleness(staleness: u64) -> Result<(), Error> {
    if staleness < MIN_STALENESS_SECS || staleness > MAX_STALENESS_SECS {
        Err(Error::InvalidConfig)
    } else {
        Ok(())
    }
}

fn validate_price_bounds(cfg: &PriceConfig) -> Result<(), Error> {
    check_staleness(cfg.max_staleness)
}

fn validate_signers_bounds(cfg: &SignerConfig) -> Result<(), Error> {
    check_window(cfg.dispute_window)
}

fn validate_disputable_bounds(cfg: &DisputableSignerConfig) -> Result<(), Error> {
    check_window(cfg.dispute_window)?;
    check_window(cfg.escalation_timeout)
}

fn validate_weighted_bounds(cfg: &WeightedKeyConfig) -> Result<(), Error> {
    check_window(cfg.dispute_window)
}

fn validate_hybrid_bounds(cfg: &crate::HybridConfig) -> Result<(), Error> {
    check_staleness(cfg.price.max_staleness)?;
    check_window(cfg.fallback.dispute_window)?;
    check_window(cfg.fallback_after)
}

fn validate_hybrid_v2_bounds(cfg: &HybridConfigV2) -> Result<(), Error> {
    check_staleness(cfg.price.max_staleness)?;
    check_window(cfg.fallback_after)?;
    match &cfg.fallback {
        FallbackAuthority::Signers(s) => check_window(s.dispute_window),
        FallbackAuthority::WeightedKeys(w) => check_window(w.dispute_window),
        FallbackAuthority::Committee(_) => Ok(()),
    }
}

/// Validates that every time-based field in `rule` is within the protocol's
/// bounds. Called from `reveal` and `register_spec_v2` before the rule is
/// stored, in addition to the existing structural validation.
pub fn validate_spec_bounds(_env: &Env, rule: &ResolutionSpec) -> Result<(), Error> {
    match rule {
        ResolutionSpec::Price(cfg) => validate_price_bounds(cfg),
        ResolutionSpec::Signers(cfg) => validate_signers_bounds(cfg),
        ResolutionSpec::SignersDisputable(cfg) => validate_disputable_bounds(cfg),
        ResolutionSpec::WeightedKeys(cfg) => validate_weighted_bounds(cfg),
        ResolutionSpec::Committee(_) => Ok(()),
        ResolutionSpec::Hybrid(cfg) => validate_hybrid_bounds(cfg),
        ResolutionSpec::HybridV2(cfg) => validate_hybrid_v2_bounds(cfg),
    }
}
