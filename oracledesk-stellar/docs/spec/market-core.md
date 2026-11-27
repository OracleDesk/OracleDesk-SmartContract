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

**MC-CONSTRUCTOR-AUTH-1** `auth(admin)`

**MC-CONSTRUCTOR-PRE-1** `collateral` exists and is a valid SEP-41 token.
**MC-CONSTRUCTOR-PRE-2** `resolver`, `treasury` are valid contract addresses.
**MC-CONSTRUCTOR-PRE-3** `default_fee_bps <= MAX_FEE_BPS` else `FeeTooHigh(1)`.

**MC-CONSTRUCTOR-POST-1** `I[Admin]` = `admin`.
**MC-CONSTRUCTOR-POST-2** `I[Collateral]` = `collateral`.
**MC-CONSTRUCTOR-POST-3** `I[Resolver]` = `resolver`.
**MC-CONSTRUCTOR-POST-4** `I[Treasury]` = `treasury`.
**MC-CONSTRUCTOR-POST-5** `I[DefaultFeeBps]` = `default_fee_bps`.
**MC-CONSTRUCTOR-POST-6** `I[Paused]` = `false`.
**MC-CONSTRUCTOR-POST-7** `P[MarketCount]` = `0`.

---

### `set_paused`

Pauses or unpauses trading.

**MC-SET_PAUSED-AUTH-1** `auth(admin)`.

**MC-SET_PAUSED-PRE-1** No preconditions on the new state.

**MC-SET_PAUSED-POST-1** `I[Paused]` = `paused`.

**MC-SET_PAUSED-ERR-1** `Unauthorized(2)` if caller is not admin.

---

### `set_default_fee_bps`

Changes the default fee for markets created after this call.

**MC-SET_DEFAULT_FEE_BPS-AUTH-1** `auth(admin)`.

**MC-SET_DEFAULT_FEE_BPS-PRE-1** `fee_bps <= MAX_FEE_BPS` else `FeeTooHigh(1)`.

**MC-SET_DEFAULT_FEE_BPS-POST-1** `I[DefaultFeeBps]` = `fee_bps`.

**MC-SET_DEFAULT_FEE_BPS-ERR-1** `FeeTooHigh(1)` if `fee_bps > MAX_FEE_BPS`.
**MC-SET_DEFAULT_FEE_BPS-ERR-2** `Unauthorized(2)` if caller is not admin.

---

### `set_resolver`

Changes the resolver contract address.

**MC-SET_RESOLVER-AUTH-1** `auth(admin)`.

**MC-SET_RESOLVER-PRE-1** `resolver` is a valid contract address.

**MC-SET_RESOLVER-POST-1** `I[Resolver]` = `resolver`.

**MC-SET_RESOLVER-ERR-1** `Unauthorized(2)` if caller is not admin.

---

### `set_treasury`

Changes the treasury contract address.

**MC-SET_TREASURY-AUTH-1** `auth(admin)`.

**MC-SET_TREASURY-PRE-1** `treasury` is a valid contract address.

**MC-SET_TREASURY-POST-1** `I[Treasury]` = `treasury`.

**MC-SET_TREASURY-ERR-1** `Unauthorized(2)` if caller is not admin.

---

### `create_market`

Creates a new binary market with FPMM initialization.

**MC-CREATE_MARKET-AUTH-1** `auth(creator)`.

**MC-CREATE_MARKET-PRE-1** `I[Paused] == false` else `Paused(2)`.
**MC-CREATE_MARKET-PRE-2** `seed_amount >= MIN_SEED` else `SeedTooSmall(3)`.
**MC-CREATE_MARKET-PRE-3** `seed_amount <= MAX_SETS` else `MarketTooLarge(15)`.
**MC-CREATE_MARKET-PRE-4** `fee_bps <= MAX_FEE_BPS` else `FeeTooHigh(1)`.
**MC-CREATE_MARKET-PRE-5** `close_time > now` else `CloseTimeInPast(4)`.

