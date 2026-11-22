import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAgentRisk,
  ROLE_CREATE,
  ROLE_TRADE,
  type AgentRiskState,
  type AgentUsageWindow,
} from "./risk.js";

function window(hour = 10n, headIdx = 0): AgentUsageWindow {
  return { headHour: hour, headIdx, amounts: Array<bigint>(25).fill(0n) };
}

function state(overrides: Partial<AgentRiskState> = {}): AgentRiskState {
  return {
    now: 10n * 3_600n,
    global: { maxTrade: 100n, maxMarket: 500n, maxDaily: 1_000n, maxNetExposure: 1_000n },
    agent: { active: true, roles: ROLE_TRADE | ROLE_CREATE, maxTrade: 100n, maxDaily: 800n },
    usage: { global: window(), agent: window() },
    idleCapital: 1_000n,
    queueReservedCapital: 0n,
    netExposure: 0n,
    marketExposure: 0n,
    marketNetPosition: { collateralIn: 0n, collateralOut: 0n },
    yieldLiquidity: { enabled: false, available: null },
    price: {
      maxBuyPriceBps: 9_500n,
      minSellPriceBps: 500n,
      maxImpactBps: 500n,
      maxSlippageBps: 100n,
    },
    ...overrides,
  };
}

function buy(overrides: Partial<Extract<Parameters<typeof evaluateAgentRisk>[0], { kind: "buy" }>> = {}) {
  return {
    kind: "buy" as const,
    amount: 50n,
    priceBeforeBps: 6_000n,
    priceAfterBps: 6_100n,
    quotedShares: 100n,
    minSharesOut: 90n,
    ...overrides,
  };
}

function create(overrides: Partial<Extract<Parameters<typeof evaluateAgentRisk>[0], { kind: "create" }>> = {}) {
  return {
    kind: "create" as const,
    seedAmount: 50n,
    closeTime: 10n * 3_600n + 100n,
    category: "Crypto" as const,
    initialYesBps: 6_000n,
    creationPolicy: {
      maxSeed: 100n,
      maxMarketsPerWindow: 3,
      creationWindowSecs: 24n * 3_600n,
      minCloseHorizon: 60n,
      maxCloseHorizon: 30n * 24n * 3_600n,
      allowedCategories: 0x3f,
    },
    creationBuckets: [],
    ...overrides,
  };
}

test("allows a buy within role, price, capital, usage, market, and net exposure caps", () => {
  assert.deepEqual(evaluateAgentRisk(buy(), state()), { violations: [], unverifiable: [] });
});

test("checks the agent state and each buy constraint in treasury order", () => {
  const s = state({
    agent: { active: true, roles: ROLE_TRADE, maxTrade: 1n, maxDaily: 1n },
    global: { maxTrade: 10n, maxMarket: 20n, maxDaily: 10n, maxNetExposure: 10n },
    idleCapital: 60n,
    queueReservedCapital: 20n,
    price: { maxBuyPriceBps: 5_000n, minSellPriceBps: 500n, maxImpactBps: 10n, maxSlippageBps: 100n },
    marketExposure: 0n,
    netExposure: 0n,
  });
  const result = evaluateAgentRisk(buy({ amount: 50n, priceBeforeBps: 6_000n, priceAfterBps: 6_100n }), s);
  assert.deepEqual(result.violations.slice(0, 4), [
    "trade amount exceeds max_trade",
    "spend would use queue-reserved capital",
    "buy price is above max_buy_price_bps",
    "price impact exceeds max_impact_bps",
  ]);
  assert.ok(result.violations.includes("global rolling 24-hour usage exceeds max_daily"));
  assert.ok(result.violations.includes("agent rolling 24-hour usage exceeds max_daily"));
});

