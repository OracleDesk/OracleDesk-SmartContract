# ADR 0005: Share-based treasury vault with a conservative NAV

## Status

Accepted.

## Context

`Treasury::deposit(from, amount)` used to accept collateral from anyone and
record nothing: no shares, no receipt, no way back out. Only the admin could
move funds out, through `withdraw(to, amount)`. A deposit from anyone other
than the operator was a donation to the admin key, so outside funders could
not back an agent and share in its results.

Turning the treasury into a vault needs a net asset value (NAV) to price
shares. The treasury holds positions across many markets, and the obvious
valuation, the FPMM spot price, can be moved by anyone who trades. If NAV
followed spot, a depositor could push prices up, withdraw at the inflated
NAV, and leave the loss with everyone else. Vaults also have a well-known
first-depositor attack: deposit 1 unit, donate a large amount straight to the
contract, and round the next depositor's shares down to almost nothing.

## Decision

### Valuation: settled-plus-floor

```
nav = idle
    + Σ over the open-market index of
        open market:  min(pos.yes, pos.no)                      complete sets
                    + min(reserve_yes, reserve_no) if LP role    unclaimed LP
        final market: settle_value(position) + settle_value(LP reserves)
    - queue_reserved
```

- `idle` is the treasury's collateral balance.
- Complete sets redeem 1:1 whatever the outcome, so `min(yes, no)` is value
  the treasury gets back for certain.
- For an LP role that has not been claimed, `min(reserve_yes, reserve_no)` is
  the least the pool remainder can pay out.
- A final market counts exactly what market-core's `settle_value` pays
  (`Yes → yes`, `No → no`, `Void → (yes + no) / 2`).
- `queue_reserved` is collateral already owed to burned shares (see
  "Withdrawals"). Subtracting it stops that collateral being counted twice.

The directional part of a position (`|yes - no|`) is valued at **zero**. Spot
and TWAP valuations were rejected: spot can be manipulated within a single
transaction, and no TWAP exists yet.

**Trade-off, worked example.** The treasury holds 1,000 USDC idle and 150 YES
/ 40 NO shares in an open market where YES trades at 70%. Mark-to-market
would value the position at about 150 × 0.7 + 40 × 0.3 = 117. The floor is
`min(150, 40) = 40`, so NAV is 1,040, not 1,117. While the position is open,
a new depositor's shares are slightly cheap and a withdrawing shareholder's
are slightly expensive. Once the market resolves YES, the position is worth
exactly 150, NAV rises to 1,150, and every shareholder gains pro rata. The
bias always favours the shareholders who stay in the vault over those
entering or leaving. Under-valuation is the price of a NAV that third-party
trades cannot push up.

### Open-market index

NAV needs the list of markets where the treasury holds capital, and nothing
on-chain gave that list. The treasury keeps an index:
`OpenMarketAt(0..count) -> { core, market_id }` plus a reverse
`OpenMarketSlot(core, id)` for swap-and-pop removal.

- A market joins the index on its first buy or creation.
- It leaves once the treasury holds nothing in it: no shares and no unclaimed
  LP role. This is checked after `redeem`, `claim_pool_remainder` and their
  `legacy_*` variants. `migrate_markets` also removes it.
- Each entry records its market-core, so positions left in a market-core the
  treasury has since switched away from (see "Timelocked configuration" in
  `docs/architecture.md`) keep counting.

Once marks are migrated, `compute_nav` reads only `idle`, `NavHoldings` and
`QueueReserved`: no per-market cross-contract calls. Each indexed market keeps a
`MarkRecord` whose `contribution` is the same floor the legacy walk computed.
Treasury-originated position changes update that record in `save_net`; LP floors
change with other users' trades, so `refresh_mark` recomputes them in bounded
batches. `deposit` and `request_withdraw` refuse LP marks older than
`max_mark_age_ledgers`. Batch settlement paths (`redeem_many` and
`claim_pool_remainders`) now refresh marks and update net accounting for every
reported item, so they cannot silently drift NAV.

