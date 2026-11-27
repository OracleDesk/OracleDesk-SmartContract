#![no_main]

//! Committee-resolution fuzzer for the resolver (issue #278).
//!
//! A committee of pool members backs one market through a `CommitteeRef`
//! with rotation bounds. Ops attest, rotate the committee (propose /
//! execute / cancel), advance time, finalize and cancel proposals. An
//! independent model tracks the epoch, the current members and threshold,
//! the pending rotation and every attestation, and predicts each result.
//!
//! Input encoding (see `seed_encoding::resolver_committee_seed`):
//!
//! ```text
//! members_mask:u8 threshold:u8 min_epoch:u8 max_delta:u8 n_ops:u8
//! op := 0 Attest member:u8 outcome:u8 | 1 ProposeRotation mask:u8 threshold:u8
//!     | 2 ExecuteRotation | 3 CancelRotation | 4 Advance secs:u16 (x 64)
//!     | 5 Finalize | 6 CancelProposal
//! ```
//!
//! Invariants: `RotationBoundExceeded` exactly when the epoch is outside
//! `[min_epoch, min_epoch + max_rotation_delta]`; the votes `has_quorum`
//! counts equal the attestations of *current* members (checked through
//! every `finalize_signers` result); `finalize_signers` never succeeds
//! without quorum. Whether a quorum reached in epoch `e` survives a
//! rotation is only logged: `AttestEpoch` semantics are still open.

use fpmm_fuzz::resolver_harness::{
    args, outcome_of, world_with_committee, CommitteeRefParams, Reader, World, CLOSE_TIME,
    DISPUTE_WINDOW, MAX_OPS, POOL,
};
use libfuzzer_sys::fuzz_target;
use resolver::{
    AttestedOutcome, Error, GuardianReason, MAX_CANCELS_PER_MARKET, MIN_ROTATION_DELAY,
};
use soroban_sdk::{testutils::Ledger as _, Address, Vec};
use std::collections::BTreeSet;

#[derive(Debug)]
enum Op {
    Attest(u8, u8),
    ProposeRotation(u8, u8),
    ExecuteRotation,
    CancelRotation,
    Advance(u16),
    Finalize,
    CancelProposal,
}

fn mask_members(mask: u8) -> std::vec::Vec<u8> {
    (0..POOL as u8).filter(|i| mask & (1 << i) != 0).collect()
}

fn outcome(b: u8) -> AttestedOutcome {
    match b % 3 {
        0 => AttestedOutcome::Yes,
        1 => AttestedOutcome::No,
        _ => AttestedOutcome::Invalid,
    }
}

#[derive(Debug, PartialEq)]
enum Expect<T> {
    Ok(T),
    Err(Error),
    AnyErr,
}

struct Model {
    epoch: u32,
    members: std::vec::Vec<u8>,
    threshold: u32,
    min_epoch: u32,
    max_delta: u32,
    pending: Option<(std::vec::Vec<u8>, u32, u64)>,
    attested: BTreeSet<(u8, u8)>, // (outcome % 3, member)
    proposal: Option<(AttestedOutcome, u64)>,
    cancels: u32,
    finalized: bool,
}

fn oidx(o: AttestedOutcome) -> u8 {
    match o {
        AttestedOutcome::Yes => 0,
        AttestedOutcome::No => 1,
        AttestedOutcome::Invalid => 2,
    }
}

impl Model {
    fn in_bounds(&self) -> bool {
        self.epoch >= self.min_epoch && self.epoch - self.min_epoch <= self.max_delta
    }

    /// Votes of current members only, as `has_quorum` counts them.
    fn quorum(&self, o: AttestedOutcome) -> bool {
        self.in_bounds()
            && self
                .members
                .iter()
                .filter(|m| self.attested.contains(&(oidx(o), **m)))
                .count() as u32
                >= self.threshold
    }

