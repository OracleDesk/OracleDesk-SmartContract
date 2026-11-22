/**
 * Off-chain mirror of contracts/market-core for the simulator. Preconditions,
 * check order and error names follow lib.rs (`create_market`, `do_buy`,
 * `do_sell`, `resolve`, `void_market`, `redeem`, `claim_pool_remainder`,
 * `claim_lp_fees`, `sweep_fees`); every amount comes from agents/core/fpmm.ts
 * — this file does no AMM math of its own. Not mirrored: pause, the optional
 * price-impact/band breakers (off by default), position/LP transfers.
 *
 * All state lives in plain `state` objects so a whole world can be
 * snapshotted with structuredClone and restored, which is how Soroban's
 * transaction atomicity is modelled (see {@link atomically}).
 */
import {
  BPS,
  buyWithinLimit,
  calcBuy,
  calcSell,
  MathError,
  MAX_PROB_BPS,
  MAX_SETS,
  MIN_PROB_BPS,
  mulDivCeil,
  priceYesBps,
  seedReserves,
  settleValue,
  type Settlement,
} from "../core/fpmm.js";

/** market-core `MIN_SEED`: 100 USDC at 7 decimals. */
export const MIN_SEED = 100n * 10_000_000n;

export type Outcome = "Yes" | "No";
export type MarketStatus = "Open" | "ResolvedYes" | "ResolvedNo" | "Void";

/** A revert, named after the contract error (`MarketClosed`, ...). */
export class SimContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SimContractError";
  }
}

const fail = (code: string): never => {
  throw new SimContractError(code);
};

/** Runs fpmm math, mapping MathError like market-core's `From<MathError>`. */
function math<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MathError) {
      return fail(/liquidity/.test(err.message) ? "InsufficientLiquidity" : "InvalidAmount");
    }
    throw err;
  }
}

export interface Position {
  yes: bigint;
  no: bigint;
}

/** Collateral flows in and out of one market, for conservation checks. */
export interface MarketFlows {
  deposited: bigint;
  soldOut: bigint;
  redeemed: bigint;
  poolClaim: bigint;
  lpFeesClaimed: bigint;
  feesSwept: bigint;
}

export interface MarketData {
  id: number;
  creator: string;
  reserveYes: bigint;
  reserveNo: bigint;
  setsMinted: bigint;
  /** Protocol share of fees, swept by `sweep_fees`. */
  feesAccrued: bigint;
  /** LP share of fees (`LpFees(id)`), claimed by the creator. */
  lpFees: bigint;
  feeBps: bigint;
  protocolShareBps: bigint;
  closeTime: bigint;
  status: MarketStatus;
  lpClaimed: boolean;
  /** Set by the first redeem or pool claim: the pre-settlement invariants
   * stop applying once positions start being cleared. */
  settling: boolean;
  /** market-core's token balance attributable to this market. */
  balance: bigint;
  positions: Record<string, Position>;
  seed: bigint;
  seedCreatorYes: bigint;
  seedCreatorNo: bigint;
  flows: MarketFlows;
}

/** Collateral token balances. Debits fail like a token transfer would. */
export class Ledger {
  state: { balances: Record<string, bigint> } = { balances: {} };

  balance(id: string): bigint {
    return this.state.balances[id] ?? 0n;
  }

  mint(id: string, amount: bigint): void {
    this.state.balances[id] = this.balance(id) + amount;
  }

  transfer(from: string, to: string, amount: bigint): void {
    if (amount < 0n) fail("InvalidAmount");
    if (this.balance(from) < amount) fail("InsufficientBalance");
    this.state.balances[from] = this.balance(from) - amount;
    this.state.balances[to] = this.balance(to) + amount;
  }

  total(): bigint {
    return Object.values(this.state.balances).reduce((a, b) => a + b, 0n);
  }
}

export interface Stateful {
  state: unknown;
}

/**
 * Runs `fn` as one Soroban invocation: if it throws, every part's state is
 * restored to its pre-call snapshot and the error is rethrown.
 */
