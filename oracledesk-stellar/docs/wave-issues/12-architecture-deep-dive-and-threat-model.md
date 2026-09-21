# Docs: architecture deep-dive and threat model

## Context

`docs/architecture.md` covers each contract's responsibilities and the
system's known limitations, and the two ADRs cover two specific design
decisions in depth. There is no dedicated threat model: an explicit
enumeration of trust assumptions (who can call what, what a compromised
agent key can and can't do, what a malicious market creator can and can't
do) and the mitigations already in place vs. still needed.

## What to change

Write `docs/threat-model.md` covering, at minimum:

- What a compromised **agent** key can do (bounded by treasury's caps —
  quantify the actual worst case: `max_trade`, `max_market`, `max_daily`)
  vs. what it can't (it can't move funds anywhere but through
  `agent_create_market`/`agent_buy`/`agent_sell`, and can't exceed the
  configured caps — cite the relevant tests in
  `contracts/treasury/src/lib.rs`).
- What a compromised **admin** key can do on each contract (this is a much
  larger blast radius — pausing, changing fee config, withdrawing treasury
  funds, voiding markets — enumerate per contract).
- What a malicious **market creator** can and can't do given the
  resolution-commitment scheme (ADR 0001) — can they still grief in some
  way the commitment doesn't prevent (e.g. an intentionally ambiguous
  question text, since only the *resolution rule* is committed, not the
  question's clarity)?
- What a malicious **resolver guardian** can do (`cancel_proposal`,
  `guardian_void_market`) and what recourse exists if they abuse it (today:
  none beyond redeploying with a different admin — worth stating plainly).
- x402's trust assumptions: what happens if the facilitator is malicious or
  down (can a payer get charged without receiving a valid trace? can a
  trace be served without payment?).

Expand `docs/architecture.md` with a deeper walkthrough of the
resolve-through-treasury call graph if it isn't already clear from ADR 0002
plus the existing doc.

## Files to touch

- `docs/threat-model.md` (new)
- `docs/architecture.md` (expand as needed)

## Acceptance criteria

- Every privileged role (admin on each of the 4 contracts, agent, guardian,
  facilitator) has an explicit "what they can do" / "what stops them from
  doing more" pair.
- Cites specific tests or code as evidence for each mitigation claimed,
  not just assertions.

## How to test

Documentation only — review for completeness and accuracy against the
actual current code (contracts change; keep this in sync).

## Complexity

`complexity/small`
