#![no_main]

//! Weighted-key signature fuzzer for the resolver (issue #278).
//!
//! Builds a weighted committee from up to 8 deterministic Ed25519 keys,
//! checks that registration agrees with an independently written validity
//! rule, then runs up to `MAX_OPS` operations — batches of valid, forged,
//! duplicated and non-member signatures, admin cancels, time advances and
//! finalization — against a natively registered resolver + market-core.
//! An independent reference model predicts every result (`Ok`, a contract
//! error code, or a trap) and the stored state is compared with the model
//! after every op.
//!
//! Input encoding (little-endian, see `seed_encoding::resolver_sig_seed`):
//!
//! ```text
//! n_keys:u8 (1 + n % 8) { key:u8 weight:u8 }*n  threshold:u16  n_ops:u8
//! op := 0 Submit  outcome:u8 round_delta:i8 n_entries:u8 entry*
//!     | 1 Cancel | 2 Advance secs:u16 | 3 Finalize
//! entry := 0 Valid k | 1 WrongOutcome k | 2 WrongRound k | 3 WrongDomain k
//!        | 4 Corrupt k pos | 5 NonMember k | 6 Dup k
//! ```
//!
//! Invariants after every op: stored per-round weight equals the model; no
//! key counts twice in a round (`SigSeen` equals the model's seen set); a
//! proposal exists iff an outcome first crossed the threshold in the current
//! round and `submit_signatures` never replaces it; after `Cancel` old-round
//! signatures fail with `StaleRound`; `Finalize` succeeds only after the
//! dispute window with the current round's weight at the threshold; nothing
//! panics except the predicted trap (an invalid signature from an unseen
//! member aborts the whole batch, which the model treats as a no-op).

use fpmm_fuzz::resolver_harness::{
    args, message, outcome_of, sign, sign_bytes, signing_key, weighted_config,
    world_with_weighted, Domain, Reader, World, CLOSE_TIME, DISPUTE_WINDOW, MAX_OPS,
    NON_MEMBER_SEED, POOL,
};
use libfuzzer_sys::fuzz_target;
use resolver::{
    AttestedOutcome, DataKey, Error, GuardianReason, Outcome, ResolutionState, SignerProposalV2,
    MAX_CANCELS_PER_MARKET, MAX_SIGS_PER_CALL, MAX_WEIGHTED_SIGNERS,
};
use soroban_sdk::{BytesN, Vec};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Once;

#[derive(Clone, Copy, Debug)]
enum Entry {
    Valid(u8),
    WrongOutcome(u8),
    WrongRound(u8),
    WrongDomain(u8),
    Corrupt(u8, u8),
    NonMember(u8),
    Dup(u8),
}

#[derive(Debug)]
enum SigOp {
    Submit {
        yes: bool,
        round_delta: i8,
        entries: std::vec::Vec<Entry>,
    },
    Cancel,
    Advance {
        secs: u16,
    },
    Finalize,
}

struct Input {
    weights: std::vec::Vec<(u8, u8)>,
    threshold: u16,
    ops: std::vec::Vec<SigOp>,
}

fn parse(data: &[u8]) -> Option<Input> {
    let mut r = Reader::new(data);
    let n = 1 + (r.u8()? as usize % POOL);
    let mut weights = std::vec::Vec::new();
    for _ in 0..n {
        weights.push((r.u8()?, r.u8()?));
    }
    let threshold = r.u16()?;
    let count = r.u8().unwrap_or(0) as usize;
    let mut ops = std::vec::Vec::new();
    for _ in 0..count.min(MAX_OPS) {
        let Some(tag) = r.u8() else { break };
        let op = match tag % 4 {
            0 => {
                let (Some(o), Some(d), Some(m)) = (r.u8(), r.u8(), r.u8()) else {
                    break;
                };
                let mut entries = std::vec::Vec::new();
                // Up to 40 so `TooManySignatures` (> 32) is reachable.
                for _ in 0..(m as usize % 41) {
                    let (Some(t), Some(k)) = (r.u8(), r.u8()) else {
                        break;
                    };
                    entries.push(match t % 7 {
                        0 => Entry::Valid(k),
                        1 => Entry::WrongOutcome(k),
                        2 => Entry::WrongRound(k),
                        3 => Entry::WrongDomain(k),
                        4 => Entry::Corrupt(k, r.u8().unwrap_or(0)),
                        5 => Entry::NonMember(k),
                        _ => Entry::Dup(k),
                    });
                }
                SigOp::Submit {
                    yes: o % 2 == 0,
                    round_delta: d as i8,
                    entries,
                }
            }
            1 => SigOp::Cancel,
            2 => SigOp::Advance {
                secs: r.u16().unwrap_or(0),
            },
            _ => SigOp::Finalize,
        };
        ops.push(op);
    }
    Some(Input {
        weights,
        threshold,
        ops,
    })
}

