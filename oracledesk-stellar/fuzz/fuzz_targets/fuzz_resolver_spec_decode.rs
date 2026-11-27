#![no_main]

//! Resolution-spec decoding and `register_spec_v2` fuzzer (issue #278).
//!
//! The first byte picks the mode:
//!
//! * even — **raw**: the rest is fed to `ResolutionSpecV2::from_xdr`.
//!   Decoding must never panic, and anything that decodes must re-encode
//!   byte-for-byte. Budget exhaustion is an expected error (the budget is
//!   unlimited here; inputs are capped by `-max_len`).
//! * odd — **structured**: the rest describes a rule and an envelope
//!   (version, salt, network id, market-core, commitment). A market is
//!   created committing to it, `register_spec_v2` is called, and its result
//!   must match the model's precedence: `InvalidConfig` (version / salt) →
//!   `DomainMismatch` → `MarketAlreadyConfigured` → `InvalidConfig`
//!   (`validate_rule`) → `SpecHashMismatch`. A successful reveal configures
//!   the market (a second reveal is `MarketAlreadyConfigured`; every
//!   non-price rule leaves `Unconfigured`).
//!
//! Reachability invariant for signer rules: if validation accepts a
//! `Signers` / `SignersDisputable` / `Hybrid` fallback rule, its threshold
//! must be reachable by *distinct* addresses (`record_attestation` dedups per
//! address). Today `validate_rule` does not reject duplicates, so this
//! reports finding `dup-signers` (tracked by the ignored regression test
//! `signers_rule_rejects_duplicate_addresses`). CI lists it in
//! `ORACLEDESK_FUZZ_ALLOW` until the fix lands.
//!
//! Structured encoding (see `seed_encoding::resolver_spec_seed`):
//!
//! ```text
//! flags:u8 version:u8 kind:u8 threshold:u8 window:u8 n:u8 member:u8*n extra:u8 extra2:u8
//! flags bit0 version=2 | bit1 zero salt | bit2 wrong network | bit3 wrong core
//!       bit4 commit to a different salt | bit5 reveal twice
//! ```

use fpmm_fuzz::resolver_harness::{allowed, outcome_of, pubkey, Reader, World, POOL};
use libfuzzer_sys::fuzz_target;
use resolver::{
    spec_v2_hash, DisputableSignerConfig, Error, Escalation, HybridConfig, OracleAsset,
    PriceConfig, PriceDirection, ResolutionSpec, ResolutionSpecV2, ResolutionState, SignerConfig,
    WeightedKey, WeightedKeyConfig, CommitteeRef, MAX_WEIGHTED_SIGNERS,
};
use soroban_sdk::{
    testutils::Address as _, xdr::ToXdr, Address, Bytes,
    BytesN, Env, Symbol, Vec,
};
use std::collections::BTreeSet;

/// Decodes like `ResolutionSpecV2::from_xdr` (XDR -> `ScVal` -> `Val` ->
/// the contract type) but through the fallible steps only: the test host
/// escalates a decode error inside `from_xdr` to a panic (and libFuzzer
/// aborts on any panic), while in a contract it is a clean trap. Malformed
/// input, length/depth limits and conversion failures are therefore
/// ordinary errors here; any panic left is a finding.
fn raw(data: &[u8]) {
    use soroban_sdk::xdr::{Limits, ReadXdr, ScVal};
    use soroban_sdk::{TryFromVal, Val};
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let limits = Limits {
        depth: 64,
        len: data.len(),
    };
    let Ok(scval) = ScVal::from_xdr(data, limits) else {
        return;
    };
    let Ok(val) = Val::try_from_val(&env, &scval) else {
        return;
    };
    let Ok(spec) = ResolutionSpecV2::try_from_val(&env, &val) else {
        return;
    };
    assert_eq!(
        spec.to_xdr(&env),
        Bytes::from_slice(&env, data),
        "accepted envelope does not round-trip"
    );
}

