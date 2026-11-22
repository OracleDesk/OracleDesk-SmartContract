/**
 * Pre-trade risk checks for cross-market arbitrage (#108). The planner
 * already sizes a plan inside the hard treasury caps; these checks add the
 * arbitrage-specific limits that exist because the two legs are not atomic.
 */
import { BPS } from "./fpmm.js";
import type { ArbPlan } from "./strategies/arbitrage.js";

export interface ArbRiskLimits {
  /** ARB_MAX_NOTIONAL: most one plan may spend across both legs. */
  maxNotional: bigint;
  /** ARB_MAX_UNHEDGED_STROOPS: the first leg alone, if the second never fills. */
  maxUnhedged: bigint;
  /** ARB_MARKET_HEADROOM_BPS: share of each market's max_market kept free for hedges. */
  marketHeadroomBps: bigint;
  /** ARB_MAX_OPEN_LEGS: arbitrage legs in flight at once, across plans. */
  maxOpenLegs: number;
  /** ARB_MAX_UNWIND_RETRIES: attempts to sell a stranded first leg. */
  maxUnwindRetries: number;
}

export interface TreasuryRiskState {
  maxTrade: bigint;
  maxMarket: bigint;
  /** What the treasury has already committed per market (cost basis). */
  marketSpent: Map<bigint, bigint>;
  dailyRemaining: bigint;
  /** Arbitrage legs currently submitted but not settled. */
  openLegs: number;
}

/** Every limit `plan` breaks; empty means it may execute. */
export function checkArbPlan(plan: ArbPlan, state: TreasuryRiskState, limits: ArbRiskLimits): string[] {
  const problems: string[] = [];
  if (limits.maxUnwindRetries < 1) problems.push("ARB_MAX_UNWIND_RETRIES must allow at least one unwind attempt");
  if (limits.marketHeadroomBps < 0n || limits.marketHeadroomBps >= BPS) problems.push("ARB_MARKET_HEADROOM_BPS must be 0-9999");
  // Usable share of max_market once the reserved headroom is set aside.
  const usable = (state.maxMarket * (BPS - limits.marketHeadroomBps)) / BPS;
  for (const leg of plan.legs) {
    if (leg.collateral > state.maxTrade) {
      problems.push(`leg on market ${leg.marketId}: ${leg.collateral} exceeds max_trade ${state.maxTrade}`);
    }
    const spent = state.marketSpent.get(leg.marketId) ?? 0n;
    if (spent + leg.collateral > usable) {
      problems.push(
        `leg on market ${leg.marketId}: exposure ${spent + leg.collateral} would exceed ${usable} (max_market ${state.maxMarket} less ARB_MARKET_HEADROOM_BPS=${limits.marketHeadroomBps})`,
      );
    }
  }
  if (plan.cost > state.dailyRemaining) problems.push(`cost ${plan.cost} exceeds the remaining daily budget ${state.dailyRemaining}`);
  if (plan.cost > limits.maxNotional) problems.push(`cost ${plan.cost} exceeds ARB_MAX_NOTIONAL=${limits.maxNotional}`);
  const firstLeg = plan.legs[0].collateral;
  if (firstLeg > limits.maxUnhedged) {
    problems.push(`first leg ${firstLeg} exceeds ARB_MAX_UNHEDGED_STROOPS=${limits.maxUnhedged}, the exposure left if the second leg fails`);
  }
  if (state.openLegs + plan.legs.length > limits.maxOpenLegs) {
    problems.push(`${state.openLegs} arbitrage legs already open; ${plan.legs.length} more would exceed ARB_MAX_OPEN_LEGS=${limits.maxOpenLegs}`);
  }
  return problems;
}

export const ROLE_CREATE = 1 << 0;
export const ROLE_TRADE = 1 << 1;
const USAGE_BUCKET_SECONDS = 3_600n;
const USAGE_BUCKETS = 25;
const CREATION_BUCKETS = 24;
const BPS_SCALE = 10_000n;

export interface AgentRiskPolicy {
  active: boolean;
  roles: number;
  maxTrade: bigint;
  maxDaily: bigint;
}

/** Ring buffer layout mirrors the treasury's on-chain UsageWindow. */
export interface AgentUsageWindow {
  headHour: bigint;
  headIdx: number;
  amounts: readonly bigint[];
}

export interface CreationRateBucket {
  bucketStart: bigint;
  count: number;
}