    fn attest(&mut self, now: u64, member: u8, o: AttestedOutcome) -> Expect<()> {
        if !self.in_bounds() {
            return Expect::Err(Error::RotationBoundExceeded);
        }
        if !self.members.contains(&member) {
            return Expect::Err(Error::NotSigner);
        }
        if self.finalized {
            return Expect::Err(Error::AlreadyFinalized);
        }
        if !self.attested.insert((oidx(o), member)) {
            return Expect::Err(Error::AlreadyAttested);
        }
        let may_propose = match self.proposal {
            None => true,
            Some((p, _)) => o == AttestedOutcome::Invalid && p != AttestedOutcome::Invalid,
        };
        if self.quorum(o) && may_propose {
            self.proposal = Some((o, now));
        }
        Expect::Ok(())
    }

    fn propose_rotation(&mut self, now: u64, mask: u8, threshold: u8) -> Expect<u64> {
        if self.pending.is_some() {
            return Expect::Err(Error::RotationPending);
        }
        let members = mask_members(mask);
        if members.is_empty() || threshold == 0 || threshold as usize > members.len() {
            return Expect::Err(Error::InvalidConfig);
        }
        let at = now + MIN_ROTATION_DELAY;
        self.pending = Some((members, threshold as u32, at));
        Expect::Ok(at)
    }

    fn execute_rotation(&mut self, now: u64) -> Expect<u32> {
        match self.pending.take() {
            Some((members, threshold, at)) if now >= at => {
                let had = self.proposal.map(|(o, _)| self.quorum(o));
                self.epoch += 1;
                self.members = members;
                self.threshold = threshold;
                if let (Some(before), Some((o, _))) = (had, self.proposal) {
                    // Logged, not asserted (AttestEpoch semantics are open).
                    eprintln!(
                        "rotation to epoch {}: quorum for {o:?} before={before} after={}",
                        self.epoch,
                        self.quorum(o)
                    );
                }
                Expect::Ok(self.epoch)
            }
            other => {
                self.pending = other;
                Expect::Err(Error::RotationNotReady)
            }
        }
    }

    fn cancel_rotation(&mut self) -> Expect<()> {
        match self.pending.take() {
            Some(_) => Expect::Ok(()),
            None => Expect::Err(Error::RotationNotReady),
        }
    }

    fn finalize(&mut self, now: u64) -> Expect<AttestedOutcome> {
        let Some((o, at)) = self.proposal else {
            return Expect::Err(Error::NoProposal);
        };
        if now < at + DISPUTE_WINDOW {
            return Expect::Err(Error::DisputeWindowOpen);
        }
        if !self.quorum(o) {
            return Expect::Err(Error::ThresholdNotReached);
        }
        if self.finalized {
            return Expect::AnyErr;
        }
        self.finalized = true;
        Expect::Ok(o)
    }

    fn cancel_proposal(&mut self, now: u64) -> Expect<()> {
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
        Expect::Ok(())
    }
}

fn check<T: PartialEq + std::fmt::Debug>(what: &str, e: Expect<T>, got: Result<T, Option<Error>>) {
    match (&e, &got) {
        (Expect::Ok(a), Ok(b)) if a == b => {}
        (Expect::Err(a), Err(Some(b))) if a == b => {}
        (Expect::AnyErr, Err(Some(_))) => {}
        _ => panic!("{what}: model {e:?}, contract {got:?}"),
    }
}

fn members_vec(w: &World, idx: &[u8]) -> Vec<Address> {
    let mut v = Vec::new(&w.env);
    for i in idx {
        v.push_back(w.members[*i as usize].clone());
    }
    v
}

