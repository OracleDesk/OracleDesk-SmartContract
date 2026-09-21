# LMSR pricing as an alternative curve

## Context

`market-core` hardcodes a Gnosis-style constant-product FPMM
(`contracts/market-core/src/math.rs`). LMSR (Hanson's Logarithmic Market
Scoring Rule) is the other common prediction-market pricing curve, with
different bounded-loss properties (a fixed subsidy `b` bounds the market
maker's worst-case loss, vs. FPMM's liquidity-proportional exposure). Some
markets (e.g. very thin ones, or ones a maker wants to seed with a hard cap
on subsidy) may prefer LMSR.

## What to change

Add an `lmsr` module alongside `math.rs` implementing LMSR pricing (needs a
fixed-point exponential/logarithm approximation — no floating point in a
Soroban contract), and a `PricingModel` choice on `create_market` (an enum
field on `Market`, defaulting to the existing FPMM to keep existing markets
and tests unaffected). `buy`/`sell` dispatch to the market's own pricing
model.

## Files to touch

- `contracts/market-core/src/lmsr.rs` (new)
- `contracts/market-core/src/lib.rs` (`Market.pricing_model`, dispatch in
  `buy`/`sell`/`quote_buy`/`quote_sell`)
- `model/fpmm_model.py` gets an `lmsr_model.py` sibling for the same
  cross-language property testing this repo already does for FPMM

## Acceptance criteria

- LMSR markets pass the same class of invariant tests as FPMM markets
  (price always in [0, 10000] bps, no free money on a buy+sell round trip).
- Existing FPMM markets and all current tests are unaffected.
- The fixed-point exp/log approximation's error bound is documented and
  tested against a reference (e.g. Python's `math.exp`/`math.log` in the
  sibling model file).

## How to test

```bash
cargo test -p market-core
python3 model/lmsr_model.py
```

## Complexity

`complexity/large`
