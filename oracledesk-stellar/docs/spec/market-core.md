# OracleDesk Protocol Specification — market-core Contract

This document specifies every public entrypoint and view of the market-core contract, which manages binary outcome markets with FPMM pricing and settlement.

## Constants and Parameters

| Constant | Value | Notes |
|----------|-------|-------|
| `MIN_PROB_BPS` | 10 | Minimum probability = 0.1%, enforces `1 / 999` min price. |
| `MAX_PROB_BPS` | 999900 | Maximum probability = 99.99%, enforces `1 / 999` max price. |
| `MAX_SETS` | 10^18 (1 billion USDC equivalent) | Maximum sets minted per market; prevents integer overflow. |
| `MAX_FEE_BPS` | 500 | Maximum fee bps = 5%; enforced at `create_market`. |
| `MIN_SEED` | 100e7 (100 USDC) | Minimum seed for a market to clear liquidity pools. |
| `BUMP_MARKET_ENTRY` | 2592000 | TTL bump amount for market entries (30 days). |
| `BUMP_POSITION_ENTRY` | 2592000 | TTL bump amount for position entries. |
| `BUMP_FEE_ENTRY` | 2592000 | TTL bump amount for fee entries. |

## Instance Storage

| Key | Type | Notes |
|-----|------|-------|
| `I[Admin]` | `Address` | Admin address; can call admin entrypoints. |
| `I[MarketCore]` | `Address` | Self-reference (used for validation). |
| `I[Collateral]` | `Address` | The SEP-41 token used for all markets. |
| `I[Resolver]` | `Address` | The resolver contract address. |
| `I[Treasury]` | `Address` | The treasury contract address. |
| `I[Paused]` | `bool` | If true, trading is paused (but merge is allowed). |
| `I[DefaultFeeBps]` | `u32` | Default fee for new markets (0–500 BPS). |

None of these instance entries are TTL-bumped. Instance TTL is managed by contract initialization only.

## Persistent Storage

| Key | Type | Notes |
|-----|------|-------|
| `P[MarketCount]` | `u64` | Total markets ever created (IDs are 1-indexed). |
| `P[Market(id)]` | `Market` | Market entry: status, reserves, sets minted, fees, outcome, resolution hash. |
| `P[Position(market_id, holder)]` | `Position` | Holder's shares: `{yes: i128, no: i128}`. Deleted if zeroed. |
| `P[FeeTerms(market_id)]` | `FeeTerms` | Fee recipient snapshot at creation time. |
| `P[LpFees(market_id)]` | `i128` | Creator's accrued fee balance; not yet claimed. |
| `P[Config]` | `Config` | Instance config snapshot for upgrades (see notes). |

All persistent entries are TTL-bumped on:
- **Read** (`load_market`, `load_position`, etc.): extended by `BUMP_*_ENTRY`.
- **Write** (`save_market`, `save_position`, etc.): extended by `BUMP_*_ENTRY`.

## Data Types

### Market

```rust
pub struct Market {
    pub creator: Address,
    pub collateral_in: i128,
    pub close_time: u64,
    pub status: MarketStatus,         // Open | Closed | Resolved | Void | Finalized
    pub reserve_yes: i128,            // Pool's YES reserves
    pub reserve_no: i128,             // Pool's NO reserves
    pub sets_minted: i128,            // Total YES+NO sets created
    pub fees_accrued: i128,           // Protocol's pending fees
    pub lp_claimed: bool,             // If true, creator has claimed pool remainder
    pub outcome: Option<Outcome>,     // Set only if Resolved
    pub resolution_hash: BytesN<32>,  // Commit for resolver
}
```

### Position

```rust
pub struct Position {
    pub yes: i128,
    pub no: i128,
}
```

### FeeTerms

```rust
pub struct FeeTerms {
    pub recipient: Address,
    pub protocol_share_bps: u32,
}
```

### Outcome

```rust
pub enum Outcome {
    Yes,
    No,
}
```

### MarketStatus

```rust
pub enum MarketStatus {
    Open,
    Closed,
    Resolved,
    Void,
    Finalized,
}
```

## Entrypoints

### Constructor: `__constructor`

Initializes instance storage with admin, collateral, resolver, treasury, and default fee.

**AUTH-1** `auth(admin)`

**PRE-1** `collateral` exists and is a valid SEP-41 token.
**PRE-2** `resolver`, `treasury` are valid contract addresses.
**PRE-3** `default_fee_bps <= MAX_FEE_BPS` else `FeeTooHigh(1)`.

