# Formal verification (`market-core` math)

`contracts/market-core/src/math_proofs.rs` contains [Kani](https://model-checking.github.io/kani/)
harnesses for the FPMM pricing engine. The harnesses are compiled only under
`cfg(kani)`; a normal `cargo build`, `cargo test` or `cargo clippy` never
compiles them.

CI runs them in `.github/workflows/kani.yml` on every change to `market-core`,
on pushes to `develop`/`main`, and weekly on a schedule.

```bash
cd oracledesk-stellar
cargo kani -p market-core
```

## Properties proved

| Harness | Property |
| --- | --- |
| `proof_mul_div_floor_bounds` | For non-negative `a, b` and `c > 0`, `q = floor(a*b/c)` satisfies `q*c <= a*b < q*c + c`. |
| `proof_mul_div_ceil_bounds` | For the same domain, `q = ceil(a*b/c)` satisfies `a*b <= q*c < a*b + c`, and `q == a*b/c` when the division is exact. |
| `proof_mul_div_rejects_invalid_inputs` | Negative operands or a non-positive divisor return `MathError::InvalidInput`; they never panic. |
| `proof_calc_buy_no_panic_and_positive_shares` | For in-domain reserves/collateral/fee, a successful buy returns positive shares, `net > 0`, `net + fee == collateral_in`, and increases the other reserve. |
| `proof_calc_buy_k_monotone` | A successful buy never decreases the constant product `r_bought * r_other`. |
| `proof_calc_sell_no_panic_and_positive_shares` | A successful sell returns positive shares, `gross >= collateral_out`, `gross - fee == collateral_out`, and leaves both reserves positive. |
| `proof_calc_sell_k_monotone` | A successful sell never decreases the constant product. |
| `proof_seed_reserves_hi_price` / `_lo_price` | Seeding at a requested probability produces reserves whose implied YES price is within 1 bp of the request, and assigns the creator only the opposite outcome. |
| `proof_seed_reserves_rejects_out_of_domain` | Out-of-range seed/probability inputs are rejected. |
| `proof_round_trip_no_profit` | Buying and immediately selling the same collateral never lets the seller end with more shares than the buy produced. If the sell leg is unavailable the property is vacuous. |
| `proof_price_yes_bps_bounds` | For positive reserves, `0 <= price_yes_bps <= BPS`. |
| `proof_isqrt_floor` | For every symbolic `u64` input, `isqrt` returns the floor of the square root. |
| `proof_calc_sell_shares_k_monotone` | A successful exact-share sell never decreases the constant product `r_sold * r_other`. |
| `proof_calc_sell_shares_le_calc_sell` | The exact-share quote never overpays relative to the forward `calc_sell` path. |

## Assumptions and why they are not cheating

Every `kani::assume` mirrors a check that the contract performs before calling
the math function. Narrowing the domain inside the proof without a matching
check would make the result vacuous, so the harnesses name the call site in a
comment:

* reserves are in `(0, MAX_SETS]` — `create_market` enforces the seed range and
  `buy` rejects `sets_minted + net > MAX_SETS`;
* trade fees are at most `MAX_FEE_BPS = 1_000` — enforced by the constructor
  and `set_default_fee_bps`;
* `collateral_in`/`collateral_out` in `(0, MAX_SETS]` — the contract rejects
  non-positive amounts and bounded caps reject oversized ones;
* signer-mode proofs assume the market is open and the fee recipient exists,
  because those are state-machine preconditions, not math properties.

`kani::unwind(1)` is sufficient because none of the harnessed functions loops.

## Scope and known gaps

This work proves the *local arithmetic* of the pricing engine. It does **not**
formally verify:

* the Soroban host, token transfers, or the wasm runtime;
* cross-contract authorization or state-machine reachability (covered by
  `contracts/integration-tests/tests/auth_matrix.rs`);
* oracle freshness/dispute logic in `resolver`;
* treasury caps and NAV accounting (covered by unit tests and the stateful
  model in `model/system_model.py`);
* storage TTL/rent behaviour.

Keeping the math module free of I/O is intentional: it is the part where an
off-by-one or overflow bug would silently misprice every trade, and it is the
part Kani can check without modelling the host.

## Changing the math

When `math.rs` or its domain checks change:

1. update the matching `assume_*` helper or call-site comment in
   `math_proofs.rs`;
2. add or adjust the property in the table above;
3. run `cargo kani -p market-core` locally (the CI job is the source of truth);
4. run `cargo test -p market-core` so the worked examples and proptests still
   agree with the model in `model/fpmm_model.py`.