Resolution can only raise the true floor above the stored open-market value
(`settle_value(y, n) >= min(y, n)`, including void), so an unrefreshed
contribution remains conservative. A fully finalized market whose balance has
been swept must be detected with market-core's `settle_state(id).closed`, which
sets the contribution to zero; that detection lands with the refreshed
market-core wasm and bindings.

The index is capped at `MAX_OPEN_MARKETS = 128`. Position-only markets have no
read cost in NAV once migrated; LP marks are bounded separately by what one
`refresh_mark` batch can read inside the staleness window.

| Open markets | Call | Old walk | Incremental path |
| ---: | --- | ---: | --- |
| 32 | `nav()` alone | ~81 MB | O(1) storage reads |
| 16 | `deposit` | ~40.4 MB | O(1) storage reads |
| 128 | `deposit` / `request_withdraw` | over the 40 MiB limit | budget scenario to be regenerated with fresh bindings |

### Shares

Shares are internal balances (`Shares(owner)`, `TotalShares`), not a SEP-41
token. A transferable share token can wrap them later. Keeping them internal
avoids a second contract, a cross-contract call per transfer, and the
question of what a share transfer means for the withdrawal queue while the
economics are still settling.

```
shares_for_deposit(amount) = amount × (supply + 1_000) / (nav + 1)     floor
assets_for_shares(shares)  = shares × (nav + 1) / (supply + 1_000)     floor
```

Both directions round down, in favour of the vault. A deposit followed
immediately by a withdrawal never returns more than was put in. This is
checked by a randomized property test (1,000 cases) and end to end.

**Inflation protection.** The virtual offset (1,000 virtual shares, 1
virtual stroop; the ERC-4626 mitigation) is what defeats the donation
attack. The attacker's donation is shared with the virtual shares, so
inflating the price enough to round a victim's deposit to zero costs the
attacker about 1,000 times what it takes from the victim. Two further
measures support it:

- The first mint withholds 1,000 dead shares that no one owns.
- Deposits must be at least `MIN_DEPOSIT = 10 USDC`.

`donation_attack_does_not_steal_from_second_depositor` shows a victim losing
at most rounding dust after a 1,000 USDC donation.

NAV is computed before the deposit's own transfer, so a deposit never prices
itself.

### Withdrawals

`request_withdraw(owner, shares)`:

1. Computes `assets` at the current NAV and burns the shares immediately,
   which locks in the price.
2. Pays `min(assets, idle - queue_reserved)` now.
3. Records any remainder as a FIFO `WithdrawTicket { owner, remaining,
   created_at }` and adds it to `queue_reserved`.

Agents can never spend reserved collateral. `agent_buy` and
`agent_create_market` fail with `CapitalReserved` unless
`idle - amount >= queue_reserved`.

`claim_withdraw(ticket_id)` pays the head ticket as far as idle collateral
allows. Anyone can call it, but the money always goes to the ticket's owner.
Tickets wait while capital stays deployed, which is bounded by the close
times of the open markets. UIs can read `queue_reserved()`,
`queue_bounds()` and `withdraw_ticket(id)`.

### Operating modes and the gate table (#272)

Before #272 the treasury tracked four booleans (`Paused`, `AdminPaused`,
`DrawdownTripped`, `DrawdownAcknowledged`) and each entrypoint read a different
combination of them. The most serious result: a drawdown trip (the agents lost
money) set `Paused`, and `emergency_withdraw` checked only `Paused`, so an
ordinary risk event opened the exit meant for "market-core is broken". Whoever
left first took their share of idle collateral and forfeited their share of open
positions to the stayers, so a trip started a run.