export function atomically<T>(parts: Stateful[], fn: () => T): T {
  const snapshots = parts.map((p) => structuredClone(p.state));
  try {
    return fn();
  } catch (err) {
    parts.forEach((p, i) => {
      p.state = snapshots[i];
    });
    throw err;
  }
}

/**
 * {@link atomically} for one treasury call on market-core: snapshots only
 * market `marketId` (or, for a create, the market count) instead of every
 * market, so long runs don't pay for cloning settled history.
 */
export function atomicallyOnMarket<T>(core: SimMarketCore, others: Stateful[], marketId: number | undefined, fn: () => T): T {
  const count = core.state.markets.length;
  const market = marketId !== undefined && marketId < count ? structuredClone(core.state.markets[marketId]!) : undefined;
  try {
    return atomically(others, fn);
  } catch (err) {
    core.state.markets.length = count;
    if (market) core.state.markets[market.id] = market;
    throw err;
  }
}

/** Sorted keys: never iterate positions in insertion order. */
export function sortedHolders(m: MarketData): string[] {
  return Object.keys(m.positions).sort();
}

const settlementOf = (m: MarketData): Settlement =>
  m.status === "ResolvedYes" ? "yes" : m.status === "ResolvedNo" ? "no" : m.status === "Void" ? "void" : fail("NotFinal");

export interface CoreOptions {
  feeBps: bigint;
  protocolShareBps: bigint;
  /** Ledger account `sweep_fees` pays (the snapshotted fee recipient). */
  feeRecipient: string;
  /** Ledger account holding market-core's collateral. */
  account?: string;
  /** Assert invariants after every mutation (default true). */
  checkInvariants?: boolean;
}

export class SimMarketCore implements Stateful {
  state: { markets: MarketData[] } = { markets: [] };
  readonly account: string;

  constructor(
    private readonly ledger: Ledger,
    private readonly opts: CoreOptions,
  ) {
    this.account = opts.account ?? "market-core";
    if (opts.feeBps >= BPS || opts.protocolShareBps > BPS) fail("InvalidFee");
  }

  get markets(): readonly MarketData[] {
    return this.state.markets;
  }

  market(id: number): MarketData {
    return this.state.markets[id] ?? fail("MarketNotFound");
  }

  private position(m: MarketData, holder: string): Position {
    return (m.positions[holder] ??= { yes: 0n, no: 0n });
  }

  priceYes(id: number): bigint {
    const m = this.market(id);
    return priceYesBps(m.reserveYes, m.reserveNo);
  }

  createMarket(creator: string, seed: bigint, initialYesBps: bigint, closeTime: bigint, now: bigint): number {
    if (closeTime <= now) fail("InvalidCloseTime");
    if (seed < MIN_SEED || seed > MAX_SETS) fail("InvalidAmount");
    if (initialYesBps < MIN_PROB_BPS || initialYesBps > MAX_PROB_BPS) fail("InvalidProbability");
    const s = math(() => seedReserves(seed, initialYesBps));
    this.ledger.transfer(creator, this.account, seed);
    const m: MarketData = {
      id: this.state.markets.length,
      creator,
      reserveYes: s.reserveYes,
      reserveNo: s.reserveNo,
      setsMinted: seed,
      feesAccrued: 0n,
      lpFees: 0n,
      feeBps: this.opts.feeBps,
      protocolShareBps: this.opts.protocolShareBps,
      closeTime,
      status: "Open",
      lpClaimed: false,
      settling: false,
      balance: seed,
      positions: {},
      seed,
      seedCreatorYes: s.creatorYes,
      seedCreatorNo: s.creatorNo,
      flows: { deposited: seed, soldOut: 0n, redeemed: 0n, poolClaim: 0n, lpFeesClaimed: 0n, feesSwept: 0n },
    };
    // The seed's leftover shares belong to the creator, as on-chain.
    if (s.creatorYes > 0n || s.creatorNo > 0n) m.positions[creator] = { yes: s.creatorYes, no: s.creatorNo };
    this.state.markets.push(m);
    this.check(m);
    return m.id;
  }

