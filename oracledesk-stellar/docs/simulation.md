# Agent-based market simulation

`agents/sim/` is a deterministic, discrete-time simulator for backtesting
agent strategies and measuring systemic effects before anything touches
testnet. It runs our real strategy code (`decideTrade`,
`decideMarketProposal`) against an exact off-chain mirror of market-core and
of the treasury's caps, in a population of other agents, over thousands of
seeded scenarios.

```bash
cd oracledesk-stellar/agents
npm run sim -- --config sim/configs/clones.json --seed 1 --runs 50
# -> sim/results/clones-1.json (config, seed, per-run metrics, aggregates)
#    sim/results/clones-1.summary.md
```

## Fidelity

A simulator that rounds differently from the contract gives confidently
wrong answers, so the engine reimplements no AMM math:

- **Market-core** (`sim/market.ts`, `SimMarketCore`) follows `create_market`,
  `buy`/`sell` (`do_buy`/`do_sell`), `resolve`, `void_market`, `redeem`,
  `claim_pool_remainder`, `claim_lp_fees` and `sweep_fees`. It uses the same
  preconditions, the same check order and the same error names
  (`MarketClosed`, `SlippageExceeded`, `InsufficientShares`,
  `MarketTooLarge`, `NothingToRedeem`, `AlreadyClaimed`, ...), raised as
  `SimContractError(code)`. Every amount comes from `agents/core/fpmm.ts`
  (`seedReserves`, `calcBuy`, `calcSell`, `settleValue`, `mulDivCeil` for
  `split_fee`). The seed's leftover shares are credited to the creator's
  position, as on-chain. Void pays `(yes + no) / 2` floored per holder, and the
  resulting dust is reported, never "fixed". A differential test drives
  random trade sequences through both `SimMarketCore` and raw
  `calcBuy`/`calcSell` and requires identical reserves and share amounts.
- **Treasury** (`sim/treasury.ts`, one `SimTreasury` per deployment) mirrors
  the contract's checks in order:
  1. `check_trade_size`: per-agent and global `max_trade`, then the
     market-core call.
  2. `reserve_capacity`: lifetime per-market `max_market`, then the global
     and per-agent sliding daily windows. Each window is 25 hourly buckets
     advanced by **sim time**, so usage stays counted for a full 24 h and
     clears on the first call after the next hour starts.

  A cap failure reverts the market mutation too, matching Soroban
  atomicity. `agent_sell` is uncapped. Not yet mirrored: the price
  band/slippage-floor/impact checks of `do_agent_buy`, `max_net_exposure`,
  liquidity reserves, and the creation policy beyond `max_seed`. Each of
  these only *adds* reverts, so the cap-binding rates below are lower
  bounds.
- **Not modelled**: pause, market-core's optional breakers (off by default),
  resolver disputes (the resolution is drawn from the outcome process),
  Soroban resource fees (a flat `txCost` per order instead), and
  position/LP transfers.

### Invariants

Every market-core mutation asserts the solvency invariants from
`docs/architecture.md`:

- **Before settlement starts:** `balance == sets_minted + fees_accrued + lp_fees`
  and `reserve_yes + Σ pos.yes == sets_minted` (the same for NO).
- **Once final:** the balance covers every remaining claim at its settlement
  value.

After every step, market-core's token balance must equal the sum of its
markets' balances. At the end of each run, every market must be fully
settled, with `deposited == sold + redeemed + pool claim + LP fees + fees
swept + dust`, and the ledger total must equal the collateral funded. A
violation throws `InvariantError` and aborts the run.

## Method

- **Time.** Discrete steps of `stepSeconds` (600 s in the shipped configs).
  On each step the latent probabilities move. Then every agent observes the
  same pre-step snapshot (open markets, its own balance and positions) and
  submits orders. Mempool watchers act last, seeing the others' orders. The
  orders then execute one by one in the policy order:
  - `shuffle`: a seeded random permutation.
  - `sandwich`: watchers' front legs are placed immediately before their
    victim and back legs immediately after.

  A reverting order is recorded by kind and error, and never crashes the
  run. Markets past `close_time` are resolved or voided and then fully
  settled: every holder redeems, the LP claims the pool, and fees are
  swept.
