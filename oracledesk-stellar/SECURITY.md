# Security Policy

## Status: testnet-only, unaudited

Everything in this repository is deployed to Stellar **testnet only**. The
contracts have **not** been professionally audited. Do not deploy them to
mainnet, and do not send anything of real value to any address or contract
in this repo. See `docs/STATUS.md` for the current list of what has and has
not been verified.

## Reporting a vulnerability

Please report security issues privately, using
[GitHub Security Advisories](../../security/advisories/new) for this
repository, rather than opening a public issue. This applies to:

- A way to drain, lock, or misdirect funds held by any of the four
  contracts (`market-core`, `resolver`, `treasury`, `reasoning-registry`).
- An authorization bypass (a privileged function callable by the wrong
  party — see `contracts/*/src/lib.rs`'s wrong-caller tests for what's
  already covered).
- A way to make the resolution-commitment scheme (ADR 0001) or the treasury
  cross-contract auth flow (ADR 0002) behave differently from documented.
- A way to break the market-core complete-set invariants: `split` / `merge`
  (added in this revision) must never change `reserve_yes`, `reserve_no` or `fees_accrued`, must preserve
  `reserve_yes + Σpos.yes` == `sets_minted` (and the NO analogue), and must not let
  total `settle_value` payouts exceed `sets_minted`.
- A vulnerability in the x402 payment/verification flow that would let a
  trace be served without payment, or without its hash matching the
  on-chain record.

<!-- TODO(maintainer): confirm an expected response/triage timeline before
publishing this repo — do not commit to one without checking. -->

## Scope

In scope: `contracts/`, `x402/`, `agents/`, `packages/bindings/` (the
generation script and its templates, not third-party generated code
itself), and the deployment scripts in `scripts/`.

Out of scope: the separate frontend repository, and any third-party
dependency's own vulnerabilities (report those upstream — `npm audit` /
`cargo audit` findings in a dependency are not this repo's issues unless
this repo's usage of them is what's exploitable).

## Treasury admin and the vault

The treasury is a share vault (`docs/adr/0005-treasury-vault.md`): deposits
mint shares and only a share's owner can burn it. There is no admin
`withdraw`. Configuration that would let the *agents* spend more (raised
caps, new or widened agents, a looser price policy, a market-core or
collateral switch) waits `config_delay` (at least one day) after a public
`*Proposed` event, while tightening applies at once. What this does **not**
protect against: the admin can still pause the treasury instantly, and can
`set_successor` + `migrate_market` to move positions to another address, so
a compromised admin key remains a custody risk for open positions. A
governance timelock over all admin roles is separate work.

In scope for reports: anything that lets a depositor withdraw more than
their pro-rata share of NAV (share inflation, rounding, NAV manipulation
through trades against a pool), lets an agent spend capital reserved for
queued withdrawals, or bypasses the role checks, sub-budgets, price limits
or timelock.

## Guardian trust model

The resolver contract defines guardian powers as emergency interventions rather
than day-to-day administrative authority. To avoid single-party rug pulls or
arbitrary cancellations:

- **Time-restricted actions**: `cancel_proposal` is restricted to active dispute
  windows only. `guardian_void_market` enforces strict grace periods after
  `close_time` (`REVEAL_GRACE_SECS` = 3 days, `ORACLE_GRACE_SECS` = 1 day,
  `SIGNER_GRACE_SECS` = 7 days) before a guardian void can be executed.
- **Cancellation limits**: A market allows a maximum of 2 guardian cancellations
  (`MAX_CANCELS_PER_MARKET`) to prevent indefinite griefing.
- **Mandatory reason codes and public audit trail**: Every guardian action emits
  a `GuardianAction` event recording a typed `GuardianReason` and timestamp.

## Complete-set split / merge (market-core)

`split` and `merge` are fee-free complete-set primitives that never touch the
FPMM pool. The following security decisions are recorded here and in
`docs/architecture.md`:

- `split` requires an `Open` market and `now < close_time` (reuses
  `assert_tradable`) and is gated by `assert_not_paused`. After close there is no
  purpose to split, and allowing it would open timing games against the
  resolution process.
- `merge` requires an `Open` market but is **allowed after `close_time` and
  while paused**. Merging is a pure exit: it burns one YES and one NO and
  returns one unit of collateral at par. It cannot harm the pool, change
  `reserve_yes` / `reserve_no` / `fees_accrued`, or move a price, so letting
  users de-risk while the resolver is slow or the contract is paused is
  desirable. The asymmetry with `split` is intentional.
- Neither entrypoint changes `reserve_yes`, `reserve_no` or `fees_accrued`. They
  preserve `sets_minted == reserve_yes + Σpos.yes` (and the NO analogue)
  and `token.balance == sets_minted + fees_accrued`, and the total of
  `settle_value` payouts across all holders plus the pool never exceeds
  `sets_minted`. Tests in `contracts/market-core/src/lib.rs` assert this
  across mixed split/buy/sell/merge sequences and under Void.
- **MAX_SETS griefing.** `split` is bounded by the same `sets_minted` cap as
  `buy`, so an attacker can split up to `MAX_SETS` and block further `buy`
  calls (`ErrorMarketTooLarge`) at the cost of locking collateral, then
  `merge` out at par risk-free. This is a deliberate trade-off: the capital
  locked is the attacker's own, the attack is visible on-chain, and a
  per-market split cap or excluding split sets from the buy limit would add
  complexity that is not justified for a testnet-only, unaudited deployment.
  The decision is documented in `docs/architecture.md`.
- **Void dust.** Split increases the number of holders that can each lose up to
  0.5 unit to flooring under Void. This is bounded by the number of holders
  and the collateral locked by those holders, and is not a drain vector.
- `sell` uses `sets_minted.checked_sub` for the same reason `split` uses
  `checked_add`: the invariant must never underflow.