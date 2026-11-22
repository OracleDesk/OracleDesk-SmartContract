import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calcBuy, calcSell, seedReserves } from "../fpmm.js";
import { checkArbPlan, type ArbRiskLimits, type TreasuryRiskState } from "../risk.js";
import { LocalTraceStore } from "../trace.js";
import { planArbitrage, type ArbPlan, type MarketSnapshot, type RelationDecl, type Side } from "./arbitrage.js";
import { executeArbPlan, FileArbJournal, MemoryArbJournal, recoverArbitrage, sellableCollateral, type ArbChain, type ExecutorDeps } from "./arb-executor.js";

const NOW = 1_700_000_000;
const relation: RelationDecl = {
  id: "imp",
  type: "implies",
  a: 0,
  b: 1,
  resolution: { a: { mechanism: "price", source: "reflector:XLM" }, b: { mechanism: "price", source: "reflector:XLM" } },
  voidCorrelation: "joint",
  maxCloseSkewSecs: 0,
};

function snapshot(id: bigint, yesBps: bigint, seed: bigint): MarketSnapshot {
  const r = seedReserves(seed, yesBps);
  return { id, reserveYes: r.reserveYes, reserveNo: r.reserveNo, feeBps: 100n, closeTime: BigInt(NOW + 86_400), status: "Open", resolutionHash: "00".repeat(32) };
}

/** A chain whose markets trade with the production FPMM math, plus scripted failures. */
class FakeChain implements ArbChain {
  readonly markets = new Map<bigint, MarketSnapshot>();
  readonly positions = new Map<string, bigint>();
  readonly calls: string[] = [];
  readonly traces: string[] = [];
  failBuy = new Set<bigint>();
  /** Market id whose buy lands on chain but whose response is lost. */
  loseBuyResponse?: bigint;
  failSells = 0;
  /** Called before each buy: lets a test move the market between legs. */
  beforeBuy?: (marketId: bigint) => void;

  constructor(...ms: MarketSnapshot[]) {
    for (const m of ms) this.markets.set(m.id, structuredClone(m));
  }
  private key(id: bigint, side: Side) {
    return `${id}:${side}`;
  }
  async market(id: bigint) {
    return structuredClone(this.markets.get(id)!);
  }
  async position(id: bigint) {
    return { yes: this.positions.get(this.key(id, "Yes")) ?? 0n, no: this.positions.get(this.key(id, "No")) ?? 0n };
  }
  /** Moves YES price by trading the pool directly, as another trader would. */
  push(id: bigint, side: Side, collateral: bigint) {
    const m = this.markets.get(id)!;
    const q = calcBuy(side === "Yes" ? m.reserveYes : m.reserveNo, side === "Yes" ? m.reserveNo : m.reserveYes, collateral, m.feeBps);
    if (side === "Yes") [m.reserveYes, m.reserveNo] = [q.newReserveBought, q.newReserveOther];
    else [m.reserveNo, m.reserveYes] = [q.newReserveBought, q.newReserveOther];
  }
  async buy(a: { marketId: bigint; outcome: Side; collateralIn: bigint; minSharesOut: bigint }) {
    this.calls.push(`buy:${a.marketId}:${a.outcome}`);
    this.beforeBuy?.(a.marketId);
    if (this.failBuy.has(a.marketId)) throw new Error(`buy on ${a.marketId} rejected`);
    const m = this.markets.get(a.marketId)!;
    const yes = a.outcome === "Yes";
    const q = calcBuy(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, a.collateralIn, m.feeBps);
    if (q.sharesOut < a.minSharesOut) throw new Error("SlippageExceeded");
    if (yes) [m.reserveYes, m.reserveNo] = [q.newReserveBought, q.newReserveOther];
    else [m.reserveNo, m.reserveYes] = [q.newReserveBought, q.newReserveOther];
    const k = this.key(a.marketId, a.outcome);
    this.positions.set(k, (this.positions.get(k) ?? 0n) + q.sharesOut);
    if (this.loseBuyResponse === a.marketId) {
      this.loseBuyResponse = undefined;
      throw new Error("connection reset");
    }
    return q.sharesOut;
  }
  async sell(a: { marketId: bigint; outcome: Side; collateralOut: bigint; maxSharesIn: bigint }) {
    this.calls.push(`sell:${a.marketId}:${a.outcome}`);
    if (this.failSells > 0) {
      this.failSells--;
      throw new Error("sell rejected");
    }
    const m = this.markets.get(a.marketId)!;
    const yes = a.outcome === "Yes";
    const q = calcSell(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, a.collateralOut, m.feeBps);
    if (q.sharesIn > a.maxSharesIn) throw new Error("SlippageExceeded");
    if (yes) [m.reserveYes, m.reserveNo] = [q.newReserveSold, q.newReserveOther];
    else [m.reserveNo, m.reserveYes] = [q.newReserveSold, q.newReserveOther];
    const k = this.key(a.marketId, a.outcome);
    this.positions.set(k, (this.positions.get(k) ?? 0n) - q.sharesIn);
    return q.sharesIn;
  }
  async publishTrace(a: { marketId: bigint; traceHash: string }) {
    this.traces.push(a.traceHash);
  }
}