/// The rule plus what the model needs to judge it.
struct Built {
    rule: ResolutionSpec,
    valid: bool,
    /// `(distinct signers, threshold)` for signer-based rules.
    signers: Option<(usize, u32)>,
    is_price: bool,
}

fn addrs(pool: &[Address], idx: &[u8]) -> (Vec<Address>, usize) {
    let mut v = Vec::new(&pool[0].env().clone());
    let mut distinct = BTreeSet::new();
    for i in idx {
        let i = *i as usize % POOL;
        v.push_back(pool[i].clone());
        distinct.insert(i);
    }
    (v, distinct.len())
}

/// Builds a rule and judges it with an independent copy of `validate_rule`.
fn build(env: &Env, w: &World, kind: u8, thr: u8, window: u8, idx: &[u8], e1: u8, e2: u8) -> Built {
    let pool: std::vec::Vec<Address> = w.members.to_vec();
    let price = |threshold: i128, staleness: u64| PriceConfig {
        reflector: w.core.clone(),
        asset: OracleAsset::Other(Symbol::new(env, "XLM")),
        threshold,
        direction: PriceDirection::Above,
        max_staleness: staleness,
    };
    let thr = thr as u32 % 6;
    let window = window as u64 % 3;
    match kind % 6 {
        0 => {
            let threshold = e1 as i128 - 8;
            let staleness = e2 as u64 % 3;
            Built {
                rule: ResolutionSpec::Price(price(threshold, staleness)),
                valid: threshold >= 0 && staleness != 0,
                signers: None,
                is_price: true,
            }
        }
        1 => {
            let (signers, distinct) = addrs(&pool, idx);
            let n = signers.len();
            Built {
                rule: ResolutionSpec::Signers(SignerConfig {
                    signers,
                    threshold: thr,
                    dispute_window: window,
                }),
                valid: n > 0 && thr != 0 && thr <= n && window != 0,
                signers: Some((distinct, thr)),
                is_price: false,
            }
        }
        2 => {
            let mut signers = Vec::new(env);
            let mut seen = BTreeSet::new();
            let (mut total, mut ok) = (0u32, !idx.is_empty() && idx.len() <= MAX_WEIGHTED_SIGNERS as usize);
            for (j, i) in idx.iter().enumerate() {
                let weight = (e1 as u32 >> (j % 8)) & 3;
                let k = &w.keys[*i as usize % POOL];
                ok &= weight != 0 && seen.insert(*i as usize % POOL);
                total += weight;
                signers.push_back(WeightedKey {
                    pubkey: pubkey(env, k),
                    weight,
                });
            }
            Built {
                rule: ResolutionSpec::WeightedKeys(WeightedKeyConfig {
                    signers,
                    weight_threshold: thr,
                    dispute_window: window,
                }),
                valid: ok && window != 0 && thr != 0 && thr <= total,
                signers: None,
                is_price: false,
            }
        }
        3 => {
            let (signers, distinct) = addrs(&pool, idx);
            let n = signers.len();
            let bond = e1 as i128 % 3;
            let timeout = e2 as u64 % 3;
            Built {
                rule: ResolutionSpec::SignersDisputable(DisputableSignerConfig {
                    signers,
                    threshold: thr,
                    dispute_window: window,
                    dispute_bond: bond,
                    escalation: Escalation::Guardian,
                    escalation_timeout: timeout,
                }),
                valid: n > 0 && thr != 0 && thr <= n && window != 0 && bond > 0 && timeout != 0,
                signers: Some((distinct, thr)),
                is_price: false,
            }
        }
        4 => Built {
            rule: ResolutionSpec::Committee(CommitteeRef {
                committee_id: e1 as u64,
                min_epoch: e2 as u32 % 3,
                max_rotation_delta: 1,
                dispute_window: window,
            }),
            valid: window != 0,
            signers: None,
            is_price: false,
        },
        _ => {
            let (signers, distinct) = addrs(&pool, idx);
            let n = signers.len();
            let staleness = 1 + e1 as u64 % 3;
            let after = e2 as u64 % 5;
            Built {
                rule: ResolutionSpec::Hybrid(HybridConfig {
                    price: price(10, staleness),
                    fallback: SignerConfig {
                        signers,
                        threshold: thr,
                        dispute_window: window,
                    },
                    fallback_after: after,
                }),
                valid: n > 0 && thr != 0 && thr <= n && window != 0 && after > 0 && after >= staleness,
                signers: Some((distinct, thr)),
                is_price: false,
            }
        }
    }
}