fuzz_target!(|data: &[u8]| {
    let mut r = Reader::new(data);
    let (Some(mask), Some(thr), Some(min_e), Some(delta)) = (r.u8(), r.u8(), r.u8(), r.u8())
    else {
        return;
    };
    let members = mask_members(mask);
    let params = CommitteeRefParams {
        min_epoch: (min_e % 3) as u32,
        max_rotation_delta: (delta % 3) as u32,
        dispute_window: DISPUTE_WINDOW,
    };
    let (w, created, spec) = world_with_committee(&members, thr as u32, params);
    // create_committee: same member/threshold rules as propose_rotation.
    let valid = !members.is_empty() && thr != 0 && thr as usize <= members.len();
    let id = match (valid, created) {
        (true, Ok(id)) => id,
        (false, Err(Error::InvalidConfig)) => return,
        (v, c) => panic!("create_committee: model valid={v}, contract {c:?}"),
    };
    assert_eq!(id, spec.committee_id);
    // Registration rejects a committee already below `min_epoch` (epoch 1).
    let reg = outcome_of(w.client().try_register_committee_spec(&w.market_id, &spec));
    if params.min_epoch > 1 {
        assert_eq!(reg, Err(Some(Error::RotationBoundExceeded)), "register bound");
        return;
    }
    assert_eq!(reg, Ok(()), "register_committee_spec");
    w.env.ledger().set_timestamp(CLOSE_TIME);

    let mut m = Model {
        epoch: 1,
        members,
        threshold: thr as u32,
        min_epoch: params.min_epoch,
        max_delta: params.max_rotation_delta,
        pending: None,
        attested: BTreeSet::new(),
        proposal: None,
        cancels: 0,
        finalized: false,
    };

    let count = r.u8().unwrap_or(0) as usize;
    let mut ops = std::vec::Vec::new();
    for _ in 0..count.min(MAX_OPS) {
        let Some(tag) = r.u8() else { break };
        ops.push(match tag % 7 {
            0 => Op::Attest(r.u8().unwrap_or(0), r.u8().unwrap_or(0)),
            1 => Op::ProposeRotation(r.u8().unwrap_or(0), r.u8().unwrap_or(0)),
            2 => Op::ExecuteRotation,
            3 => Op::CancelRotation,
            4 => Op::Advance(r.u16().unwrap_or(0)),
            5 => Op::Finalize,
            _ => Op::CancelProposal,
        });
    }

    let c = w.client();
    for op in ops {
        let now = w.now();
        match op {
            Op::Attest(member, o) => {
                let member = member % POOL as u8;
                let o = outcome(o);
                let who = w.members[member as usize].clone();
                w.auth(&who, "attest", args(&w.env, (w.market_id, who.clone(), o)));
                let e = m.attest(now, member, o);
                check("attest", e, outcome_of(c.try_attest(&w.market_id, &who, &o)));
            }
            Op::ProposeRotation(mask, t) => {
                let list = members_vec(&w, &mask_members(mask));
                w.auth(
                    &w.admin,
                    "propose_rotation",
                    args(&w.env, (id, list.clone(), t as u32)),
                );
                let e = m.propose_rotation(now, mask, t);
                check(
                    "propose_rotation",
                    e,
                    outcome_of(c.try_propose_rotation(&id, &list, &(t as u32))),
                );
            }
            Op::ExecuteRotation => {
                let e = m.execute_rotation(now);
                check("execute_rotation", e, outcome_of(c.try_execute_rotation(&id)));
            }
            Op::CancelRotation => {
                w.auth(&w.admin, "cancel_rotation", args(&w.env, (id,)));
                let e = m.cancel_rotation();
                check("cancel_rotation", e, outcome_of(c.try_cancel_rotation(&id)));
            }
            Op::Advance(secs) => w.advance(secs as u64 * 64),
            Op::Finalize => {
                let e = m.finalize(now);
                check("finalize_signers", e, outcome_of(c.try_finalize_signers(&w.market_id)));
            }
            Op::CancelProposal => {
                let reason = GuardianReason::DisputeUpheld;
                w.auth(
                    &w.admin,
                    "cancel_proposal",
                    args(&w.env, (w.market_id, reason.clone())),
                );
                let e = m.cancel_proposal(now);
                check(
                    "cancel_proposal",
                    e,
                    outcome_of(c.try_cancel_proposal(&w.market_id, &reason)),
                );
            }
        }
        let comm = c.get_committee(&id);
        assert_eq!(comm.epoch, m.epoch, "epoch");
        assert_eq!(comm.threshold, m.threshold, "threshold");
        assert_eq!(comm.members, members_vec(&w, &m.members), "members");
    }
});