function setup(o: { maxLegLoss?: bigint; journal?: MemoryArbJournal | FileArbJournal } = {}) {
  const a = snapshot(0n, 7000n, 20_000_000_000n);
  const b = snapshot(1n, 4000n, 5_000_000_000n);
  const plan = planArbitrage({
    relation,
    graphHash: "f".repeat(64),
    markets: new Map([[0n, a], [1n, b]]),
    holdings: new Map(),
    caps: { maxTrade: 10n ** 15n, marketHeadroom: new Map([[0n, 10n ** 15n], [1n, 10n ** 15n]]), dailyRemaining: 10n ** 15n, maxNotional: 2_000_000_000n },
    thresholds: { minProfit: 1n, minProfitBps: 0n },
  }).plan!;
  const chain = new FakeChain(a, b);
  const journal = o.journal ?? new MemoryArbJournal();
  const deps: ExecutorDeps = {
    chain,
    journal,
    traceStore: new LocalTraceStore(mkdtempSync(join(tmpdir(), "arb-traces-"))),
    maxLegLoss: o.maxLegLoss ?? 10_000_000n,
    maxUnwindRetries: 2,
    now: () => NOW,
  };
  return { plan, chain, journal, deps };
}

const steps = (j: { entries(): { step: string }[] }) => j.entries().map((e) => e.step);