**MC-CREATE_MARKET-POST-1** New market entry created with `id = P[MarketCount] + 1`.
**MC-CREATE_MARKET-POST-2** `P[MarketCount]` incremented.
**MC-CREATE_MARKET-POST-3** `P[Market(id)]` initialized:
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
**MC-CREATE_MARKET-POST-4** Creator's position initialized: `P[Position(id, creator)] = {yes: seed_amount / 2, no: seed_amount / 2}`.
**MC-CREATE_MARKET-POST-5** `P[FeeTerms(id)]` = `{recipient: current fee recipient, protocol_share_bps: I[DefaultFeeBps]}`.
**MC-CREATE_MARKET-POST-6** `P[LpFees(id)]` = `0`.
**MC-CREATE_MARKET-POST-7** `collateral.transfer(creator, market_core, seed_amount)` is executed (token pulled from creator).
**MC-CREATE_MARKET-POST-8** Market persistent entry TTL bumped by `BUMP_MARKET_ENTRY`.

**MC-CREATE_MARKET-EVT-1** `MarketCreated { market_id: id, creator, seed_amount, close_time, fee_bps }`.

**MC-CREATE_MARKET-ERR-1** `Paused(2)` if `I[Paused]`.
**MC-CREATE_MARKET-ERR-2** `SeedTooSmall(3)` if `seed_amount < MIN_SEED`.
**MC-CREATE_MARKET-ERR-3** `CloseTimeInPast(4)` if `close_time <= now`.
**MC-CREATE_MARKET-ERR-4** `FeeTooHigh(1)` if `fee_bps > MAX_FEE_BPS`.
**MC-CREATE_MARKET-ERR-5** `MarketTooLarge(15)` if `seed_amount > MAX_SETS`.
**MC-CREATE_MARKET-ERR-6** Auth failure if `auth(creator)` fails.

**INV** `SYS-INV-1`, `SYS-INV-2`.

---

### `buy`

Buys shares from the FPMM pool.

**MC-BUY-AUTH-1** `auth(trader)`.

**MC-BUY-PRE-1** `I[Paused] == false` else `Paused(2)`.
**MC-BUY-PRE-2** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-BUY-PRE-3** `status == Open` else `MarketNotOpen(8)`.
**MC-BUY-PRE-4** `now < close_time` else `MarketClosed(9)`.
**MC-BUY-PRE-5** `collateral_in > 0` else `InvalidAmount(5)`.
**MC-BUY-PRE-6** Collateral amount fits in i128.

**MC-BUY-POST-1** FPMM calculation executed: `(shares_out, fee) = calc_buy(reserve_yes, reserve_no, outcome, collateral_in)`.
**MC-BUY-POST-2** `sets_minted' = sets_minted + shares_out`. Must not exceed `MAX_SETS` else `MarketTooLarge(15)`.
**MC-BUY-POST-3** Reserves updated per FPMM math (see `contracts/market-core/src/math.rs`).
**MC-BUY-POST-4** Fees split and accrued: `protocol_portion = ceil(fee * protocol_share / BPS)`, `lp_portion = fee - protocol_portion`.
**MC-BUY-POST-5** `P[Market(id)].fees_accrued` += `protocol_portion`.
**MC-BUY-POST-6** `P[LpFees(id)]` += `lp_portion`.
**MC-BUY-POST-7** Trader position updated: `P[Position(market_id, trader)].<outcome> += shares_out`.
**MC-BUY-POST-8** `collateral.transfer(trader, market_core, collateral_in)` executed (token pulled from trader).
**MC-BUY-POST-9** Market and position entries TTL-bumped.

**MC-BUY-EVT-1** `Trade { market_id, trader, outcome, is_buy: true, collateral_in, shares_out }`.

**MC-BUY-ERR-1** `Paused(2)` if `I[Paused]`.
**MC-BUY-ERR-2** `MarketNotFound(7)` if market does not exist.
**MC-BUY-ERR-3** `MarketNotOpen(8)` if status != `Open`.
**MC-BUY-ERR-4** `MarketClosed(9)` if `now >= close_time`.
**MC-BUY-ERR-5** `InvalidAmount(5)` if `collateral_in <= 0`.
**MC-BUY-ERR-6** `MarketTooLarge(15)` if `sets_minted' > MAX_SETS`.
**MC-BUY-ERR-7** Auth failure if `auth(trader)` fails.
**MC-BUY-ERR-8** Token transfer failure (bubbles from collateral contract).

**INV** `SYS-INV-1`, `SYS-INV-2`.

---

### `sell`

Sells shares back to the FPMM pool.

**MC-SELL-AUTH-1** `auth(seller)`.