**POST-1** `I[Admin]` = `admin`.
**POST-2** `I[Collateral]` = `collateral`.
**POST-3** `I[Resolver]` = `resolver`.
**POST-4** `I[Treasury]` = `treasury`.
**POST-5** `I[DefaultFeeBps]` = `default_fee_bps`.
**POST-6** `I[Paused]` = `false`.
**POST-7** `P[MarketCount]` = `0`.

---

### `set_paused`

Pauses or unpauses trading.

**AUTH-1** `auth(admin)`.

**PRE-1** No preconditions on the new state.

**POST-1** `I[Paused]` = `paused`.

**ERR-1** `Unauthorized(2)` if caller is not admin.

---

### `set_default_fee_bps`

Changes the default fee for markets created after this call.

**AUTH-1** `auth(admin)`.

**PRE-1** `fee_bps <= MAX_FEE_BPS` else `FeeTooHigh(1)`.

**POST-1** `I[DefaultFeeBps]` = `fee_bps`.

**ERR-1** `FeeTooHigh(1)` if `fee_bps > MAX_FEE_BPS`.
**ERR-2** `Unauthorized(2)` if caller is not admin.

---

### `set_resolver`

Changes the resolver contract address.

**AUTH-1** `auth(admin)`.

**PRE-1** `resolver` is a valid contract address.

**POST-1** `I[Resolver]` = `resolver`.

**ERR-1** `Unauthorized(2)` if caller is not admin.

---

### `set_treasury`

Changes the treasury contract address.

**AUTH-1** `auth(admin)`.

**PRE-1** `treasury` is a valid contract address.

**POST-1** `I[Treasury]` = `treasury`.

**ERR-1** `Unauthorized(2)` if caller is not admin.

---

### `create_market`

Creates a new binary market with FPMM initialization.

**AUTH-1** `auth(creator)`.

**PRE-1** `I[Paused] == false` else `Paused(2)`.
**PRE-2** `seed_amount >= MIN_SEED` else `SeedTooSmall(3)`.
**PRE-3** `seed_amount <= MAX_SETS` else `MarketTooLarge(15)`.
**PRE-4** `fee_bps <= MAX_FEE_BPS` else `FeeTooHigh(1)`.
**PRE-5** `close_time > now` else `CloseTimeInPast(4)`.

**POST-1** New market entry created with `id = P[MarketCount] + 1`.
**POST-2** `P[MarketCount]` incremented.
**POST-3** `P[Market(id)]` initialized:
  - `creator` = `creator`.
  - `status` = `Open`.
  - `close_time` = `close_time`.
  - `sets_minted` = `seed_amount`.
  - `reserve_yes` = `seed_amount / 2`.
  - `reserve_no` = `seed_amount / 2`.
  - `fees_accrued` = `0`.
  - `lp_claimed` = `false`.
  - `outcome` = `None`.
  - `resolution_hash` = `resolution_hash`.
**POST-4** Creator's position initialized: `P[Position(id, creator)] = {yes: seed_amount / 2, no: seed_amount / 2}`.
**POST-5** `P[FeeTerms(id)]` = `{recipient: current fee recipient, protocol_share_bps: I[DefaultFeeBps]}`.
**POST-6** `P[LpFees(id)]` = `0`.
**POST-7** `collateral.transfer(creator, market_core, seed_amount)` is executed (token pulled from creator).
**POST-8** Market persistent entry TTL bumped by `BUMP_MARKET_ENTRY`.

**EVT-1** `MarketCreated { market_id: id, creator, seed_amount, close_time, fee_bps }`.

**ERR-1** `Paused(2)` if `I[Paused]`.
**ERR-2** `SeedTooSmall(3)` if `seed_amount < MIN_SEED`.
**ERR-3** `CloseTimeInPast(4)` if `close_time <= now`.
**ERR-4** `FeeTooHigh(1)` if `fee_bps > MAX_FEE_BPS`.
**ERR-5** `MarketTooLarge(15)` if `seed_amount > MAX_SETS`.
**ERR-6** Auth failure if `auth(creator)` fails.

**INV** `SYS-INV-1`, `SYS-INV-2`.

---

### `buy`

Buys shares from the FPMM pool.

**AUTH-1** `auth(trader)`.

**PRE-1** `I[Paused] == false` else `Paused(2)`.
**PRE-2** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-3** `status == Open` else `MarketNotOpen(8)`.
**PRE-4** `now < close_time` else `MarketClosed(9)`.
**PRE-5** `collateral_in > 0` else `InvalidAmount(5)`.
**PRE-6** Collateral amount fits in i128.