/// Independent copy of the weighted-config rules (not a call into the
/// contract): 1..=MAX_WEIGHTED_SIGNERS keys, positive weights, distinct
/// pubkeys, a non-overflowing total, `0 < threshold <= total`, non-zero
/// dispute window.
fn valid_weighted(keys: &[[u8; 32]], weights: &[u32], threshold: u32, window: u64) -> bool {
    if keys.is_empty() || keys.len() > MAX_WEIGHTED_SIGNERS as usize || window == 0 {
        return false;
    }
    let mut total: u32 = 0;
    let mut distinct = BTreeSet::new();
    for (k, w) in keys.iter().zip(weights) {
        if *w == 0 || !distinct.insert(*k) {
            return false;
        }
        match total.checked_add(*w) {
            Some(t) => total = t,
            None => return false,
        }
    }
    threshold != 0 && threshold <= total
}

#[derive(Debug, PartialEq)]
enum Expect<T> {
    Ok(T),
    Err(Error),
    Trap,
    /// Any contract error (the code is market-core's, mapped).
    AnyErr,
}

struct Model {
    members: BTreeMap<[u8; 32], u32>,
    threshold: u32,
    round: u32,
    /// `(round, pubkey)` that already counted (for either outcome).
    seen: BTreeSet<(u32, [u8; 32])>,
    /// `(round, yes)` -> accumulated weight.
    weight: BTreeMap<(u32, bool), u32>,
    proposal: Option<(bool, u64)>,
    cancels: u32,
    finalized: bool,
}

struct Prepared {
    pubkey: [u8; 32],
    sig: (BytesN<32>, BytesN<64>),
    valid: bool,
}

fn prepare(w: &World, e: Entry, round: u32, outcome: Outcome) -> std::vec::Vec<Prepared> {
    let other = match outcome {
        Outcome::Yes => Outcome::No,
        Outcome::No => Outcome::Yes,
    };
    let pool = |k: u8| &w.keys[k as usize % POOL];
    let mk = |key: &ed25519_dalek::SigningKey, msg_round: u32, o: Outcome, d: Domain, valid: bool| Prepared {
        pubkey: key.verifying_key().to_bytes(),
        sig: sign_bytes(w, key, &message(w, msg_round, o, d)),
        valid,
    };
    match e {
        Entry::Valid(k) => std::vec![mk(pool(k), round, outcome, Domain::Real, true)],
        Entry::WrongOutcome(k) => std::vec![mk(pool(k), round, other, Domain::Real, false)],
        Entry::WrongRound(k) => {
            std::vec![mk(pool(k), round.wrapping_add(1), outcome, Domain::Real, false)]
        }
        Entry::WrongDomain(k) => {
            // Only the domain tag, network id or resolver address differs.
            let d = match (k >> 3) % 3 {
                0 => Domain::Tag,
                1 => Domain::Network,
                _ => Domain::Resolver,
            };
            std::vec![mk(pool(k), round, outcome, d, false)]
        }
        Entry::Corrupt(k, pos) => {
            let mut p = mk(pool(k), round, outcome, Domain::Real, false);
            let mut bytes = p.sig.1.to_array();
            bytes[pos as usize % 64] ^= 0x5a;
            p.sig.1 = BytesN::from_array(&w.env, &bytes);
            std::vec![p]
        }
        Entry::NonMember(k) => {
            let key = signing_key(NON_MEMBER_SEED + k % POOL as u8);
            std::vec![mk(&key, round, outcome, Domain::Real, true)]
        }
        Entry::Dup(k) => std::vec![
            mk(pool(k), round, outcome, Domain::Real, true),
            mk(pool(k), round, outcome, Domain::Real, true),
        ],
    }
}