**MC-SELL-PRE-1** `I[Paused] == false` else `Paused(2)`.
**MC-SELL-PRE-2** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-SELL-PRE-3** `status == Open` else `MarketNotOpen(8)`.
**MC-SELL-PRE-4** `now < close_time` else `MarketClosed(9)`.
**MC-SELL-PRE-5** `shares_in > 0` else `InvalidAmount(5)`.
**MC-SELL-PRE-6** `P[Position(market_id, seller)].<outcome> >= shares_in` else `InsufficientShares(6)`.

**MC-SELL-POST-1** FPMM calculation executed: `(collateral_out, fee) = calc_sell(reserve_yes, reserve_no, outcome, shares_in)`.
**MC-SELL-POST-2** `sets_minted' = sets_minted - shares_in` (checked subtract; underflow is `InsufficientShares`).
**MC-SELL-POST-3** Reserves updated per FPMM math.
**MC-SELL-POST-4** Fees split and accrued (as in `buy`).
**MC-SELL-POST-5** Seller position updated: `P[Position(market_id, seller)].<outcome> -= shares_in`. Entry deleted if position becomes zero.
**MC-SELL-POST-6** `collateral.transfer(market_core, seller, collateral_out)` executed (token paid to seller).
**MC-SELL-POST-7** Market and position entries TTL-bumped (or deleted).

**MC-SELL-EVT-1** `Trade { market_id, seller, outcome, is_buy: false, shares_in, collateral_out }`.

**MC-SELL-ERR-1** `Paused(2)` if `I[Paused]`.
**MC-SELL-ERR-2** `MarketNotFound(7)` if market does not exist.
**MC-SELL-ERR-3** `MarketNotOpen(8)` if status != `Open`.
**MC-SELL-ERR-4** `MarketClosed(9)` if `now >= close_time`.
**MC-SELL-ERR-5** `InvalidAmount(5)` if `shares_in <= 0`.
**MC-SELL-ERR-6** `InsufficientShares(6)` if seller's balance < `shares_in`.
**MC-SELL-ERR-7** Auth failure if `auth(seller)` fails.

**INV** `SYS-INV-1`, `SYS-INV-2`.

---

### `transfer_position` (New, Issue #146)

Transfers outcome shares from one holder to another (required for outcome token wrapper).

**MC-TRANSFER_POSITION-AUTH-1** `auth(from)`.

**MC-TRANSFER_POSITION-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-TRANSFER_POSITION-PRE-2** `amount > 0` else `InvalidAmount(5)`.
**MC-TRANSFER_POSITION-PRE-3** `from != to` else `InvalidAmount(5)`.
**MC-TRANSFER_POSITION-PRE-4** `P[Position(market_id, from)].<outcome> >= amount` else `InsufficientShares(6)`.

**MC-TRANSFER_POSITION-POST-1** `from`'s position: `P[Position(market_id, from)].<outcome> -= amount`. Entry deleted if zeroed.
**MC-TRANSFER_POSITION-POST-2** `to`'s position: `P[Position(market_id, to)].<outcome> += amount`.
**MC-TRANSFER_POSITION-POST-3** Both entries TTL-bumped (or deleted).

**MC-TRANSFER_POSITION-EVT-1** `PositionTransferred { market_id, from, to, outcome, amount }`.

**MC-TRANSFER_POSITION-ERR-1** `MarketNotFound(7)` if market does not exist.
**MC-TRANSFER_POSITION-ERR-2** `InvalidAmount(5)` if `amount <= 0` or `from == to`.
**MC-TRANSFER_POSITION-ERR-3** `InsufficientShares(6)` if `from` has insufficient shares.
**MC-TRANSFER_POSITION-ERR-4** Auth failure if `auth(from)` fails.

**INV** `SYS-INV-2` (reserve invariant preserved; total position supply unchanged).

---

### `resolve`

Called by the resolver to mark a market as finalized and record the winning outcome.

**MC-RESOLVE-AUTH-1** `auth(resolver)` where `resolver = I[Resolver]`.

**MC-RESOLVE-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-RESOLVE-PRE-2** `status != Finalized` else `AlreadyFinalized(10)`.
**MC-RESOLVE-PRE-3** `outcome` is a valid `Outcome` variant.

**MC-RESOLVE-POST-1** `P[Market(market_id)].outcome` = `outcome`.
**MC-RESOLVE-POST-2** `P[Market(market_id)].status` = `Finalized`.
**MC-RESOLVE-POST-3** Market entry TTL-bumped.