fn structured(data: &[u8]) {
    let mut r = Reader::new(data);
    let (Some(flags), Some(version), Some(kind), Some(thr), Some(window), Some(n)) =
        (r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8())
    else {
        return;
    };
    let mut idx = std::vec::Vec::new();
    for _ in 0..(n % 6) {
        idx.push(r.u8().unwrap_or(0));
    }
    let (e1, e2) = (r.u8().unwrap_or(0), r.u8().unwrap_or(0));

    let version = if flags & 1 != 0 { 2 } else { version as u32 };
    let zero_salt = flags & 2 != 0;
    let wrong_network = flags & 4 != 0;
    let wrong_core = flags & 8 != 0;
    let wrong_commit = flags & 16 != 0;
    let twice = flags & 32 != 0;

    // A world with a placeholder market; the real market (next id) is
    // created below once the envelope it commits to is known.
    let w = World::new(|env, _core| {
        let rule = ResolutionSpec::Committee(CommitteeRef {
            committee_id: 0,
            min_epoch: 0,
            max_rotation_delta: 0,
            dispute_window: 1,
        });
        (rule, BytesN::from_array(env, &[0u8; 32]))
    });
    let env = &w.env;
    let b = build(env, &w, kind, thr, window, &idx, e1, e2);
    let salt = |v: u8| BytesN::from_array(env, &[v; 32]);
    let spec = ResolutionSpecV2 {
        version,
        network_id: if wrong_network {
            BytesN::from_array(env, &[0xee; 32])
        } else {
            env.ledger().network_id()
        },
        market_core: if wrong_core {
            Address::generate(env)
        } else {
            w.core.clone()
        },
        salt: if zero_salt { salt(0) } else { salt(9) },
        rule: b.rule.clone(),
    };
    let commitment = if wrong_commit {
        spec_v2_hash(env, &ResolutionSpecV2 {
            salt: salt(10),
            ..spec.clone()
        })
    } else {
        spec_v2_hash(env, &spec)
    };
    let market_id = w.create_market_committing(&commitment);

    let expect = if version != 2 || zero_salt {
        Err(Error::InvalidConfig)
    } else if wrong_network || wrong_core {
        Err(Error::DomainMismatch)
    } else if !b.valid {
        Err(Error::InvalidConfig)
    } else if wrong_commit {
        Err(Error::SpecHashMismatch)
    } else {
        Ok(())
    };
    let c = w.client();
    let got = outcome_of(c.try_register_spec_v2(&market_id, &spec));
    assert_eq!(got, expect.map_err(Some), "register_spec_v2 precedence");

    if got.is_ok() {
        if !b.is_price {
            assert_ne!(c.state(&market_id), ResolutionState::Unconfigured, "reveal left Unconfigured");
        }
        if twice {
            assert_eq!(
                outcome_of(c.try_register_spec_v2(&market_id, &spec)),
                Err(Some(Error::MarketAlreadyConfigured))
            );
        }
        if let Some((distinct, threshold)) = b.signers {
            if (distinct as u32) < threshold && !allowed("dup-signers") {
                panic!(
                    "finding dup-signers: accepted signer rule needs {threshold} attestations \
                     but has only {distinct} distinct addresses (quorum unreachable)"
                );
            }
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((mode, rest)) = data.split_first() else {
        return;
    };
    if mode % 2 == 0 {
        raw(rest);
    } else {
        structured(rest);
    }
});