test("a plan executes the less liquid leg first, then the second, and publishes a trace", async () => {
  const { plan, chain, journal, deps } = setup();
  assert.equal(plan.legs[0].marketId, 1n, "market 1 has the smaller pool");
  const r = await executeArbPlan(plan, deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(chain.calls, ["buy:1:Yes", "buy:0:No"]);
  assert.ok(r.leg1!.shares >= plan.shares && r.leg2!.shares >= plan.shares);
  assert.deepEqual(steps(journal), ["planned", "leg1:intent", "leg1:done", "leg2:intent", "leg2:done", "trace:published", "closed"]);
  assert.equal(chain.traces.length, 1);
});

test("the trace records the relation, graph hash, snapshots, plan and leg results", async () => {
  const { plan, deps } = setup();
  const r = await executeArbPlan(plan, deps);
  const published = deps.journal.entries().find((e) => e.step === "trace:published")!.data!;
  const trace = JSON.parse(readFileSync(String(published.cid).replace("local://", ""), "utf8")) as { inputs: Record<string, unknown> };
  assert.equal(trace.inputs.graphHash, plan.graphHash);
  assert.deepEqual((trace.inputs.relation as { id: string }).id, "imp");
  assert.equal((trace.inputs.snapshots as unknown[]).length, 2);
  assert.equal((trace.inputs.result as { status: string }).status, r.status);
});

test("adverse movement of the second market beyond ARB_MAX_LEG_LOSS unwinds leg one", async () => {
  const { plan, chain, journal, deps } = setup({ maxLegLoss: 1_000n });
  // Someone buys NO on market 0 right after our first leg fills.
  chain.beforeBuy = (id) => {
    if (id === 1n) chain.push(0n, "No", 3_000_000_000n);
  };
  const r = await executeArbPlan(plan, deps);
  assert.equal(r.status, "unwound");
  assert.match(r.reason!, /ARB_MAX_LEG_LOSS/);
  assert.deepEqual(chain.calls, ["buy:1:Yes", "sell:1:Yes"]);
  assert.ok(steps(journal).includes("unwind:done"));
  assert.ok((await chain.position(1n)).yes < r.leg1!.shares, "leg one was sold back");
  assert.equal(chain.traces.length, 1, "an unwound plan still publishes its trace");
});

test("a failed first leg never submits the second", async () => {
  const { plan, chain, deps } = setup();
  chain.failBuy.add(1n);
  const r = await executeArbPlan(plan, deps);
  assert.equal(r.status, "aborted");
  assert.deepEqual(chain.calls, ["buy:1:Yes"]);
  assert.equal(chain.traces.length, 0);
});

test("a first leg whose response is lost is reconciled from the position, not repeated", async () => {
  const { plan, chain, deps } = setup();
  chain.loseBuyResponse = 1n;
  const r = await executeArbPlan(plan, deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(chain.calls, ["buy:1:Yes", "buy:0:No"]);
});

test("a failed second leg unwinds the first, retrying the sell", async () => {
  const { plan, chain, deps } = setup();
  chain.failBuy.add(0n);
  chain.failSells = 1;
  const r = await executeArbPlan(plan, deps);
  assert.equal(r.status, "unwound");
  assert.deepEqual(chain.calls, ["buy:1:Yes", "buy:0:No", "sell:1:Yes", "sell:1:Yes"]);
});

test("unwind retries are bounded; exhausting them reports the leg as unhedged", async () => {
  const { plan, chain, deps } = setup();
  chain.failBuy.add(0n);
  chain.failSells = 10;
  const r = await executeArbPlan(plan, deps);
  assert.equal(r.status, "unwind-failed");
  assert.equal(chain.calls.filter((c) => c.startsWith("sell")).length, 2);
});

test("a crash after leg one is recovered from the journal: leg two completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arb-journal-"));
  const journal = new FileArbJournal(join(dir, "journal.jsonl"));
  const { plan, chain, deps } = setup({ journal });
  // Simulate the process dying right after leg one: run it, drop everything after leg1:done.
  await executeArbPlan(plan, { ...deps, chain: { ...chain, buy: chain.buy.bind(chain), market: chain.market.bind(chain), position: chain.position.bind(chain), sell: chain.sell.bind(chain), publishTrace: chain.publishTrace.bind(chain) } }).catch(() => undefined);
  const full = journal.entries();
  const cut = full.findIndex((e) => e.step === "leg1:done") + 1;
  const crashed = new FileArbJournal(join(dir, "crashed.jsonl"));
  full.slice(0, cut).forEach((e) => crashed.append(e));
  // Undo leg two on the fake chain so the world matches the crashed journal.
  const fresh = setup();
  await fresh.chain.buy({ marketId: 1n, outcome: "Yes", collateralIn: full[1].data!.collateral as bigint, minSharesOut: plan.shares });
  fresh.chain.calls.length = 0;

  const results = await recoverArbitrage({ ...fresh.deps, journal: crashed });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "completed");
  assert.deepEqual(fresh.chain.calls, ["buy:0:No"], "leg one is not bought again");
  assert.equal(crashed.entries().at(-1)!.step, "closed");
  assert.deepEqual(await recoverArbitrage({ ...fresh.deps, journal: crashed }), [], "a closed plan is not recovered twice");
});