**MC-RESOLVE-EVT-1** `MarketResolved { market_id, outcome }`.

**MC-RESOLVE-ERR-1** `MarketNotFound(7)` if market does not exist.
**MC-RESOLVE-ERR-2** `AlreadyFinalized(10)` if `status == Finalized`.
**MC-RESOLVE-ERR-3** `Unauthorized(2)` if caller is not the resolver.

**INV** `SYS-INV-6`.

---

### `void_market`

Called by the resolver to void a market (settlement pays (yes+no)/2).

**MC-VOID_MARKET-AUTH-1** `auth(resolver)` where `resolver = I[Resolver]`.

**MC-VOID_MARKET-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-VOID_MARKET-PRE-2** `status != Finalized` else `AlreadyFinalized(10)`.

**MC-VOID_MARKET-POST-1** `P[Market(market_id)].status` = `Void`.
**MC-VOID_MARKET-POST-2** `P[Market(market_id)].outcome` = `None` (void has no outcome).
**MC-VOID_MARKET-POST-3** Market entry TTL-bumped.

**MC-VOID_MARKET-EVT-1** `MarketVoided { market_id }`.

**MC-VOID_MARKET-ERR-1** `MarketNotFound(7)` if market does not exist.
**MC-VOID_MARKET-ERR-2** `AlreadyFinalized(10)` if `status == Finalized`.
**MC-VOID_MARKET-ERR-3** `Unauthorized(2)` if caller is not the resolver.

**INV** `SYS-INV-6`, `SYS-INV-9`.

---

### `redeem`

Holder claims settlement for a finalized market.

**MC-REDEEM-AUTH-1** `auth(holder)`.

**MC-REDEEM-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-REDEEM-PRE-2** `status == Finalized` else `MarketNotFinalized(11)`.
**MC-REDEEM-PRE-3** `P[Position(market_id, holder)]` exists (or is zero; treated as zero).
**MC-REDEEM-PRE-4** No prior redemption by this holder (position entry must still exist or be re-readable; design choice: check a flag or allow re-read to return zero).

**MC-REDEEM-POST-1** Settlement value calculated per `math::settle_value(status, yes, no)`:
  - If `Resolved(Yes)`: `payout = yes`.
  - If `Resolved(No)`: `payout = no`.
  - If `Void`: `payout = floor((yes + no) / 2)`.
**MC-REDEEM-POST-2** `collateral.transfer(market_core, holder, payout)` executed.
**MC-REDEEM-POST-3** `P[Position(market_id, holder)]` deleted (entry removed to prevent re-redemption).
**MC-REDEEM-POST-4** No fee taken; full settlement is paid.

**MC-REDEEM-EVT-1** `Redeemed { market_id, holder, payout }`.

**MC-REDEEM-ERR-1** `MarketNotFound(7)` if market does not exist.
**MC-REDEEM-ERR-2** `MarketNotFinalized(11)` if `status != Finalized`.
**MC-REDEEM-ERR-3** Auth failure if `auth(holder)` fails.

**INV** `SYS-INV-8`.

---

### `claim_pool_remainder`

Creator claims their accumulated LP fees and remaining pool reserves.

**MC-CLAIM_POOL_REMAINDER-AUTH-1** `auth(creator)` where `creator = P[Market(market_id)].creator`.

**MC-CLAIM_POOL_REMAINDER-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-CLAIM_POOL_REMAINDER-PRE-2** `status == Finalized` else `MarketNotFinalized(11)`.
**MC-CLAIM_POOL_REMAINDER-PRE-3** `lp_claimed == false` else `AlreadyClaimed(12)`.

**MC-CLAIM_POOL_REMAINDER-POST-1** `remainder = P[LpFees(market_id)] + calc_lp_remainder(market_id)` where `calc_lp_remainder` computes the creator's pro-rata share of unswapped reserves.
**MC-CLAIM_POOL_REMAINDER-POST-2** `collateral.transfer(market_core, creator, remainder)` executed.
**MC-CLAIM_POOL_REMAINDER-POST-3** `P[Market(market_id)].lp_claimed` = `true`.
**MC-CLAIM_POOL_REMAINDER-POST-4** `P[LpFees(market_id)]` = `0` (or entry deleted).