impl Model {
    fn submit(&mut self, now: u64, yes: bool, round: u32, batch: &[Prepared]) -> Expect<()> {
        if self.finalized {
            return Expect::Err(Error::AlreadyFinalized);
        }
        if batch.len() > MAX_SIGS_PER_CALL as usize {
            return Expect::Err(Error::TooManySignatures);
        }
        if round != self.round {
            return Expect::Err(Error::StaleRound);
        }
        let mut seen = self.seen.clone();
        let before = *self.weight.get(&(round, yes)).unwrap_or(&0);
        let mut weight = before;
        for p in batch {
            let Some(w) = self.members.get(&p.pubkey) else {
                continue;
            };
            if seen.contains(&(round, p.pubkey)) {
                continue;
            }
            if !p.valid {
                // `ed25519_verify` traps: the whole call rolls back.
                return Expect::Trap;
            }
            seen.insert((round, p.pubkey));
            weight += w;
        }
        if weight == before {
            return Expect::Ok(());
        }
        self.seen = seen;
        self.weight.insert((round, yes), weight);
        if before < self.threshold && weight >= self.threshold && self.proposal.is_none() {
            self.proposal = Some((yes, now));
        }
        Expect::Ok(())
    }

    fn cancel(&mut self, now: u64) -> Expect<()> {
        let Some((_, at)) = self.proposal else {
            return Expect::Err(Error::NoProposal);
        };
        if now >= at.saturating_add(DISPUTE_WINDOW) {
            return Expect::Err(Error::DisputeWindowClosed);
        }
        if self.cancels >= MAX_CANCELS_PER_MARKET {
            return Expect::Err(Error::TooManyCancels);
        }
        self.cancels += 1;
        self.proposal = None;
        self.round += 1;
        Expect::Ok(())
    }

    fn finalize(&mut self, now: u64) -> Expect<AttestedOutcome> {
        let Some((yes, at)) = self.proposal else {
            return Expect::Err(Error::NoProposal);
        };
        if now < at + DISPUTE_WINDOW {
            return Expect::Err(Error::DisputeWindowOpen);
        }
        if *self.weight.get(&(self.round, yes)).unwrap_or(&0) < self.threshold {
            return Expect::Err(Error::ThresholdNotReached);
        }
        if self.finalized {
            // market-core refuses to resolve twice; its code is mapped.
            return Expect::AnyErr;
        }
        self.finalized = true;
        Expect::Ok(if yes {
            AttestedOutcome::Yes
        } else {
            AttestedOutcome::No
        })
    }
}

fn check<T: PartialEq + std::fmt::Debug>(
    what: &str,
    expect: Expect<T>,
    got: Result<T, Option<Error>>,
) {
    match (&expect, &got) {
        (Expect::Ok(a), Ok(b)) if a == b => {}
        (Expect::Err(a), Err(Some(b))) if a == b => {}
        (Expect::Trap, Err(None)) => {}
        (Expect::AnyErr, Err(Some(_))) => {}
        _ => panic!("{what}: model {expect:?}, contract {got:?}"),
    }
}

fn read<V: soroban_sdk::TryFromVal<soroban_sdk::Env, soroban_sdk::Val>>(
    w: &World,
    key: &DataKey,
) -> Option<V> {
    w.env
        .as_contract(&w.resolver, || w.env.storage().persistent().get(key))
}

fn assert_state(w: &World, m: &Model) {
    let c = w.client();
    assert_eq!(c.current_round(&w.market_id), m.round, "round");
    for round in 0..=m.round {
        for yes in [true, false] {
            let o = if yes { Outcome::Yes } else { Outcome::No };
            let stored: u32 = read(w, &DataKey::Weight(w.market_id, round, o)).unwrap_or(0);
            assert_eq!(
                stored,
                *m.weight.get(&(round, yes)).unwrap_or(&0),
                "weight round {round} yes={yes}"
            );
        }
        for pk in m.members.keys() {
            let has = w.env.as_contract(&w.resolver, || {
                w.env.storage().persistent().has(&DataKey::SigSeen(
                    w.market_id,
                    round,
                    BytesN::from_array(&w.env, pk),
                ))
            });
            assert_eq!(has, m.seen.contains(&(round, *pk)), "SigSeen counted twice or lost");
        }
    }
    let proposal: Option<SignerProposalV2> = read(w, &DataKey::ProposalV2(w.market_id));
    let model = m.proposal.map(|(yes, at)| SignerProposalV2 {
        outcome: if yes {
            AttestedOutcome::Yes
        } else {
            AttestedOutcome::No
        },
        proposed_at: at,
    });
    assert_eq!(proposal, model, "proposal");
    assert_eq!(
        c.state(&w.market_id) == ResolutionState::Finalized,
        m.finalized,
        "finalized"
    );
}