  private assertTradable(m: MarketData, now: bigint): void {
    if (m.status !== "Open") fail("MarketNotOpen");
    if (now >= m.closeTime) fail("MarketClosed");
  }

  /** `math::split_fee`: protocol share rounded up, the rest to the LP. */
  private accrue(m: MarketData, fee: bigint): void {
    const protocol = math(() => mulDivCeil(fee, m.protocolShareBps, BPS));
    m.feesAccrued += protocol;
    m.lpFees += fee - protocol;
  }

  buy(
    trader: string,
    id: number,
    outcome: Outcome,
    collateralIn: bigint,
    minSharesOut: bigint,
    now: bigint,
    limitPriceBps?: bigint,
  ): bigint {
    if (limitPriceBps !== undefined && limitPriceBps > BPS) fail("InvalidAmount");
    const m = this.market(id);
    this.assertTradable(m, now);
    const yes = outcome === "Yes";
    const q = math(() => calcBuy(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, collateralIn, m.feeBps));
    if (q.sharesOut < minSharesOut) fail("SlippageExceeded");
    if (limitPriceBps !== undefined && limitPriceBps > 0n && !buyWithinLimit(collateralIn, q.sharesOut, limitPriceBps)) {
      fail("LimitPriceExceeded");
    }
    const newSets = m.setsMinted + q.net;
    if (newSets > MAX_SETS) fail("MarketTooLarge");
    this.ledger.transfer(trader, this.account, collateralIn);

    if (yes) [m.reserveYes, m.reserveNo] = [q.newReserveBought, q.newReserveOther];
    else [m.reserveNo, m.reserveYes] = [q.newReserveBought, q.newReserveOther];
    m.setsMinted = newSets;
    this.accrue(m, q.fee);
    const pos = this.position(m, trader);
    if (yes) pos.yes += q.sharesOut;
    else pos.no += q.sharesOut;
    m.balance += collateralIn;
    m.flows.deposited += collateralIn;
    this.check(m);
    return q.sharesOut;
  }

  sell(trader: string, id: number, outcome: Outcome, collateralOut: bigint, maxSharesIn: bigint, now: bigint): bigint {
    const m = this.market(id);
    this.assertTradable(m, now);
    const yes = outcome === "Yes";
    const q = math(() => calcSell(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, collateralOut, m.feeBps));
    if (q.sharesIn > maxSharesIn) fail("SlippageExceeded");
    const pos = this.position(m, trader);
    if ((yes ? pos.yes : pos.no) < q.sharesIn) fail("InsufficientShares");
    this.ledger.transfer(this.account, trader, collateralOut);

    if (yes) pos.yes -= q.sharesIn;
    else pos.no -= q.sharesIn;
    if (yes) [m.reserveYes, m.reserveNo] = [q.newReserveSold, q.newReserveOther];
    else [m.reserveNo, m.reserveYes] = [q.newReserveSold, q.newReserveOther];
    m.setsMinted -= q.gross;
    this.accrue(m, q.fee);
    m.balance -= collateralOut;
    m.flows.soldOut += collateralOut;
    this.check(m);
    return q.sharesIn;
  }

  resolve(id: number, outcome: Outcome, now: bigint): void {
    const m = this.market(id);
    if (m.status !== "Open") fail("MarketNotOpen");
    if (now < m.closeTime) fail("NotClosedYet");
    m.status = outcome === "Yes" ? "ResolvedYes" : "ResolvedNo";
    this.check(m);
  }

  voidMarket(id: number): void {
    const m = this.market(id);
    if (m.status !== "Open") fail("MarketNotOpen");
    m.status = "Void";
    this.check(m);
  }

  redeem(holder: string, id: number): bigint {
    const m = this.market(id);
    const kind = settlementOf(m);
    const pos = m.positions[holder];
    if (!pos || (pos.yes === 0n && pos.no === 0n)) fail("NothingToRedeem");
    const payout = settleValue(kind, pos!.yes, pos!.no);
    m.positions[holder] = { yes: 0n, no: 0n };
    m.settling = true;
    if (payout > 0n) this.ledger.transfer(this.account, holder, payout);
    m.balance -= payout;
    m.flows.redeemed += payout;
    this.check(m);
    return payout;
  }

