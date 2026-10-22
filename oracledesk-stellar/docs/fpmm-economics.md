# FPMM economics: LP worst case and no-arbitrage

This document derives, for the **exact integer arithmetic** in
`contracts/market-core/src/math.rs`, (1) how much the single LP (the market
creator, usually the treasury) can lose, and (2) that no sequence of buys and
sells earns a risk-free profit. Every claim is checked by
[`model/fpmm_bounds.py`](../model/fpmm_bounds.py) (standard library only,
exact integers, importing the `fpmm_model.py` mirror of `math.rs`):

```bash
python3 model/fpmm_bounds.py --quick       # CI, ~10 s
python3 model/fpmm_bounds.py --full        # local, deeper
python3 model/fpmm_bounds.py --self-test   # shows the search has teeth
python3 model/fpmm_bounds.py --table       # regenerates the tables below
```

Nothing here changes contract math or parameters; the recommendations in the
last section are proposals for separate PRs.

## 1. Setup

| Symbol | Meaning |
|---|---|
| `(y, n)` | pool reserves of YES / NO shares; `k = y·n` |
| `M` | complete sets minted; starts at the seed `S` |
| `(y0, n0)` | reserves right after `create_market` (`seed_reserves(S, p0)`) |
| `(cy, cn)` | creator's seed shares, `cy = S − y0`, `cn = S − n0`; at most one is non-zero |
| `f` | trading fee in bps (`0 ≤ f ≤ 1000`) |
| `(hy, hn)` | shares held by traders |

Share conservation holds after every operation: `y + hy + cy = M` and
`n + hn + cn = M`. The solvency invariant in
[architecture.md](architecture.md) is the collateral side of the same fact.

Fees never enter the reserves; they accrue separately
(`Market.fees_accrued` for the protocol, `LpFees` for the creator, split by
`split_fee`). The **default `protocol_share_bps` is 10 000, so by default the
LP earns no fees**. The LP only earns fees if the market's snapshotted
`FeeTerms.protocol_share_bps < 10 000`. Both cases are shown below.

The LP's final position is the pool (claimed via `claim_pool_remainder`) plus
its seed shares (claimed via `redeem`):

| Outcome | LP payout |
|---|---|
| YES | `cy + y` |
| NO | `cn + n` |
| Void | `⌊(y+n)/2⌋ + ⌊(cy+cn)/2⌋` (two separate floors) |

A single trader is modelled throughout. Several traders are equivalent to one
who holds all their shares (a sell is only constrained by the shares held), so
the reachable pool states are the same.

## 2. Lemmas

**L1 (k never falls).** After any `calc_buy` or `calc_sell`, `y'·n' ≥ y·n`.

*Proof.* Buy: `r_other' = r_other + net` and
`r_bought' = ⌈r_bought·r_other / r_other'⌉ ≥ r_bought·r_other / r_other'`,
so `r_bought'·r_other' ≥ r_bought·r_other`. Sell: `r_other' = r_other − gross`
and `r_sold' = ⌈r_sold·r_other / r_other'⌉`, same inequality. ∎

By induction, every reachable state has **`y·n ≥ k0 = y0·n0`**, and `y, n ≥ 1`
(a buy keeps `r_bought' ≥ 1` because the ceiling of a positive number is at
least 1; a sell requires `gross < r_other`). So all bounds below are *infima*:
a reserve approaches but never reaches 0.

**L2 (integer rounding is conservative).** For the same pool and the same
integer input, the pool never ends with less, and the trader never gets more,
than the exact-real constant-product model would give.

*Proof by induction on the operation count.* Let `P(t)`: "after `t`
operations `y·n ≥ k0` and every operation so far was no better for the trader
than its real-valued counterpart". `P(0)` is equality. For the step:

- *Buy.* The fee is `⌈in·f/10⁴⌉` so `net ≤ in·(1−f/10⁴)` (the trader never
  gets more minted sets than the real model). With `net` fixed,
  `r_bought'` is a ceiling of the real value `r_bought·r_other/(r_other+net)`,
  hence `r_bought' ≥` real, hence `shares_out = r_bought + net − r_bought' ≤`
  real shares out.
- *Sell.* `gross = ⌈out·10⁴/(10⁴−f)⌉ ≥` the real gross. The real shares-in
  as a function of `g`, `g(ys, yo) = ys·yo/(yo − g) + g − ys`, is strictly
  increasing in `g`, and the integer `shares_in` ceilings the first term, so
  `shares_in ≥ g(gross) ≥ g(real gross)`.