- **Outcomes** (`sim/outcomes.ts`). Each market has a latent `p_t`:
  - `fixed`: constant.
  - `drift`: logit random walk with step `sigma`.
  - `jump`: occasional logit jumps.

  At close the market is voided with probability `voidRate`, otherwise it
  resolves YES with probability `p_T`. The initial LP prices each market at
  `p_0` plus `lpPriceNoiseBps` of Gaussian noise. That mispricing is the
  edge informed agents compete for.
- **Agents** (`sim/agents/`), all implementing `SimAgent.act(obs, rng)`:

  | agent | behaviour |
  |---|---|
  | `NoiseTrader` | Random buys and sells. Oversized sells revert with `InsufficientShares` rather than being clamped. |
  | `InformedTrader` | Has a private noisy signal of `p_t`. |
  | `Sandwicher` | Front-runs pending buys and dumps right after. |
  | `OracleDeskTrader` | Runs `decideTrade` (or any function of the same shape) through its own treasury, with fixed or edge-proportional sizing and a quote-based `min_shares_out`, or none. |
  | `OracleDeskMaker` | Runs `decideMarketProposal` and seeds markets through its treasury. |

  Clones are `count: k` copies of a trader with separate treasuries and a
  shared `signalGroup`, so they receive identical signals.
- **Determinism** (`sim/rng.ts`). xoshiro128** streams are seeded by
  splitmix64. `fork(label)` derives a stream from `(seed, label)` alone
  (per agent, per market, per signal, per step's ordering), so adding an
  agent never perturbs another stream. `Math.random` is never used, and
  holders are iterated in sorted order. Run `i` of an experiment uses the
  seed `splitmix64(seed + i)`. Every result file records the seed and the
  full config. A test checks that identical inputs give byte-identical JSON.
- **Statistics** (`sim/report.ts`). Amounts are bigint until reporting.
  - **Per run:** PnL per ledger account (final minus funded, after full
    settlement; a treasury-backed agent is judged on its treasury). LP PnL
    is pool remainder + LP fees + seed-share settlement value − seed. Also
    recorded: fees swept, void count/dust/LP PnL, the Brier score of the last
    pre-close price (with the latent `p_T`'s Brier as a benchmark), mean
    |price − p_t|, OracleDesk *overshoot* (`side × (post-trade price − own
    fair value)`; positive means the fill pushed the price past what the
    agent itself believed), cap binding rate (cap reverts / treasury calls)
    and peak daily-cap use.
  - **Across runs:** mean, p5, p95, and a seeded 1,000-resample bootstrap 95%
    CI of the mean.

  One run is never evidence. Read the CIs, and sweep parameters
  (`"sweep": {"param": "k", "values": [...]}` substitutes `"$k"` in the
  config).

## Experiments

All three experiments share one market setup:

- 5 markets seeded at 1,000 USDC each, with a 1% fee and the LP's opening
  price off by N(0, 800 bps).
- 288 ten-minute steps to close, and a drifting latent p (σ = 0.02 per step,
  `p_0 ∈ [0.2, 0.8]`) with a 5% void rate.
- 10 noise traders.
- An OracleDesk trader with a 300 bps-noise signal, a 300 bps minimum edge
  and 50 USDC trades, behind a treasury with caps of 100 USDC per trade,
  500 USDC per market and 2,000 USDC per day.

Seed 1. PnL is in USDC, shown as the mean with a 95% CI. Reproduce any row with
`npm run sim -- --config sim/configs/<name>.json --seed 1 --runs <n>`.

### A. One OracleDesk trader against noise: fixed vs edge-sized trades

`trader-sizing.json`, 100 runs per point.

| sizing | OracleDesk PnL | LP PnL | overshoot rate | mean abs mispricing (bps) | cap binding rate |
|---|---|---|---|---|---|
| fixed 50 USDC | 64.0 ± 71.1 | −66.5 [−144.9, 3.5] | 0.100 | 638 | 0.89 |
| edge-proportional | 77.4 ± 71.1 | −27.1 [−113.3, 46.2] | 0.002 | 545 | 0.79 |

At this sample size, sizing does not significantly change profit: the CIs
overlap almost entirely. It does change *how* the agent trades:

- **Overshoot almost disappears.** With fixed trades, 10% of fills overshoot
  the agent's own fair value. With edge-proportional sizing it is 0.2%,
  because a small edge gets a small trade.
- **Prices end up closer to latent p**, and the caps bind less often.

Both variants hit `max_market` on most markets. 89% of treasury calls revert
on a cap, because the agent keeps re-submitting while its edge persists. For
this edge size, the cap rather than the strategy decides the position.

### B. k competing OracleDesk clones with the same signal

`clones.json`, 50 runs per point. Each clone has its own treasury with the
caps above. The OracleDesk total is the sum over the clones (normal-approx 95%
CI of the per-run sum).

| k | OracleDesk total PnL | per clone | mean abs mispricing (bps) | overshoot rate | `SlippageExceeded` reverts / run | capital at risk (k × max_market × markets) |
|---|---|---|---|---|---|---|
| 1 | 58.2 ± 90.2 | 58.2 | 652 | 0.109 | 62 | 2,500 |
| 2 | 135.5 ± 107.0 | 67.8 | 585 | 0.123 | 203 | 5,000 |
| 3 | −33.1 ± 140.5 | −11.0 | 493 | 0.115 | 413 | 7,500 |
| 4 | −17.9 ± 128.7 | −4.5 | 434 | 0.110 | 717 | 10,000 |
| 5 | 2.6 ± 129.4 | 0.5 | 383 | 0.129 | 1,099 | 12,500 |

This is the systemic effect `docs/STATUS.md` warned about, now quantified:

- **Profit does not scale with k; risk does.** The edge available is the LP's
  mispricing. Identical clones split it, and past k = 2 they compete it away:
  per-clone PnL falls to about zero. Meanwhile each clone's treasury caps
  apply only to itself, so the capital committed to the same markets, and the
  variance of the combined result, grow linearly in k. The CI half-width goes
  from 90 to 129 USDC.
- **The clones collide.** Each one quotes against the same pre-step state, so
  whichever executes second finds the price already moved and reverts on its
  own slippage bound. `SlippageExceeded` reverts grow faster than linearly
  (62 to 1,099 per run). With real fees, every revert also costs XLM.
- **Markets become more accurate.** Mean |price − p| drops from 652 to
  383 bps as more capital corrects the LP's mispricing. Most of that gain goes
  to accuracy, not to the clones.

A per-deployment cap cannot limit any of this. Bounding it needs coordination
across deployments, such as a shared exposure registry or caps on market-core
per market.

### C. A sandwicher against the trader, with and without a slippage bound

`sandwich.json`, 100 runs per point, ordering policy `sandwich`. The
sandwicher front-runs every buy of at least 30 USDC with 200 USDC and dumps
right after. Only the OracleDesk trader's orders are that large.

| `min_shares_out` | OracleDesk PnL | sandwicher PnL | OracleDesk overshoot rate | OracleDesk fills |
|---|---|---|---|---|
| `0` (no protection) | −414.8 ± 65.4 | −3,459.6 [−3,533.2, −3,384.0] | 0.914 | every attempt the caps allow |
| quote − 50 bps | 0.0 ± 0.0 | −4,594.5 [−4,674.3, −4,517.3] | – | none (all `SlippageExceeded`) |

- **Without a bound, the trader is badly hurt.** It goes from about +64 USDC
  (experiment A) to −415 USDC. 91% of its fills land above its own fair value,
  because each one executes after the front-run.
- **The attacker loses too.** With a 1% fee on both legs against
  1,000 USDC pools, this sandwich size is unprofitable, so it is a griefing
  attack rather than an extraction.
- **A real slippage bound stops the loss but not the attack.** Every
  front-run trade now reverts, so the trader never trades at all, a complete
  denial of service, while the attacker pays roughly 4.6k USDC per run in
  fees and impact.

The quote-based `min_shares_out` that `bin/trader.ts` already uses is
necessary but not sufficient. Use a private submission path, or bounds
derived from an independent price, before trading against adversarial flow.

## Extending

- **New agent:** implement `SimAgent` in `sim/agents/`, add a config variant in
  `sim/engine.ts`'s `AgentConfig` and `buildAgents`, and draw randomness only
  from the `rng` passed to `act`.
- **New strategy:** pass a `strategy` function with `decideTrade`'s signature
  to `OracleDeskTrader`.
- **Treasury checks:** when the shared treasury risk mirror lands, replace
  `sim/treasury.ts`'s cap code with it (see the TODO there). The price-band,
  impact and net-exposure checks then come for free.