  claimPoolRemainder(id: number): bigint {
    const m = this.market(id);
    const kind = settlementOf(m);
    if (m.lpClaimed) fail("AlreadyClaimed");
    const pool = settleValue(kind, m.reserveYes, m.reserveNo);
    const payout = pool + m.lpFees;
    if (payout > 0n) this.ledger.transfer(this.account, m.creator, payout);
    m.flows.poolClaim += pool;
    m.flows.lpFeesClaimed += m.lpFees;
    m.lpFees = 0n;
    m.reserveYes = 0n;
    m.reserveNo = 0n;
    m.lpClaimed = true;
    m.settling = true;
    m.balance -= payout;
    this.check(m);
    return payout;
  }

  claimLpFees(id: number): bigint {
    const m = this.market(id);
    const amount = m.lpFees;
    if (amount <= 0n) return 0n;
    m.lpFees = 0n;
    this.ledger.transfer(this.account, m.creator, amount);
    m.balance -= amount;
    m.flows.lpFeesClaimed += amount;
    this.check(m);
    return amount;
  }

  sweepFees(id: number): bigint {
    const m = this.market(id);
    const amount = m.feesAccrued;
    if (amount <= 0n) return 0n;
    m.feesAccrued = 0n;
    this.ledger.transfer(this.account, this.opts.feeRecipient, amount);
    m.balance -= amount;
    m.flows.feesSwept += amount;
    this.check(m);
    return amount;
  }

  private check(m: MarketData): void {
    if (this.opts.checkInvariants !== false) checkInvariants(m);
  }

  /** market-core's token balance must equal the sum of per-market balances. */
  checkLedger(): void {
    const sum = this.state.markets.reduce((a, m) => a + m.balance, 0n);
    if (sum !== this.ledger.balance(this.account)) {
      throw new InvariantError(`market-core holds ${this.ledger.balance(this.account)}, markets account for ${sum}`);
    }
  }
}

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/**
 * docs/architecture.md solvency invariants. Before any settlement payout:
 * `balance == sets_minted + fees_accrued (+ LP fees)` and
 * `reserve_yes + Σ pos.yes == sets_minted` (same for NO). After: the market
 * can still pay every remaining claim at its settlement value.
 */
export function checkInvariants(m: MarketData): void {
  const bad = (msg: string) => {
    throw new InvariantError(`market ${m.id}: ${msg}`);
  };
  if (m.balance < 0n) bad(`negative balance ${m.balance}`);
  let yes = 0n;
  let no = 0n;
  for (const holder of sortedHolders(m)) {
    const p = m.positions[holder]!;
    if (p.yes < 0n || p.no < 0n) bad(`negative position for ${holder}`);
    yes += p.yes;
    no += p.no;
  }
  const settled = m.settling;
  if (!settled) {
    const backing = m.setsMinted + m.feesAccrued + m.lpFees;
    if (m.balance !== backing) bad(`balance ${m.balance} != sets_minted + fees ${backing}`);
    if (m.reserveYes + yes !== m.setsMinted) bad(`reserve_yes + Σyes ${m.reserveYes + yes} != sets_minted ${m.setsMinted}`);
    if (m.reserveNo + no !== m.setsMinted) bad(`reserve_no + Σno ${m.reserveNo + no} != sets_minted ${m.setsMinted}`);
  }
  if (m.status !== "Open") {
    const kind = settlementOf(m);
    let owed = m.feesAccrued + m.lpFees;
    for (const holder of sortedHolders(m)) owed += settleValue(kind, m.positions[holder]!.yes, m.positions[holder]!.no);
    if (!m.lpClaimed) owed += settleValue(kind, m.reserveYes, m.reserveNo);
    if (m.balance < owed) bad(`insolvent: balance ${m.balance} < remaining claims ${owed}`);
  }
}