**POST-1** FPMM calculation executed: `(shares_out, fee) = calc_buy(reserve_yes, reserve_no, outcome, collateral_in)`.
**POST-2** `sets_minted' = sets_minted + shares_out`. Must not exceed `MAX_SETS` else `MarketTooLarge(15)`.
**POST-3** Reserves updated per FPMM math (see `contracts/market-core/src/math.rs`).
**POST-4** Fees split and accrued: `protocol_portion = ceil(fee * protocol_share / BPS)`, `lp_portion = fee - protocol_portion`.
**POST-5** `P[Market(id)].fees_accrued` += `protocol_portion`.
**POST-6** `P[LpFees(id)]` += `lp_portion`.
**POST-7** Trader position updated: `P[Position(market_id, trader)].<outcome> += shares_out`.
**POST-8** `collateral.transfer(trader, market_core, collateral_in)` executed (token pulled from trader).
**POST-9** Market and position entries TTL-bumped.

**EVT-1** `Trade { market_id, trader, outcome, is_buy: true, collateral_in, shares_out }`.

**ERR-1** `Paused(2)` if `I[Paused]`.
**ERR-2** `MarketNotFound(7)` if market does not exist.
**ERR-3** `MarketNotOpen(8)` if status != `Open`.
**ERR-4** `MarketClosed(9)` if `now >= close_time`.
**ERR-5** `InvalidAmount(5)` if `collateral_in <= 0`.
**ERR-6** `MarketTooLarge(15)` if `sets_minted' > MAX_SETS`.
**ERR-7** Auth failure if `auth(trader)` fails.
**ERR-8** Token transfer failure (bubbles from collateral contract).

**INV** `SYS-INV-1`, `SYS-INV-2`.

---

### `sell`

Sells shares back to the FPMM pool.

**AUTH-1** `auth(seller)`.

**PRE-1** `I[Paused] == false` else `Paused(2)`.
**PRE-2** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-3** `status == Open` else `MarketNotOpen(8)`.
**PRE-4** `now < close_time` else `MarketClosed(9)`.
**PRE-5** `shares_in > 0` else `InvalidAmount(5)`.
**PRE-6** `P[Position(market_id, seller)].<outcome> >= shares_in` else `InsufficientShares(6)`.

**POST-1** FPMM calculation executed: `(collateral_out, fee) = calc_sell(reserve_yes, reserve_no, outcome, shares_in)`.
**POST-2** `sets_minted' = sets_minted - shares_in` (checked subtract; underflow is `InsufficientShares`).
**POST-3** Reserves updated per FPMM math.
**POST-4** Fees split and accrued (as in `buy`).
**POST-5** Seller position updated: `P[Position(market_id, seller)].<outcome> -= shares_in`. Entry deleted if position becomes zero.
**POST-6** `collateral.transfer(market_core, seller, collateral_out)` executed (token paid to seller).
**POST-7** Market and position entries TTL-bumped (or deleted).

**EVT-1** `Trade { market_id, seller, outcome, is_buy: false, shares_in, collateral_out }`.

**ERR-1** `Paused(2)` if `I[Paused]`.
**ERR-2** `MarketNotFound(7)` if market does not exist.
**ERR-3** `MarketNotOpen(8)` if status != `Open`.
**ERR-4** `MarketClosed(9)` if `now >= close_time`.
**ERR-5** `InvalidAmount(5)` if `shares_in <= 0`.
**ERR-6** `InsufficientShares(6)` if seller's balance < `shares_in`.
**ERR-7** Auth failure if `auth(seller)` fails.

**INV** `SYS-INV-1`, `SYS-INV-2`.

---

### `transfer_position` (New, Issue #146)

Transfers outcome shares from one holder to another (required for outcome token wrapper).

**AUTH-1** `auth(from)`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-2** `amount > 0` else `InvalidAmount(5)`.
**PRE-3** `from != to` else `InvalidAmount(5)`.
**PRE-4** `P[Position(market_id, from)].<outcome> >= amount` else `InsufficientShares(6)`.

**POST-1** `from`'s position: `P[Position(market_id, from)].<outcome> -= amount`. Entry deleted if zeroed.
**POST-2** `to`'s position: `P[Position(market_id, to)].<outcome> += amount`.
**POST-3** Both entries TTL-bumped (or deleted).

**EVT-1** `PositionTransferred { market_id, from, to, outcome, amount }`.

**ERR-1** `MarketNotFound(7)` if market does not exist.
**ERR-2** `InvalidAmount(5)` if `amount <= 0` or `from == to`.
**ERR-3** `InsufficientShares(6)` if `from` has insufficient shares.
**ERR-4** Auth failure if `auth(from)` fails.