test("rolling usage expires buckets as the contract's 25-hour ring advances", () => {
  const amounts = Array<bigint>(25).fill(0n);
  amounts[0] = 80n;
  const agedWindow = { headHour: 10n, headIdx: 0, amounts };
  const stillRetained = state({
    now: 11n * 3_600n,
    usage: { global: agedWindow, agent: agedWindow },
    global: { maxTrade: 100n, maxMarket: 500n, maxDaily: 50n, maxNetExposure: 1_000n },
    agent: { active: true, roles: ROLE_TRADE, maxTrade: 100n, maxDaily: 50n },
  });
  assert.ok(evaluateAgentRisk(buy({ amount: 10n }), stillRetained).violations.includes("global rolling 24-hour usage exceeds max_daily"));

  const expired = state({
    now: 35n * 3_600n,
    usage: { global: agedWindow, agent: agedWindow },
    global: { maxTrade: 100n, maxMarket: 500n, maxDaily: 50n, maxNetExposure: 1_000n },
    agent: { active: true, roles: ROLE_TRADE, maxTrade: 100n, maxDaily: 50n },
  });
  assert.deepEqual(evaluateAgentRisk(buy({ amount: 10n }), expired).violations, []);
});

test("applies create role, seed, horizon, category, price and rolling creation limits", () => {
  const good = create();
  assert.deepEqual(evaluateAgentRisk(good, state()), { violations: [], unverifiable: [] });

  const policy = { ...good.creationPolicy, maxSeed: 40n, minCloseHorizon: 200n, allowedCategories: 1 << 1 };
  const result = evaluateAgentRisk(create({
    seedAmount: 50n,
    closeTime: state().now + 100n,
    category: "Crypto",
    initialYesBps: 9_600n,
    creationPolicy: policy,
    creationBuckets: [{ bucketStart: state().now - 100n, count: 3 }],
  }), state({ agent: { active: true, roles: ROLE_TRADE, maxTrade: 100n, maxDaily: 800n } }));
  assert.deepEqual(result.violations, [
    "agent is inactive or lacks ROLE_CREATE",
  ]);

  const createResult = evaluateAgentRisk(create({
    seedAmount: 50n,
    closeTime: state().now + 100n,
    category: "Crypto",
    initialYesBps: 9_600n,
    creationPolicy: policy,
    creationBuckets: [{ bucketStart: state().now - 100n, count: 3 }],
  }), state());
  assert.deepEqual(createResult.violations.slice(0, 5), [
    "seed amount exceeds max_seed",
    "close time is too soon",
    "market category is not allowed",
    "initial price is outside the price-policy band",
    "creation rate limit exceeded",
  ]);
});

test("applies post-market-core market cap and net-exposure checks", () => {
  const result = evaluateAgentRisk(buy({ amount: 50n }), state({
    marketExposure: 480n,
    marketNetPosition: { collateralIn: 80n, collateralOut: 30n },
    netExposure: 990n,
    global: { maxTrade: 100n, maxMarket: 500n, maxDaily: 1_000n, maxNetExposure: 1_000n },
  }));
  assert.ok(result.violations.includes("market exposure exceeds max_market"));
  assert.ok(result.violations.includes("net exposure exceeds max_net_exposure"));
});

test("distinguishes unavailable liquid capital from uncertain yield recall", () => {
  const noVenue = evaluateAgentRisk(buy({ amount: 100n }), state({ idleCapital: 20n }));
  assert.ok(noVenue.violations.includes("insufficient liquid capital"));

  const unknownVenue = evaluateAgentRisk(buy({ amount: 100n }), state({
    idleCapital: 20n,
    yieldLiquidity: { enabled: true, available: null },
  }));
  assert.deepEqual(unknownVenue.violations, []);
  assert.ok(unknownVenue.unverifiable.some((item) => item.includes("Blend state")));

  const insufficientVenue = evaluateAgentRisk(buy({ amount: 100n }), state({
    idleCapital: 20n,
    yieldLiquidity: { enabled: true, available: 30n },
  }));
  assert.ok(insufficientVenue.violations.includes("insufficient liquid capital after yield recall"));
});