- `y·n ≥ k0` is preserved by L1.

The reserve of the bought/sold outcome in the integer model therefore
dominates the real one; the other reserve changes by the same `net` (buy) or by
`gross ≥` real gross (sell), always in the direction that costs the trader. ∎

The check is `check_one_step_dominance*` in the script, using `Fraction` as
the real-valued reference, over exhaustive small cases and random cases up to
`MAX_SETS`.

## 3. LP worst-case loss

Define the LP's loss as `S − payout` (excluding fee income, added in §3.4).

### 3.1 Exact identities

Because the creator's seed shares are part of its position, `payout_YES =
cy + y = (S − y0) + y`, so

```
loss_YES = y0 − y          loss_NO = n0 − n
```

**The LP's loss under an outcome is exactly the fall of that outcome's pool
reserve.** (Forgetting `cy`/`cn` overstates the loss by up to `S`.) If traders
net-sell the winning outcome the reserve rises and the LP gains. The script
asserts both identities on every reachable state.

### 3.2 Bound (a): strictly less than the seed

From L1 and `y, n ≥ 1`:

```
loss_YES = y0 − y ≤ y0 − max(1, ⌈k0 / n⌉)  <  y0
loss_NO  = n0 − n ≤ n0 − max(1, ⌈k0 / y⌉)  <  n0
```

With `M ≤ MAX_SETS` we also have `y ≤ MAX_SETS`, so a tighter, parameter-only
bound is `loss_NO ≤ n0 − max(1, ⌈k0 / MAX_SETS⌉)`. Since `max(y0, n0) = S` (the
likelier outcome's reserve equals the seed), the **worst case over outcomes is
`S − 1` stroops (infimum)**: the LP can lose essentially its entire seed if
the *unlikely* outcome (at seeding) wins after enough one-sided buying. The
likelier outcome's reserve `y0` (for `p0 ≥ 50 %`) is small, so that side's loss
is correspondingly small.

### 3.3 Bound (b): Void

`⌊x/2⌋ ≥ (x−1)/2`, so two floors cost at most 1 unit. By AM–GM and L1,
`y + n ≥ 2√k0`. Hence

```
payout_Void ≥ √(y0·n0) + (cy+cn)/2 − 1.
```

Write `t = y0/n0 ≤ 1` (for `p0 ≥ 50 %`; symmetric otherwise). Then
`√(y0 n0) + (S − y0)/2 = S·(√t + (1−t)/2)` and `√t ≥ t` on `[0,1]` gives
`≥ S·(1+t)/2 ≥ S/2`. So

```
payout_Void ≥ S/2 − 1,   i.e. LP Void loss ≤ S/2 + 1.
```

It is much better at moderate `p0`: at 50 % the Void loss is at most 1 unit, at
99 % at most `0.4045·S`. The script checks the integer form
`payout_Void ≥ ⌊⌈2√k0⌉/2⌋ + ⌊(cy+cn)/2⌋` and `2·(payout+1) ≥ S` on every
state.

### 3.4 Bound (c): loss versus price move

Let `ρ = n/y` be the YES odds (`P_yes = n/(y+n) = ρ/(1+ρ)`), `ρ0 = n0/y0`.
`k = y²ρ`, and L1 gives `k ≥ k0`, so `y ≥ y0·√(ρ0/ρ)` and `n ≥ n0·√(ρ/ρ0)`:

```
loss_YES ≤ y0 · (1 − √(ρ0/ρ_final))
loss_NO  ≤ n0 · (1 − √(ρ_final/ρ0))
```

This is the classical impermanent-loss curve for a constant-product pool,
and the integer model satisfies it exactly (it is `y·n ≥ k0` rewritten; no
slack for rounding). Moving the price all the way to the edge of the allowed
range costs the LP almost everything:

| `p0` (YES) | trader volume to push the unlikely side to 99 % (×S) | LP loss if it wins (×S) |
|---|---|---|
| 1 % / 99 % | 1.00 | 0.990 |
| 5 % / 95 % | 2.25 | 0.977 |
| 10 % / 90 % | 3.24 | 0.966 |
| 25 % / 75 % | 5.47 | 0.942 |
| 50 % | 9.04 | 0.899 |

(`fee = 100 bps`; loss and volume both scale linearly with `S`.) Pushing to
99.9 % gives losses of 0.997, 0.990, 0.968 × S at `p0` = 1 %, 10 %, 50 %.

**Fee income** (only when `protocol_share_bps < 10 000`; by default it is
zero). With an LP fee share of 100%, fee income is `volume · f`, so the
break-even fee against the 99%-drain scenario is `f* = loss / volume`:
about 9 900 bps at `p0` = 1%, 2 980 bps at 10%, and 995 bps at 50%. Only the
50% case falls inside the 1 000 bps `MAX_FEE_BPS`, so **fees cover a one-sided
informed drain only at `p0` ≈ 50% with the maximum fee and a 100% LP share**.
At a realistic 100 bps they recover about 10% of the loss at 50% (0.090·S
against 0.90·S) and about 1% at the 1%/99% edge. Fees compensate noise
traders, not informed flow.

The full S × p0 × fee grid for `S ∈ {100, 200, 500}` USDC is printed by
`python3 model/fpmm_bounds.py --table`.

## 4. No-arbitrage

**Theorem 2 (no risk-free profit).** For one trader starting with no shares
and *any* finite sequence of buys and sells (any fee `0 ≤ f ≤ 1000`, including
0), let `profit = collateral_out − collateral_in`. Then

```
min(payoff_YES, payoff_NO) = profit + min(hy, hn)  ≤  −max(y − y0, n − n0)  ≤  0.
```

Since Void pays `⌊(hy+hn)/2⌋ ≥ min(hy, hn)`, no outcome set gives a strictly
positive guaranteed payoff. In particular, **a sequence that ends flat
(`hy = hn = 0`) has `collateral_out ≤ collateral_in`**.

*Proof.* Let `ΔM = M − S`. From share conservation,
`hy = ΔM − (y − y0)` and `hn = ΔM − (n − n0)`, so
`min(hy, hn) = ΔM − max(y − y0, n − n0)`. Collateral accounting: the
trader's net payment is the net sets minted plus fees,
`−profit = ΔM + Σfees`. Therefore
`profit + min(hy, hn) = −Σfees − max(y−y0, n−n0)`. Finally,
`max(y−y0, n−n0) ≥ 0`: otherwise both reserves are below their seed values
(and positive), giving `y·n < y0·n0`, contradicting L1. ∎

The script checks the strong form on **every** reachable state of the
exhaustive search (not just flat ones) and flags any state where it fails.

**Theorem 3 (path splitting never helps).** Splitting a total `Σ cᵢ` into
sequential buys of the same outcome never yields more shares than one buy of
the total.

*Proof.* (Fee 0.) After the first part the pool keeps
`y₁ = ⌈a·b/(b+c₁)⌉ ≥ a·b/(b+c₁)`. After the second,
`y₂ = ⌈y₁(b+c₁)/(b+c₁+c₂)⌉ ≥ a·b/(b+c₁+c₂)`, and since `y₂` is an integer,
`y₂ ≥ ⌈a·b/(b+c₁+c₂)⌉` = the pool's reserve after the single buy. Shares out
is `a + Σnet − y_final`, so the split gets no more. Extend to `m` parts by
induction. With fees, `Σ⌈cᵢf⌉ ≥ ⌈(Σcᵢ)f⌉`, so the split mints no more `net`,
and shares out is strictly increasing in `net`
(`shares(net+1) − shares(net) = 1 + (⌈x_net⌉ − ⌈x_{net+1}⌉) ≥ 1`). ∎

Checked exhaustively for all two-way splits over small reserves/fees and
randomly for 2–6-way splits at magnitudes up to `MAX_SETS`.

## 5. Void dust

Shares of each outcome sum to `M`, each recipient (holder, the creator for its
seed shares, the pool) is paid `⌊(aᵢ+bᵢ)/2⌋`. Therefore

```
dust = M − Σ⌊(aᵢ+bᵢ)/2⌋ = (#recipients with aᵢ+bᵢ odd) / 2  ≤  ⌊H/2⌋
```

for `H` payout recipients. Example: 1 000 holders leaves at most 500 stroops
(0.00005 USDC) locked forever, a solvency *surplus*. The script verifies the
identity and the bound over random allocations.

## 6. How the claims are verified

| Claim | Check | Coverage in `--quick` |
|---|---|---|
| L1, L2 | `check_one_step_dominance`, `_sell` | exhaustive via the searches + 50 k random ops |
| Identities, floors, bounds (a), (b), (c) | `lp_worst_case_exhaustive` | 1.3 M reachable pool states, 40 (S, p0, fee) configs, depth 3 |
| Theorem 2 | `exhaustive_round_trips` | 14 start pools × 4 fees × ≤ 3 ops, 73 k states |
| Theorem 3 | `exhaustive_path_splitting` + random | ~10 k small cases + random up to `MAX_SETS` |
| Void dust | `void_dust_bound` | 20 k random allocations |
| The search can fail | `--self-test` | floor-rounded `calc_buy` is flagged |

`exhaustive_round_trips` keeps, per `(y, n, hy, hn)`, only the *maximum*
profit (continuations depend on nothing else) and drops a state re-reached at
a later depth with no better profit, so pruning loses no sequence.
Start pools include the extreme-probability regime (`p0 = 1 %`/`99 %` with small
seeds) where integer effects dominate. `--full` (run locally, 111 s) extends depth and sample counts: 473 k trader
states at ≤ 4 operations (187 flat round trips), 6.2 M reachable LP pool
states, ~27 k path-splitting cases and 200 k random operations up to
`MAX_SETS`; every check passed.

`--self-test` replaces `calc_buy`'s `new_bought` ceiling by a floor and
confirms the search reports that `k` fell and a trader can profit, so a green
`--quick` run is not vacuous.

## 7. Recommendations (proposals; no parameter changes here)

These follow from the numbers above; they are judgment calls on top of the
derivations, flagged as such.

| Parameter | Today | Recommendation | Reason |
|---|---|---|---|
| Treasury risk model | undocumented | **Treat the seed as 100 % at risk.** | §3.2: worst-case loss is `S − 1`; no parameter changes that, only whether to seed. |
| `MIN_SEED` (100 USDC) | 100 USDC | Keep. | It does not bound loss (loss ∝ `S`). It only keeps rounding error (a few stroops per trade) negligible vs. `S`, which 10⁹ stroops already does. |
| `MIN_PROB_BPS` / `MAX_PROB_BPS` | 100 / 9 900 | Consider **500 / 9 500**. | Pushing the unlikely side to 99 % costs traders only 1.0·S at the 1 %/99 % edge vs. 2.25·S at 5 %/95 % and 9·S at 50 %; the pool's likelier-side reserve is `S/99` (≈ 1 USDC per 100). The LP's expected PnL is unchanged (it is a bet at `p0`), but the cheapest drain is 2.25× dearer. |
| `fee_bps = 0` | allowed (`set_default_fee_bps`) | Disallow below ~10 bps **as hygiene, not LP protection.** | Theorem 2 holds at `f = 0`, so 0 is not an arbitrage hole. But §3.4 shows fees can only cover a one-sided drain at `p0` ≈ 50 % with the 1000 bps maximum and a 100 % LP share, so no realistic floor protects the LP (break-even is ≈ 995 bps at 50 % and far above `MAX_FEE_BPS` at the edges, §3.4); a floor only buys a non-zero per-trade cost (note `fee = ⌈in·f/10⁴⌉ ≥ 1` stroop whenever `f ≥ 1`) and revenue for the protocol. |
| `protocol_share_bps` | default 10 000 | If the LP is not the treasury, set `< 10 000`. | At 10 000 the LP earns nothing for bearing the §3.2 risk. |
| `max_seed` vs `max_market` | deploy default `MAX_SEED = MAX_MARKET` (500) | `max_seed ≤ max_market / 2`. | The LP loss is bounded by `S`; the treasury can also trade the same market. Seeds count toward the per-market cap, so a seed at the cap leaves no room to hedge or follow-up trade. |
| `max_trade` / `max_market` | 200 / 500 USDC | Keep `max_market ≥ 2·max_trade`; document that `max_market` also bounds the LP loss. | Worst-case treasury loss in one market is `S` (LP) plus its directional trades, both within `max_market`. |
| Daily cap | `max_daily = 1 000` | Size so `max_markets_per_window · max_seed ≤ max_daily`. | The daily window counts seeds; this makes the creation-rate policy and the daily cap agree. |

## 8. Pitfalls checked

- **Seed shares are part of the LP position** (§3.1).
- **Fees are not LP income by default** (§1); both cases are presented.
- **`p0 = 99 %`**: `y0 = ⌊S·100/9900⌋` is tiny, so the exhaustive search runs
  seeds as small as 150 at `p0 = 1 %`.
- **`calc_sell` needs `gross < r_other`** so reserves never reach 0; bounds
  are infima.
- **Void dust** is quantified in §5.