**INV** `SYS-INV-2` (reserve invariant preserved; total position supply unchanged).

---

### `resolve`

Called by the resolver to mark a market as finalized and record the winning outcome.

**AUTH-1** `auth(resolver)` where `resolver = I[Resolver]`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-2** `status != Finalized` else `AlreadyFinalized(10)`.
**PRE-3** `outcome` is a valid `Outcome` variant.

**POST-1** `P[Market(market_id)].outcome` = `outcome`.
**POST-2** `P[Market(market_id)].status` = `Finalized`.
**POST-3** Market entry TTL-bumped.

**EVT-1** `MarketResolved { market_id, outcome }`.

**ERR-1** `MarketNotFound(7)` if market does not exist.
**ERR-2** `AlreadyFinalized(10)` if `status == Finalized`.
**ERR-3** `Unauthorized(2)` if caller is not the resolver.

**INV** `SYS-INV-6`.

---

### `void_market`

Called by the resolver to void a market (settlement pays (yes+no)/2).

**AUTH-1** `auth(resolver)` where `resolver = I[Resolver]`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-2** `status != Finalized` else `AlreadyFinalized(10)`.

**POST-1** `P[Market(market_id)].status` = `Void`.
**POST-2** `P[Market(market_id)].outcome` = `None` (void has no outcome).
**POST-3** Market entry TTL-bumped.

**EVT-1** `MarketVoided { market_id }`.

**ERR-1** `MarketNotFound(7)` if market does not exist.
**ERR-2** `AlreadyFinalized(10)` if `status == Finalized`.
**ERR-3** `Unauthorized(2)` if caller is not the resolver.

**INV** `SYS-INV-6`, `SYS-INV-9`.

---

### `redeem`

Holder claims settlement for a finalized market.

**AUTH-1** `auth(holder)`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-2** `status == Finalized` else `MarketNotFinalized(11)`.
**PRE-3** `P[Position(market_id, holder)]` exists (or is zero; treated as zero).
**PRE-4** No prior redemption by this holder (position entry must still exist or be re-readable; design choice: check a flag or allow re-read to return zero).

**POST-1** Settlement value calculated per `math::settle_value(status, yes, no)`:
  - If `Resolved(Yes)`: `payout = yes`.
  - If `Resolved(No)`: `payout = no`.
  - If `Void`: `payout = floor((yes + no) / 2)`.
**POST-2** `collateral.transfer(market_core, holder, payout)` executed.
**POST-3** `P[Position(market_id, holder)]` deleted (entry removed to prevent re-redemption).
**POST-4** No fee taken; full settlement is paid.

**EVT-1** `Redeemed { market_id, holder, payout }`.

**ERR-1** `MarketNotFound(7)` if market does not exist.
**ERR-2** `MarketNotFinalized(11)` if `status != Finalized`.
**ERR-3** Auth failure if `auth(holder)` fails.

**INV** `SYS-INV-8`.

---

### `claim_pool_remainder`

Creator claims their accumulated LP fees and remaining pool reserves.

**AUTH-1** `auth(creator)` where `creator = P[Market(market_id)].creator`.

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-2** `status == Finalized` else `MarketNotFinalized(11)`.
**PRE-3** `lp_claimed == false` else `AlreadyClaimed(12)`.

**POST-1** `remainder = P[LpFees(market_id)] + calc_lp_remainder(market_id)` where `calc_lp_remainder` computes the creator's pro-rata share of unswapped reserves.
**POST-2** `collateral.transfer(market_core, creator, remainder)` executed.
**POST-3** `P[Market(market_id)].lp_claimed` = `true`.
**POST-4** `P[LpFees(market_id)]` = `0` (or entry deleted).

**EVT-1** `PoolRemainder Claimed { market_id, creator, amount }`.

**ERR-1** `MarketNotFound(7)` if market does not exist.
**ERR-2** `MarketNotFinalized(11)` if `status != Finalized`.
**ERR-3** `AlreadyClaimed(12)` if `lp_claimed == true`.
**ERR-4** Auth failure if `auth(creator)` fails.

**INV** `SYS-INV-5`, `SYS-INV-1`.

---

### `sweep_fees`

Permissionless: sweeps accrued protocol fees to the current fee recipient.

**AUTH-1** None (permissionless).

**PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**PRE-2** `fees_accrued > 0` else `NoFeesToSweep(13)`.