export interface AgentRiskState {
  now: bigint;
  global: {
    maxTrade: bigint;
    maxMarket: bigint;
    maxDaily: bigint;
    maxNetExposure: bigint;
  };
  agent: AgentRiskPolicy;
  usage: {
    global: AgentUsageWindow;
    agent: AgentUsageWindow;
  };
  /** Treasury's current token balance before a possible yield withdrawal. */
  idleCapital: bigint;
  queueReservedCapital: bigint;
  /** Current cost-basis exposure across all markets. */
  netExposure: bigint;
  /** Lifetime/cap exposure for the target market. Missing markets use zero. */
  marketExposure: bigint;
  /** In/out counters for the target market used to calculate its net increase. */
  marketNetPosition: { collateralIn: bigint; collateralOut: bigint };
  /** Whether a yield venue is enabled and the amount that can safely be recalled. */
  yieldLiquidity: { enabled: boolean; available: bigint | null };
  price: {
    maxBuyPriceBps: bigint;
    minSellPriceBps: bigint;
    maxImpactBps: bigint;
    maxSlippageBps: bigint;
  };
}

export interface AgentBuyRiskAction {
  kind: "buy";
  amount: bigint;
  priceBeforeBps: bigint;
  priceAfterBps: bigint;
  quotedShares: bigint;
  minSharesOut: bigint;
}

export interface AgentCreateRiskAction {
  kind: "create";
  seedAmount: bigint;
  closeTime: bigint;
  category: "Crypto" | "Macro" | "Geopolitics" | "Sports" | "Culture" | "Other";
  initialYesBps: bigint;
  creationPolicy: {
    maxSeed: bigint;
    maxMarketsPerWindow: number;
    creationWindowSecs: bigint;
    minCloseHorizon: bigint;
    maxCloseHorizon: bigint;
    allowedCategories: number;
  };
  creationBuckets: readonly CreationRateBucket[];
}

export type AgentRiskAction = AgentBuyRiskAction | AgentCreateRiskAction;

export interface AgentRiskEvaluation {
  /** Checks which would reject the invocation, in contract execution order. */
  violations: string[];
  /** Checks dependent on external runtime outcomes or unavailable inputs. */
  unverifiable: string[];
}

const CATEGORY_BITS: Record<AgentCreateRiskAction["category"], number> = {
  Crypto: 1 << 0,
  Macro: 1 << 1,
  Geopolitics: 1 << 2,
  Sports: 1 << 3,
  Culture: 1 << 4,
  Other: 1 << 5,
};

function windowState(window: AgentUsageWindow, now: bigint): { total: bigint; headAmount: bigint } | undefined {
  if (
    window.amounts.length !== USAGE_BUCKETS ||
    !Number.isInteger(window.headIdx) ||
    window.headIdx < 0 ||
    window.headIdx >= USAGE_BUCKETS
  ) return undefined;
  const currentHour = now / USAGE_BUCKET_SECONDS;
  const steps = currentHour > window.headHour
    ? Number((currentHour - window.headHour) > BigInt(USAGE_BUCKETS)
      ? BigInt(USAGE_BUCKETS)
      : currentHour - window.headHour)
    : 0;
  const headIdx = (window.headIdx + steps) % USAGE_BUCKETS;
  let total = 0n;
  for (let slot = 0; slot < USAGE_BUCKETS; slot += 1) {
    const amount = window.amounts[slot];
    if (amount === undefined || amount < 0n) return undefined;
    const age = (window.headIdx - slot + USAGE_BUCKETS) % USAGE_BUCKETS;
    if (age + steps < USAGE_BUCKETS) total += amount;
  }
  return { total, headAmount: window.amounts[headIdx] ?? 0n };
}

function marketNetIncrease(position: AgentRiskState["marketNetPosition"], amount: bigint): bigint {
  const current = position.collateralIn > position.collateralOut
    ? position.collateralIn - position.collateralOut
    : 0n;
  const nextIn = position.collateralIn + amount;
  const next = nextIn > position.collateralOut ? nextIn - position.collateralOut : 0n;
  return next - current;
}

function creationWindowTotal(
  buckets: readonly CreationRateBucket[],
  now: bigint,
  windowSecs: bigint,
): number {
  return buckets.reduce(
    (sum, bucket) => bucket.bucketStart + windowSecs > now ? sum + bucket.count : sum,
    0,
  );
}

/**
 * Mirrors the treasury's create/buy gates. For buys and creates, capacity,
 * daily usage, and net exposure are evaluated after the nested market-core
 * action, matching Soroban's transaction rollback semantics.
 */