static LAYOUT: Once = Once::new();

/// Proves once per process that the harness's message layout is the
/// contract's: a signature over the local message is accepted and counted.
fn attestation_layout_matches() {
    LAYOUT.call_once(|| {
        let (w, cfg) = world_with_weighted(|env, keys| weighted_config(env, keys, &[(0, 1)], 1));
        w.client().register_weighted_key_spec(&w.market_id, &cfg);
        w.env.ledger_set(CLOSE_TIME);
        let batch = Vec::from_array(&w.env, [sign(&w, 0, 0, Outcome::Yes)]);
        w.client()
            .submit_signatures(&w.market_id, &Outcome::Yes, &0, &batch);
        let stored: u32 = read(&w, &DataKey::Weight(w.market_id, 0, Outcome::Yes)).unwrap_or(0);
        assert_eq!(stored, 1, "local attestation_message layout differs from the contract");
    });
}

trait LedgerSet {
    fn ledger_set(&self, t: u64);
}
impl LedgerSet for soroban_sdk::Env {
    fn ledger_set(&self, t: u64) {
        use soroban_sdk::testutils::Ledger as _;
        self.ledger().set_timestamp(t);
    }
}

fuzz_target!(|data: &[u8]| {
    attestation_layout_matches();
    let Some(input) = parse(data) else { return };

    let (w, cfg) = world_with_weighted(|env, keys| {
        weighted_config(env, keys, &input.weights, input.threshold)
    });
    let keys: std::vec::Vec<[u8; 32]> = input
        .weights
        .iter()
        .map(|(k, _)| w.keys[*k as usize % POOL].verifying_key().to_bytes())
        .collect();
    let weights: std::vec::Vec<u32> = input.weights.iter().map(|(_, wt)| *wt as u32).collect();
    let valid = valid_weighted(&keys, &weights, input.threshold as u32, DISPUTE_WINDOW);
    let registered = outcome_of(w.client().try_register_weighted_key_spec(&w.market_id, &cfg));
    match (valid, &registered) {
        (true, Ok(())) => {}
        (false, Err(Some(Error::InvalidConfig))) => return,
        _ => panic!("register_weighted_key_spec: model valid={valid}, contract {registered:?}"),
    }

    let mut m = Model {
        members: keys.iter().copied().zip(weights.iter().copied()).collect(),
        threshold: input.threshold as u32,
        round: 0,
        seen: BTreeSet::new(),
        weight: BTreeMap::new(),
        proposal: None,
        cancels: 0,
        finalized: false,
    };
    w.env.ledger_set(CLOSE_TIME);
    assert_state(&w, &m);

    for op in &input.ops {
        match op {
            SigOp::Submit {
                yes,
                round_delta,
                entries,
            } => {
                let outcome = if *yes { Outcome::Yes } else { Outcome::No };
                // -2..=2 around the current round: reaches both the current
                // round and `StaleRound` on either side.
                let round = (m.round as i64 + (*round_delta as i64 % 3)).max(0) as u32;
                let batch: std::vec::Vec<Prepared> = entries
                    .iter()
                    .flat_map(|e| prepare(&w, *e, round, outcome))
                    .collect();
                let mut sigs = Vec::new(&w.env);
                for p in &batch {
                    sigs.push_back(p.sig.clone());
                }
                let expect = m.submit(w.now(), *yes, round, &batch);
                let got = outcome_of(w.client().try_submit_signatures(
                    &w.market_id,
                    &outcome,
                    &round,
                    &sigs,
                ));
                check("submit_signatures", expect, got);
            }
            SigOp::Cancel => {
                let reason = GuardianReason::DisputeUpheld;
                w.auth(
                    &w.admin,
                    "cancel_proposal",
                    args(&w.env, (w.market_id, reason.clone())),
                );
                let expect = m.cancel(w.now());
                let got = outcome_of(w.client().try_cancel_proposal(&w.market_id, &reason));
                check("cancel_proposal", expect, got);
            }
            SigOp::Advance { secs } => w.advance(*secs as u64),
            SigOp::Finalize => {
                let expect = m.finalize(w.now());
                let got = outcome_of(w.client().try_finalize_signers(&w.market_id));
                check("finalize_signers", expect, got);
            }
        }
        assert_state(&w, &m);
    }
});