**MC-CLAIM_POOL_REMAINDER-EVT-1** `PoolRemainder Claimed { market_id, creator, amount }`.

**MC-CLAIM_POOL_REMAINDER-ERR-1** `MarketNotFound(7)` if market does not exist.
**MC-CLAIM_POOL_REMAINDER-ERR-2** `MarketNotFinalized(11)` if `status != Finalized`.
**MC-CLAIM_POOL_REMAINDER-ERR-3** `AlreadyClaimed(12)` if `lp_claimed == true`.
**MC-CLAIM_POOL_REMAINDER-ERR-4** Auth failure if `auth(creator)` fails.

**INV** `SYS-INV-5`, `SYS-INV-1`.

---

### `sweep_fees`

Permissionless: sweeps accrued protocol fees to the current fee recipient.

**MC-SWEEP_FEES-AUTH-1** None (permissionless).

**MC-SWEEP_FEES-PRE-1** `P[Market(market_id)]` exists else `MarketNotFound(7)`.
**MC-SWEEP_FEES-PRE-2** `fees_accrued > 0` else `NoFeesToSweep(13)`.

**MC-SWEEP_FEES-POST-1** `collateral.transfer(market_core, current_fee_recipient, fees_accrued)` executed (uses current recipient, not snapshotted; design choice documented).
**MC-SWEEP_FEES-POST-2** `P[Market(market_id)].fees_accrued` = `0`.
**MC-SWEEP_FEES-POST-3** Market entry TTL-bumped.

**MC-SWEEP_FEES-EVT-1** `FeesSwept { market_id, amount, recipient }`.

**MC-SWEEP_FEES-ERR-1** `MarketNotFound(7)` if market does not exist.
**MC-SWEEP_FEES-ERR-2** `NoFeesToSweep(13)` if `fees_accrued == 0`.

**INV** `SYS-INV-4`.

---

## View Functions

### `get_config`

Returns the current admin, collateral, resolver, treasury, paused state, and default fee.

**MC-GET_CONFIG-PRE-1** No preconditions.

**MC-GET_CONFIG-POST-1** Returns `Config { admin, collateral, resolver, treasury, paused, default_fee_bps }`.

**NOTES** Calling `get_config` reads `I[Admin]`, which performs an `instance_get` and may extend instance TTL as a side effect (implementation detail; not normative).

---

### `market_count`

Returns the total number of markets ever created.

**MC-MARKET_COUNT-PRE-1** No preconditions.

**MC-MARKET_COUNT-POST-1** Returns `P[MarketCount]`.

---

### `get_market`

Returns the full market entry for a given market ID.

**MC-GET_MARKET-PRE-1** No preconditions (returns None if not found; design choice: use Option<Market>).

**MC-GET_MARKET-POST-1** Returns `Some(P[Market(market_id)])` if exists, `None` otherwise. TTL is bumped on read.

---

### `get_position`

Returns the holder's position (YES and NO shares) for a given market.

**MC-GET_POSITION-PRE-1** No preconditions.

**MC-GET_POSITION-POST-1** Returns `Some(P[Position(market_id, holder)])` if exists, `None` or `{yes: 0, no: 0}` otherwise. TTL bumped on read (if exists).

---

### `get_price`

Returns the current FPMM price for a given market and outcome.

**MC-GET_PRICE-PRE-1** `P[Market(market_id)]` exists else returns an error.
**MC-GET_PRICE-PRE-2** `status == Open` (design choice: allow or disallow price quotes on closed/resolved markets; currently allowed, documented as INTENTIONAL).

**MC-GET_PRICE-POST-1** Calls `math::calc_price(reserve_yes, reserve_no, outcome)` and returns the price (probability in BPS).

---

### `quote_buy`

Returns the shares and fees for a hypothetical buy without executing it.

**MC-QUOTE_BUY-PRE-1** No state-change preconditions (quotes allowed even if paused or closed; documented as INTENTIONAL).

**MC-QUOTE_BUY-POST-1** Calls `math::calc_buy(...)` and returns `(shares_out, fee)`.

---

### `quote_sell`

Returns the collateral and fees for a hypothetical sell without executing it.

**MC-QUOTE_SELL-PRE-1** No state-change preconditions.

**MC-QUOTE_SELL-POST-1** Calls `math::calc_sell(...)` and returns `(collateral_out, fee)`.

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