export function evaluateAgentRisk(action: AgentRiskAction, state: AgentRiskState): AgentRiskEvaluation {
  const violations: string[] = [];
  const unverifiable: string[] = [];
  const role = action.kind === "buy" ? ROLE_TRADE : ROLE_CREATE;
  const amount = action.kind === "buy" ? action.amount : action.seedAmount;
  if (!state.agent.active || (state.agent.roles & role) === 0) {
    violations.push(`agent is inactive or lacks ${action.kind === "buy" ? "ROLE_TRADE" : "ROLE_CREATE"}`);
    return { violations, unverifiable };
  }

  if (action.kind === "buy") {
    if (amount <= 0n) violations.push("trade amount must be positive");
    else if (amount > state.agent.maxTrade || amount > state.global.maxTrade) {
      violations.push("trade amount exceeds max_trade");
    }
    if (maxBigInt(0n, state.idleCapital - amount) < state.queueReservedCapital) {
      violations.push("spend would use queue-reserved capital");
    }
    if (action.priceBeforeBps > state.price.maxBuyPriceBps) {
      violations.push("buy price is above max_buy_price_bps");
    }
    const slippageFloor = (action.quotedShares * (BPS_SCALE - state.price.maxSlippageBps)) / BPS_SCALE;
    const effectiveMinimum = action.minSharesOut > slippageFloor
      ? action.minSharesOut
      : slippageFloor > 1n ? slippageFloor : 1n;
    if (action.quotedShares < effectiveMinimum) {
      violations.push("quoted shares do not satisfy effective min_shares_out");
    }
    checkLiquidity(amount, state, violations, unverifiable);
    if (absDiff(action.priceAfterBps, action.priceBeforeBps) > state.price.maxImpactBps) {
      violations.push("price impact exceeds max_impact_bps");
    }
  } else {
    const policy = action.creationPolicy;
    if (amount <= 0n) violations.push("seed amount must be positive");
    else if (amount > policy.maxSeed) violations.push("seed amount exceeds max_seed");
    const horizon = action.closeTime - state.now;
    if (horizon < 0n || horizon < policy.minCloseHorizon) violations.push("close time is too soon");
    if (horizon > policy.maxCloseHorizon) violations.push("close time is too far");
    if ((CATEGORY_BITS[action.category] & policy.allowedCategories) === 0) {
      violations.push("market category is not allowed");
    }
    if (action.initialYesBps < state.price.minSellPriceBps || action.initialYesBps > state.price.maxBuyPriceBps) {
      violations.push("initial price is outside the price-policy band");
    }
    if (creationWindowTotal(action.creationBuckets, state.now, policy.creationWindowSecs) >= policy.maxMarketsPerWindow) {
      violations.push("creation rate limit exceeded");
    }
    checkLiquidity(amount, state, violations, unverifiable);
    const effectiveIdle = state.idleCapital < amount && state.yieldLiquidity.enabled && state.yieldLiquidity.available !== null
      ? state.idleCapital + state.yieldLiquidity.available
      : state.idleCapital;
    if (state.idleCapital < amount && state.yieldLiquidity.enabled && state.yieldLiquidity.available === null) {
      unverifiable.push("reserved-capital check after yield recall depends on withdrawal outcome");
    } else if (maxBigInt(0n, effectiveIdle - amount) < state.queueReservedCapital) {
      violations.push("spend would use queue-reserved capital");
    }
  }

  // reserve_capacity runs after market-core succeeds: lifetime market cap,
  // global rolling window, then the acting agent's rolling window.
  const currentMarketExposure = action.kind === "create" ? 0n : state.marketExposure;
  const currentMarketNet = action.kind === "create"
    ? { collateralIn: 0n, collateralOut: 0n }
    : state.marketNetPosition;
  if (currentMarketExposure + amount > state.global.maxMarket) {
    violations.push("market exposure exceeds max_market");
  }
  checkUsageWindow("global", state.usage.global, amount, state.global.maxDaily, state.now, violations, unverifiable);
  checkUsageWindow("agent", state.usage.agent, amount, state.agent.maxDaily, state.now, violations, unverifiable);

  // reserve_net follows reserve_capacity and enforces cost-basis exposure.
  if (state.netExposure + marketNetIncrease(currentMarketNet, amount) > state.global.maxNetExposure) {
    violations.push("net exposure exceeds max_net_exposure");
  }
  return { violations, unverifiable };
}

function checkLiquidity(
  amount: bigint,
  state: AgentRiskState,
  violations: string[],
  unverifiable: string[],
): void {
  if (state.idleCapital >= amount) return;
  if (!state.yieldLiquidity.enabled) {
    violations.push("insufficient liquid capital");
    return;
  }
  if (state.yieldLiquidity.available === null) {
    unverifiable.push("yield withdrawal availability and success depend on Blend state and invocation outcome");
  } else if (state.idleCapital + state.yieldLiquidity.available < amount) {
    violations.push("insufficient liquid capital after yield recall");
  } else {
    unverifiable.push("yield withdrawal execution can fail even when sufficient liquidity is reported");
  }
}

function checkUsageWindow(
  label: string,
  window: AgentUsageWindow,
  amount: bigint,
  cap: bigint,
  now: bigint,
  violations: string[],
  unverifiable: string[],
): void {
  const current = windowState(window, now);
  if (!current) {
    unverifiable.push(`${label} UsageWindow input is malformed`);
    return;
  }
  if (current.total + amount > cap) violations.push(`${label} rolling 24-hour usage exceeds max_daily`);
}

function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}