**POST-1** `collateral.transfer(market_core, current_fee_recipient, fees_accrued)` executed (uses current recipient, not snapshotted; design choice documented).
**POST-2** `P[Market(market_id)].fees_accrued` = `0`.
**POST-3** Market entry TTL-bumped.

**EVT-1** `FeesSwept { market_id, amount, recipient }`.

**ERR-1** `MarketNotFound(7)` if market does not exist.
**ERR-2** `NoFeesToSweep(13)` if `fees_accrued == 0`.

**INV** `SYS-INV-4`.

---

## View Functions

### `get_config`

Returns the current admin, collateral, resolver, treasury, paused state, and default fee.

**PRE-1** No preconditions.

**POST-1** Returns `Config { admin, collateral, resolver, treasury, paused, default_fee_bps }`.

**NOTES** Calling `get_config` reads `I[Admin]`, which performs an `instance_get` and may extend instance TTL as a side effect (implementation detail; not normative).

---

### `market_count`

Returns the total number of markets ever created.

**PRE-1** No preconditions.

**POST-1** Returns `P[MarketCount]`.

---

### `get_market`

Returns the full market entry for a given market ID.

**PRE-1** No preconditions (returns None if not found; design choice: use Option<Market>).

**POST-1** Returns `Some(P[Market(market_id)])` if exists, `None` otherwise. TTL is bumped on read.

---

### `get_position`

Returns the holder's position (YES and NO shares) for a given market.

**PRE-1** No preconditions.

**POST-1** Returns `Some(P[Position(market_id, holder)])` if exists, `None` or `{yes: 0, no: 0}` otherwise. TTL bumped on read (if exists).

---

### `get_price`

Returns the current FPMM price for a given market and outcome.

**PRE-1** `P[Market(market_id)]` exists else returns an error.
**PRE-2** `status == Open` (design choice: allow or disallow price quotes on closed/resolved markets; currently allowed, documented as INTENTIONAL).

**POST-1** Calls `math::calc_price(reserve_yes, reserve_no, outcome)` and returns the price (probability in BPS).

---

### `quote_buy`

Returns the shares and fees for a hypothetical buy without executing it.

**PRE-1** No state-change preconditions (quotes allowed even if paused or closed; documented as INTENTIONAL).

**POST-1** Calls `math::calc_buy(...)` and returns `(shares_out, fee)`.

---

### `quote_sell`

Returns the collateral and fees for a hypothetical sell without executing it.

**PRE-1** No state-change preconditions.

**POST-1** Calls `math::calc_sell(...)` and returns `(collateral_out, fee)`.

---

## Error Codes (Market-core)

| Code | Name | Trigger |
|------|------|---------|
| 1 | `FeeTooHigh` | `fee_bps > MAX_FEE_BPS`. |
| 2 | `Paused` | Trading paused; merge always allowed. |
| 3 | `SeedTooSmall` | `seed_amount < MIN_SEED`. |
| 4 | `CloseTimeInPast` | `close_time <= now` on `create_market`. |
| 5 | `InvalidAmount` | Negative or zero amount, or `from == to` in transfer. |
| 6 | `InsufficientShares` | Seller or transferrer has insufficient balance. |
| 7 | `MarketNotFound` | Market ID does not exist. |
| 8 | `MarketNotOpen` | Market status != `Open`. |
| 9 | `MarketClosed` | Attempting trade after `close_time`. |
| 10 | `AlreadyFinalized` | Market already in `Finalized` state. |
| 11 | `MarketNotFinalized` | Market status != `Finalized` on redeem/claim. |
| 12 | `AlreadyClaimed` | LP already claimed pool remainder. |
| 13 | `NoFeesToSweep` | `fees_accrued == 0` on sweep. |
| 14 | (unused) | Reserved. |
| 15 | `MarketTooLarge` | `sets_minted' > MAX_SETS`. |

---

## Invariants

- `SYS-INV-1`: Solvency per market (balance == sets_minted + fees + lp_fees).
- `SYS-INV-2`: Reserve invariant (reserve_yes + Σyes == sets_minted).
- `SYS-INV-5`: Single LP payout (lp_claimed flag prevents re-entry).
- `SYS-INV-6`: Resolver finalizes once (AlreadyFinalized guard).
- `SYS-INV-8`: Single redeem per holder per market (position deletion).
- `SYS-INV-9`: Void payout bounded (no holder receives more than pro-rata).

## See Also

- `contracts/market-core/src/lib.rs` — implementation.
- `contracts/market-core/src/math.rs` — FPMM pricing and rounding rules.
- `docs/fpmm-economics.md` — FPMM model and properties.
- `docs/spec/system.md` — cross-contract invariants.