The treasury now stores each *reason* it is not running normally on its own
(`ModeState`), and derives one effective `Mode` with the priority
`Emergency > Paused > AgentsHalted > Unwinding > Normal` (`Unwinding`, from
#150, is the admin's orderly wind-down: `set_mode(Unwinding)`; it is a reason like
the others, cleared by `set_mode(Normal)`):

| Reason | Set by | Cleared by | Auth |
|---|---|---|---|
| unwinding | `set_mode(Unwinding)` | `set_mode(Normal)` | admin |
| drawdown halt | `check_drawdown` (internal, on realized loss) | `resume_agents()` | admin, and only once the window PnL is back above `-max_drawdown` (or after `reset_pnl_window`) |
| admin pause | `set_paused(true)` / `pause(reason)` | `set_paused(false)` / `unpause()` | admin (the timelock's emergency path calls `set_paused(true)`, ADR 0008) |
| emergency | `declare_emergency(reason)`, only from `Paused` | `end_emergency()` | admin (production: route through `timelock.schedule`) |

Because the reasons are independent, clearing one never clears another:
unpausing during a drawdown leaves the agents halted, and resuming the agents
leaves an admin pause standing. `unpause` is refused while an emergency is
declared. Every change emits `ModeChanged { from, to, reason, at }`, so off-chain
monitors can tell *why* the treasury stopped. `acknowledge_drawdown` is a
deprecated no-op (the error code `NotAcknowledged` stays allocated).

Every state-changing entrypoint asks one function, `gate(Op)`, which is the
exhaustive `mode::allowed(mode, op)` below (a new `Op` does not compile until it
has a cell for every mode). A denied call returns `DrawdownTripped` (agents
halted), `Paused` (admin pause) or `EmergencyMode`; `emergency_withdraw` outside
an emergency returns `NotPaused` when running normally.

| Op (entrypoints) | Normal | AgentsHalted | Paused | Emergency | Unwinding |
|---|---|---|---|---|---|
| `Deposit` (`deposit`, `deposit_token`) | yes | no | no | no | yes |
| `RequestWithdraw` (`request_withdraw`) | yes | yes | yes | no | yes |
| `ClaimWithdraw` (`claim_withdraw`) | yes | yes | yes | yes | yes |
| `EmergencyWithdraw` (`emergency_withdraw`) | no | no | no | yes | no |
| `AgentOpen` (`agent_create_market`, `agent_create_market_and_reveal`, `agent_create_market_reveal_v2`, `agent_buy`, `agent_buy_v2`, ...) | yes | no | no | no | no |
| `AgentReduce` (`agent_sell`, `agent_sell_v2`, `close_trade`) | yes | yes | no | no | yes |
| `AgentSettle` (`redeem`, `claim_pool_remainder`, `legacy_*`, `redeem_many`, `claim_pool_remainders`, `agent_claim_lp_fees`) | yes | yes | yes | yes | yes |
| `PermissionlessSettle` (`settle_market`, `realize`, `collect_market_fees`) | yes | yes | yes | yes | yes |
| `YieldAllocate` (`allocate_to_yield`, at queueing and at execution) | yes | no | no | no | yes |
| `YieldRecall` (`recall_from_yield`) | yes | yes | yes | yes | yes |
| `Migrate` (`migrate_markets`, at queueing and at execution) | yes | no | no | yes | yes |

Depositor exit rights, mode by mode:

- **Normal.** Everything runs. A depositor exits through `request_withdraw` (paid
  at NAV, the remainder queued FIFO) and `claim_withdraw`.
- **AgentsHalted** (drawdown). Only *openings* stop: agents cannot create markets
  or buy, and the yield venue takes no new allocation, because a halt means the
  agents lost money and NAV is in doubt. Reductions (`agent_sell`, `close_trade`)
  and every settlement stay open, so positions can be unwound. Deposits close
  (a new depositor would buy in at a NAV nobody trusts yet). The depositor's
  exit is unchanged, and `emergency_withdraw` stays closed: opening the forfeiting
  exit on a risk event is the bug this section fixes, and it would hand the first
  leavers a larger share at the stayers' expense.
- **Paused.** Deposits and all agent trading close (including reductions:
  an admin pause is a "stop touching things" lever). Settlement, recalls from the
  yield venue and queued withdrawals (`request_withdraw`, `claim_withdraw`) stay
  open, because they only bring collateral home or honour what was already
  priced. `emergency_withdraw` is still closed.
- **Emergency.** Entered only from `Paused`, so one admin call cannot flip
  straight into the forfeiting exit (with the timelock as admin the extra step is
  delayed too). `emergency_withdraw` opens: the owner is paid their share of free
  idle collateral (`idle - queue_reserved`, as before, so tickets that already
  exist stay covered) and forfeits their share of open positions. New
  `request_withdraw` closes, because a new request is priced at a NAV that
  `emergency_withdraw` makes meaningless; tickets that already exist stay
  claimable. `migrate_markets` is open so positions can be moved to a successor.
- **Unwinding.** The admin's orderly wind-down (#150): openings close like
  `AgentsHalted`, but deposits, queued withdrawals, reductions, yield and
  migration keep running, and `unwind_sell` (agent or the designated unwinder,
  subject to per-market exit floors) is available. It is the lowest-priority
  reason, so a drawdown halt or an admin pause outranks it.
- **Settlement is open in every mode.** `settle_market`, `realize`, `redeem`,
  `claim_pool_remainder` and `collect_market_fees` only bring collateral home. In
  particular a drawdown can trip *inside* `settle_market`/`realize`; the halt is
  recorded and the call that tripped it still succeeds.

`mode()`, `mode_state()` and `allowed(op)` are views for agents and frontends to
pre-check (the agent runtime reads `mode()` once per tick and skips open-position
tasks unless it is `Normal`). The pre-#272 flags are read as a fallback when
`ModeState` is absent (`DrawdownTripped` becomes a halt; `Paused`, or a bare
`Paused` from a pre-#46 deployment, becomes an admin pause with reason `legacy`)
and are deleted on the first write; the treasury has no upgrade entrypoint, so
existing deployments move by redeploying.

### Resolvability policy (#273)

The caps bound how much the agents can spend; nothing used to bound *where*.
Two holes: `agent_create_market_and_reveal` took the resolver from the caller, so
a compromised or buggy agent key could name a contract that accepts
`register_spec_v2` and does nothing, leaving a seeded market whose real resolver
never heard of its spec (it could then only end by expiry voiding, 30 days after
close); and `agent_buy` never asked whether a market could be resolved at all
(spec never revealed, `Disputed`, minutes from `close_time`).

- **The reveal is bound to market-core's resolver.** The treasury reads
  `market_core.get_config().resolver` and reveals there. The new
  `agent_create_market_reveal_v2` has no resolver argument; the older
  `agent_create_market_and_reveal` is kept but fails with `InvalidResolution` if
  given any other. After the reveal the rule kind is read back from the resolver
  (`rule_kind`) and compared with the spec, so a resolver that silently no-ops
  reverts the whole creation. (This part of #273 landed with the #150/#250 work;
  the resolvability policy below is what #273 adds on top.)
- **`resolver.spec_kind` / `trade_status`.** `state()` cannot tell "revealed" from
  "not revealed" (a revealed price or signer market still reads `Unconfigured`),
  so the resolver now reports which spec entry exists, and `trade_status` returns
  kind, state, `close_time`, deadline (`close_time + 30 days`) and whether a
  proposal is pending in one call.
- **`ResolvabilityPolicy`**, checked in `agent_buy`/`agent_buy_v2` after the cheap
  local checks and before any other market-core call: `require_revealed`,
  `block_when_disputed`, `block_with_open_proposal` (off by default: opening a
  proposal needs a signer), `min_secs_to_close` (buys only, so seed-and-reveal
  creation far from close is unaffected) and `allowed_specs` (a bitmask over
  `SpecKind`). The deadline is always enforced. The default is fully permissive and
  makes no cross-contract call at all, so an upgraded deployment behaves as before
  until the admin tightens it. Tightening is immediate; loosening any knob waits
  `config_delay` (`set/execute/cancel_resolvability_policy`, with events).
- **Sells, redemptions and settlement are never gated** by it: the treasury must
  always be able to exit or settle.
- **The resolver is read on every buy, not cached.** An admin resolver swap in
  market-core changes it for all markets; a cached address would consult the old
  resolver's view.
- **Griefing.** `block_when_disputed` freezes new buys in one market only, never
  exits. A dispute needs an open proposal and a bond (`dispute`, then
  `claim_dispute_bond`), forfeited if wrong, so freezing buys is not free.
- **Legacy cores** are not consulted: positions in a `LegacyCore` are only
  redeemable and no buy path reaches them; the check uses `global.market_core`.
- **Archived entries.** `trade_status` never panics on a missing entry (an
  archived `State` reads as the default), but a transaction whose footprint needs
  an archived entry fails; agents must restore before trading.

### Custody migration

- The constructor mints any balance the treasury already holds to `admin` as
  shares.
- A stored pre-vault config is migrated lazily and does the same with the
  balance it finds.
- Admin `withdraw` is removed. The admin is an ordinary shareholder.
- `emergency_withdraw(owner, shares)` works only in `Mode::Emergency` (above).
  It pays the owner their pro-rata part of free idle collateral without reading
  market-core, for the case where market-core is what broke. The owner forfeits
  their part of open positions, which stays with the remaining shareholders.

The treasury has no upgrade path, so existing deployments move by
redeploying:

1. Deploy the new treasury.
2. On the old treasury, `set_successor(new)`, then queue and execute
   `migrate_markets` after `config_delay`.
3. Call `market_core.propose_treasury`, then the new treasury's
   `accept_market_core_role` (the `set_treasury` API this ADR predates was
   replaced by the authenticated handshake in ADR 0006).

Positions moved with `migrate_markets` are not in the successor's index and
count as zero in its NAV until they are redeemed. The old pre-vault flow's
admin `withdraw` no longer exists.

## Epoch-priced entry and exit

Deposits and withdrawal requests are queued for the first epoch boundary at least one full epoch after submission. The boundary snapshots NAV once and applies it to the entire batch. Shares minted in an epoch cannot be requested for withdrawal during the same epoch or the immediately following epoch, preventing same-ledger and same-epoch round trips.

Bounded entry and exit fees (maximum 100 bps) reduce residual intra-epoch drift; fees remain in the vault and accrue to remaining holders. Pending deposits are excluded from NAV and refundable while paused. Pending redeems are released back to the owner for emergency handling. The FIFO ticket queue, virtual-share inflation guard, and queue reservation remain unchanged.

## Consequences

- Outside funders can back an agent. Their claim is enforced on-chain, and
  no trade against a pool can raise the price of their exit.
- Remaining risks, documented rather than solved:
  - **LP floor moved by rebalancing.** `min(reserve_yes, reserve_no)` rises
    when a trade pushes a skewed pool back toward 50/50. An attacker could
    rebalance, withdraw, then trade back. The gain is bounded by the LP
    floor's movement times the attacker's share of the vault, and it costs
    two trading fees plus slippage. It is not free, but it is not zero.
  - **Fee sweeps.** `collect_market_fees` (admin) raises NAV for every
    shareholder at the moment fees arrive. A depositor who knows a sweep is
    imminent gets a slightly better entry. Sweep often.
  - **Admin custody.** `set_successor` + `migrate_markets` can move positions
    out of the vault without compensation (SECURITY.md).
  - **Unindexed positions** (pre-migration, or received from a predecessor)
    are valued at zero until redeemed.
- Agent activity is capped at 12 markets with open capital at once.