test("a crash with leg one in flight is settled from the treasury position", async () => {
  const { plan, chain, deps } = setup();
  const journal = deps.journal as MemoryArbJournal;
  journal.append({ planId: "p", step: "planned", at: NOW, data: { plan } });
  journal.append({ planId: "p", step: "leg1:intent", at: NOW, data: { collateral: plan.legs[0].collateral, positionBefore: 0n } });
  // It never landed: recovery aborts without trading.
  const aborted = await recoverArbitrage(deps);
  assert.equal(aborted[0].status, "aborted");
  assert.deepEqual(chain.calls, []);
});

// ─── risk.ts ─────────────────────────────────────────────────────────────────

const LIMITS: ArbRiskLimits = { maxNotional: 10n ** 12n, maxUnhedged: 10n ** 12n, marketHeadroomBps: 2_000n, maxOpenLegs: 4, maxUnwindRetries: 2 };
function state(over: Partial<TreasuryRiskState> = {}): TreasuryRiskState {
  return { maxTrade: 10n ** 12n, maxMarket: 10n ** 12n, marketSpent: new Map(), dailyRemaining: 10n ** 12n, openLegs: 0, ...over };
}

test("checkArbPlan passes a plan inside every limit", () => {
  assert.deepEqual(checkArbPlan(setup().plan, state(), LIMITS), []);
});

test("checkArbPlan enforces treasury caps, existing exposure and headroom", () => {
  const plan: ArbPlan = setup().plan;
  const leg = plan.legs[0];
  assert.match(checkArbPlan(plan, state({ maxTrade: leg.collateral - 1n }), LIMITS).join(), /max_trade/);
  assert.match(checkArbPlan(plan, state({ dailyRemaining: plan.cost - 1n }), LIMITS).join(), /daily budget/);
  // 80% of max_market usable; existing spend leaves less than the leg.
  const maxMarket = leg.collateral * 2n;
  const spent = new Map([[leg.marketId, (maxMarket * 8n) / 10n - leg.collateral + 1n]]);
  assert.match(checkArbPlan(plan, state({ maxMarket, marketSpent: spent }), LIMITS).join(), /ARB_MARKET_HEADROOM_BPS/);
});

test("checkArbPlan enforces unhedged exposure, notional, open legs and unwind retries", () => {
  const plan = setup().plan;
  assert.match(checkArbPlan(plan, state(), { ...LIMITS, maxUnhedged: plan.legs[0].collateral - 1n }).join(), /ARB_MAX_UNHEDGED_STROOPS/);
  assert.match(checkArbPlan(plan, state(), { ...LIMITS, maxNotional: plan.cost - 1n }).join(), /ARB_MAX_NOTIONAL/);
  assert.match(checkArbPlan(plan, state({ openLegs: 3 }), LIMITS).join(), /ARB_MAX_OPEN_LEGS/);
  assert.match(checkArbPlan(plan, state(), { ...LIMITS, maxUnwindRetries: 0 }).join(), /ARB_MAX_UNWIND_RETRIES/);
});

test("sellableCollateral is the most a sell of at most `shares` can return", () => {
  for (const [rS, rO, shares, fee] of [[5_000n, 9_000n, 700n, 100n], [10n ** 10n, 4n * 10n ** 9n, 123_456_789n, 30n], [800n, 800n, 30n, 0n]]) {
    const c = sellableCollateral(rS, rO, shares, fee);
    assert.ok(calcSell(rS, rO, c, fee).sharesIn <= shares);
    let next: bigint | undefined;
    try {
      next = calcSell(rS, rO, c + 1n, fee).sharesIn;
    } catch {
      next = undefined;
    }
    assert.ok(next === undefined || next > shares, `${c + 1n} would still fit`);
  }
});

test("sellableCollateral refuses a sell too small to return anything", () => {
  // In an 800/800 pool even 1 stroop of collateral costs 3 shares.
  assert.throws(() => sellableCollateral(800n, 800n, 1n, 0n), /nothing sellable/);
});
