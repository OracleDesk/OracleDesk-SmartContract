/**
 * Deterministic discrete-time simulation of OracleDesk markets. Each step:
 * latent probabilities move; every agent observes the open markets and
 * submits orders (mempool watchers act last, seeing the others' orders);
 * orders execute in policy order against the market-core / treasury
 * mirrors, reverts are recorded rather than thrown; markets past close are
 * resolved or voided from their latent process and fully settled. After
 * the last step every remaining market is closed, then per-market and
 * global collateral conservation are asserted.
 */
import { calcSell } from "../core/fpmm.js";
import { InformedTrader } from "./agents/informed.js";
import { NoiseTrader } from "./agents/noise.js";
import { OracleDeskMaker, OracleDeskTrader } from "./agents/oracledesk.js";
import { Sandwicher } from "./agents/sandwicher.js";
import { InvariantError, Ledger, SimContractError, SimMarketCore, sortedHolders, type MarketData, type Outcome } from "./market.js";
import { LatentProcess, type OutcomeConfig, type Resolution } from "./outcomes.js";
import { Rng } from "./rng.js";
import { SimTreasury, type CapStats } from "./treasury.js";
import type { AgentContext, MarketView, Observation, Order, PendingOrder, SimAgent } from "./types.js";

// ─── configuration ──────────────────────────────────────────────────────────

/** Amounts are decimal strings in stroops (JSON has no bigint). */
type Amount = string;

export type AgentConfig =
  | { type: "noise"; id: string; count?: number; balance: Amount; activity: number; minTrade: Amount; maxTrade: Amount; sellProb?: number }
  | { type: "informed"; id: string; count?: number; balance: Amount; activity: number; noiseBps: number; minEdgeBps: number; tradeSize: Amount; slippageBps?: number }
  | { type: "sandwicher"; id: string; count?: number; balance: Amount; minVictim: Amount; frontSize: Amount; aggression?: number }
  | {
      type: "oracledesk-trader";
      id: string;
      count?: number;
      treasury: TreasuryConfig;
      signalGroup?: string;
      signalNoiseBps: number;
      minEdgeBps: number;
      tradeSize: Amount;
      sizing?: "fixed" | "edge";
      edgeScaleBps?: number;
      slippageBps?: number | null;
      maxImpactBps?: number;
    }
  | {
      type: "oracledesk-maker";
      id: string;
      count?: number;
      treasury: TreasuryConfig;
      signalGroup?: string;
      signalNoiseBps: number;
      everySteps: number;
      maxMarkets: number;
      confidenceThresholdBps: number;
      seed: Amount;
      closeInSteps: number;
    };

export interface TreasuryConfig {
  balance: Amount;
  maxTrade: Amount;
  maxMarket: Amount;
  maxDaily: Amount;
  maxSeed?: Amount;
  agentMaxTrade?: Amount;
  agentMaxDaily?: Amount;
}

export interface SimConfig {
  name: string;
  steps: number;
  stepSeconds: number;
  feeBps: number;
  /** Share of each fee kept by the protocol (rest accrues to the LP). */
  protocolShareBps?: number;
  /** Flat cost per submitted order, charged even on revert. */
  txCost?: Amount;
  /** Initial markets seeded at t0 by the `lp` account. */
  markets: { initial: number; seed: Amount; closeInSteps: number; lpPriceNoiseBps?: number };
  outcome: OutcomeConfig;
  /** "shuffle" (default) or "sandwich" (watchers' legs wrap their victim). */
  policy?: "shuffle" | "sandwich";
  agents: AgentConfig[];
}

// ─── results ────────────────────────────────────────────────────────────────

export interface MarketResult {
  id: number;
  creator: string;
  resolution: Resolution;
  /** Last pool price before close (bps) and the latent p at close. */
  finalPriceBps: number;
  finalLatentP: number;
  lpPnl: bigint;
  feesSwept: bigint;
  dust: bigint;
  meanAbsMispricingBps: number;
}

export interface RunResult {
  name: string;
  seed: string;
  config: SimConfig;
  /** Per ledger account: final - initial collateral. */
  pnl: Record<string, bigint>;
  /** Which agent ids report into which account. */
  accounts: Record<string, string[]>;
  markets: MarketResult[];
  caps: Record<string, CapStats>;
  reverts: Record<string, number>;
  fills: number;
  /** Signed amount OracleDesk buys pushed the price past their own fair value (bps). */
  overshootBps: number[];
  txCosts: bigint;
  /** Unfunded sink accounts: swept protocol fees and flat tx costs. */
  sinks: { protocol: bigint; network: bigint };
}

const LP = "lp";
const PROTOCOL = "protocol";
const NETWORK = "network";

const bi = (s: Amount | undefined, fallback = 0n): bigint => (s === undefined ? fallback : BigInt(s));
const clampBps = (x: number) => Math.min(9_900, Math.max(100, Math.round(x)));

/**
 * Execution order of one step's orders: a random shuffle; under the
 * "sandwich" policy each watcher's front leg is placed immediately before
 * its victim (`sandwich.victim` = the victim's `seq`) and the back leg
 * immediately after.
 */
export function executionOrder(pending: PendingOrder[], policy: "shuffle" | "sandwich", rng: Rng): PendingOrder[] {
  const plain = rng.shuffle(pending.filter((o) => !o.sandwich || policy !== "sandwich"));
  if (policy !== "sandwich") return plain;
  const out: PendingOrder[] = [];
  for (const o of plain) {
    const legs = pending.filter((s) => s.sandwich && s.sandwich.victim === o.seq);
    out.push(...legs.filter((s) => s.sandwich!.leg === "front"), o, ...legs.filter((s) => s.sandwich!.leg === "back"));
  }
  return out;
}

export interface RunOptions {
  /** Assert invariants after every mutation (default true). */
  checkInvariants?: boolean;
}

export function runSimulation(config: SimConfig, seed: bigint, opts: RunOptions = {}): RunResult {
  return new World(config, seed, opts).run();
}

class World {
  private readonly ledger = new Ledger();
  private readonly core: SimMarketCore;
  private readonly rng: Rng;
  private readonly agents: SimAgent[] = [];
  private readonly agentRngs = new Map<string, Rng>();
  private readonly treasuries = new Map<string, SimTreasury>();
  private readonly treasuryOf = new Map<string, SimTreasury>();
  private readonly latent: LatentProcess[] = [];
  private readonly initial = new Map<string, bigint>();
  private readonly lastPrice: number[] = [];
  private readonly mispricing: { sum: number; n: number }[] = [];
  private readonly resolutions = new Map<number, { resolution: Resolution; latent: number }>();
  private readonly reverts: Record<string, number> = {};
  private readonly overshoot: number[] = [];
  private fills = 0;
  private txCosts = 0n;
  private t = 0n;
  private readonly stepSeconds: bigint;

  constructor(
    private readonly config: SimConfig,
    private readonly seed: bigint,
    opts: RunOptions,
  ) {
    this.rng = new Rng(seed);
    this.stepSeconds = BigInt(config.stepSeconds);
    this.core = new SimMarketCore(this.ledger, {
      feeBps: BigInt(config.feeBps),
      protocolShareBps: BigInt(config.protocolShareBps ?? 10_000),
      feeRecipient: PROTOCOL,
      checkInvariants: opts.checkInvariants,
    });
    this.buildAgents();
  }

  // ── setup ──

  private fund(account: string, amount: bigint) {
    this.ledger.mint(account, amount);
    this.initial.set(account, (this.initial.get(account) ?? 0n) + amount);
  }

  private context(): AgentContext {
    return {
      signal: (group, marketId, t, noiseBps) => this.signal(group, marketId, t, noiseBps),
      nextMarketSignal: (group, t, noiseBps) => this.signal(group, this.core.markets.length, t, noiseBps),
    };
  }

  private latentFor(id: number): LatentProcess {
    while (this.latent.length <= id) {
      const mid = this.latent.length;
      this.latent.push(new LatentProcess(this.config.outcome, this.rng.fork(`market:${mid}`)));
    }
    return this.latent[id]!;
  }

  private signal(group: string, marketId: number, t: bigint, noiseBps: number): number {
    const noise = this.rng.fork(`signal:${group}:${marketId}:${t}`).normal() * noiseBps;
    return clampBps(this.latentFor(marketId).p * 10_000 + noise);
  }

  private treasury(account: string, cfg: TreasuryConfig, agentId: string): SimTreasury {
    const tr = new SimTreasury(
      account,
      this.ledger,
      this.core,
      { maxTrade: bi(cfg.maxTrade), maxMarket: bi(cfg.maxMarket), maxDaily: bi(cfg.maxDaily), maxSeed: cfg.maxSeed ? bi(cfg.maxSeed) : undefined },
      { [agentId]: { maxTrade: bi(cfg.agentMaxTrade ?? cfg.maxTrade), maxDaily: bi(cfg.agentMaxDaily ?? cfg.maxDaily) } },
    );
    this.treasuries.set(account, tr);
    this.fund(account, bi(cfg.balance));
    return tr;
  }

  private buildAgents() {
    const ctx = this.context();
    for (const a of this.config.agents) {
      const count = a.count ?? 1;
      for (let i = 0; i < count; i++) {
        const id = count > 1 ? `${a.id}-${i + 1}` : a.id;
        let agent: SimAgent;
        switch (a.type) {
          case "noise":
            agent = new NoiseTrader(id, { activity: a.activity, minTrade: bi(a.minTrade), maxTrade: bi(a.maxTrade), sellProb: a.sellProb ?? 0.3 });
            this.fund(id, bi(a.balance));
            break;
          case "informed":
            agent = new InformedTrader(id, ctx, {
              activity: a.activity,
              noiseBps: a.noiseBps,
              minEdgeBps: a.minEdgeBps,
              tradeSize: bi(a.tradeSize),
              slippageBps: a.slippageBps ?? 100,
            });
            this.fund(id, bi(a.balance));
            break;
          case "sandwicher":
            agent = new Sandwicher(id, { minVictim: bi(a.minVictim), frontSize: bi(a.frontSize), aggression: a.aggression ?? 1 });
            this.fund(id, bi(a.balance));
            break;
          case "oracledesk-trader": {
            const tr = this.treasury(`treasury:${id}`, a.treasury, id);
            agent = new OracleDeskTrader(id, tr.account, ctx, {
              signalGroup: a.signalGroup ?? id,
              signalNoiseBps: a.signalNoiseBps,
              minEdgeBps: a.minEdgeBps,
              tradeSize: bi(a.tradeSize),
              sizing: a.sizing ?? "fixed",
              edgeScaleBps: a.edgeScaleBps,
              slippageBps: a.slippageBps === undefined ? 50 : a.slippageBps,
              maxImpactBps: a.maxImpactBps,
            });
            this.treasuryOf.set(id, tr);
            break;
          }
          case "oracledesk-maker": {
            const tr = this.treasury(`treasury:${id}`, a.treasury, id);
            agent = new OracleDeskMaker(id, tr.account, ctx, {
              signalGroup: a.signalGroup ?? id,
              signalNoiseBps: a.signalNoiseBps,
              everySteps: a.everySteps,
              maxMarkets: a.maxMarkets,
              confidenceThresholdBps: a.confidenceThresholdBps,
              seed: bi(a.seed),
              closeIn: BigInt(a.closeInSteps) * this.stepSeconds,
            });
            this.treasuryOf.set(id, tr);
            break;
          }
        }
        if (this.agentRngs.has(id)) throw new Error(`duplicate agent id ${id}`);
        this.agents.push(agent);
        this.agentRngs.set(id, this.rng.fork(`agent:${id}`));
      }
    }
    this.agents.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  private seedInitialMarkets() {
    const m = this.config.markets;
    const seed = bi(m.seed);
    this.fund(LP, seed * BigInt(m.initial));
    const priceRng = this.rng.fork("lp-prices");
    for (let i = 0; i < m.initial; i++) {
      const p = this.latentFor(i).p;
      const yesBps = clampBps(p * 10_000 + priceRng.normal() * (m.lpPriceNoiseBps ?? 0));
      this.core.createMarket(LP, seed, BigInt(yesBps), this.t + BigInt(m.closeInSteps) * this.stepSeconds, this.t);
    }
  }

  // ── stepping ──

  private views(): MarketView[] {
    return this.core.markets
      .filter((m) => m.status === "Open" && this.t < m.closeTime)
      .map((m) => ({
        id: m.id,
        yesBps: this.core.priceYes(m.id),
        reserveYes: m.reserveYes,
        reserveNo: m.reserveNo,
        feeBps: m.feeBps,
        closeTime: m.closeTime,
        creator: m.creator,
      }));
  }

  private observe(agent: SimAgent, markets: MarketView[], mempool: PendingOrder[]): Observation {
    const positions: Record<number, { yes: bigint; no: bigint }> = {};
    for (const m of this.core.markets) {
      const p = m.positions[agent.account];
      if (p && (p.yes > 0n || p.no > 0n)) positions[m.id] = { ...p };
    }
    return {
      t: this.t,
      markets,
      mempool: agent.watchesMempool ? mempool : [],
      balance: this.ledger.balance(agent.account),
      positions,
    };
  }

  private collect(): PendingOrder[] {
    const markets = this.views();
    const pending: PendingOrder[] = [];
    let seq = 0;
    for (const watchers of [false, true]) {
      const snapshot = [...pending];
      for (const agent of this.agents) {
        if (Boolean(agent.watchesMempool) !== watchers) continue;
        for (const order of agent.act(this.observe(agent, markets, snapshot), this.agentRngs.get(agent.id)!)) {
          pending.push({ ...order, agentId: agent.id, seq: seq++ });
        }
      }
    }
    return pending;
  }

  private order(pending: PendingOrder[]): PendingOrder[] {
    return executionOrder(pending, this.config.policy ?? "shuffle", this.rng.fork(`order:${this.t}`));
  }

  private sellCollateralFor(m: MarketData, outcome: Outcome, shares: bigint): bigint {
    // Client-side "sell N shares": the largest collateral_out whose exact
    // calcSell needs at most `shares` (binary search over the real math).
    const yes = outcome === "Yes";
    const [rSold, rOther] = yes ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
    const ok = (out: bigint) => {
      try {
        return calcSell(rSold, rOther, out, m.feeBps).sharesIn <= shares;
      } catch {
        return false;
      }
    };
    let lo = 0n;
    let hi = rOther;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (ok(mid)) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  }

  private execute(o: PendingOrder) {
    const agent = this.agents.find((a) => a.id === o.agentId)!;
    const tr = this.treasuryOf.get(o.agentId);
    const txCost = bi(this.config.txCost);
    try {
      if (txCost > 0n) {
        this.ledger.transfer(agent.account, NETWORK, txCost);
        this.txCosts += txCost;
      }
      switch (o.kind) {
        case "buy":
          if (tr) tr.agentBuy(o.agentId, o.marketId, o.outcome, o.collateralIn, o.minSharesOut, this.t);
          else this.core.buy(agent.account, o.marketId, o.outcome, o.collateralIn, o.minSharesOut, this.t);
          break;
        case "sell":
          if (tr) tr.agentSell(o.agentId, o.marketId, o.outcome, o.collateralOut, o.maxSharesIn, this.t);
          else this.core.sell(agent.account, o.marketId, o.outcome, o.collateralOut, o.maxSharesIn, this.t);
          break;
        case "sellShares": {
          const m = this.core.market(o.marketId);
          const held = m.positions[agent.account]?.[o.outcome === "Yes" ? "yes" : "no"] ?? 0n;
          const shares = o.shares === "all" ? held : o.shares;
          if (shares <= 0n) throw new SimContractError("InsufficientShares");
          const out = this.sellCollateralFor(m, o.outcome, shares);
          if (out <= 0n) throw new SimContractError("InvalidAmount");
          if (tr) tr.agentSell(o.agentId, o.marketId, o.outcome, out, shares, this.t);
          else this.core.sell(agent.account, o.marketId, o.outcome, out, shares, this.t);
          break;
        }
        case "create": {
          const close = this.t + o.closeIn;
          const id = tr
            ? tr.agentCreateMarket(o.agentId, o.seed, o.yesBps, close, this.t)
            : this.core.createMarket(agent.account, o.seed, o.yesBps, close, this.t);
          this.latentFor(id);
          break;
        }
      }
      this.fills++;
      if (o.kind === "buy" && o.meta?.fairValueBps !== undefined) {
        const post = Number(this.core.priceYes(o.marketId));
        this.overshoot.push((o.meta.side ?? 1) * (post - o.meta.fairValueBps));
      }
    } catch (err) {
      if (!(err instanceof SimContractError)) throw err;
      const key = `${o.kind}:${err.code}`;
      this.reverts[key] = (this.reverts[key] ?? 0) + 1;
    }
  }

  private recordPrices() {
    for (const m of this.core.markets) {
      if (m.status !== "Open" || this.t >= m.closeTime) continue;
      const price = Number(this.core.priceYes(m.id));
      this.lastPrice[m.id] = price;
      const acc = (this.mispricing[m.id] ??= { sum: 0, n: 0 });
      acc.sum += Math.abs(price - this.latentFor(m.id).p * 10_000);
      acc.n++;
    }
  }

  /** Resolves or voids every open market past close, then settles it fully. */
  private closeDue() {
    for (const m of this.core.markets) {
      if (m.status !== "Open" || this.t < m.closeTime) continue;
      const process = this.latentFor(m.id);
      const resolution = process.resolve();
      this.resolutions.set(m.id, { resolution, latent: process.p });
      if (resolution === "void") this.core.voidMarket(m.id);
      else this.core.resolve(m.id, resolution === "yes" ? "Yes" : "No", this.t);
      for (const holder of sortedHolders(m)) {
        const p = this.core.market(m.id).positions[holder]!;
        if (p.yes > 0n || p.no > 0n) this.core.redeem(holder, m.id);
      }
      this.core.claimPoolRemainder(m.id);
      this.core.sweepFees(m.id);
    }
  }

  run(): RunResult {
    this.seedInitialMarkets();
    for (let step = 0; step < this.config.steps; step++) {
      this.t += this.stepSeconds;
      for (const m of this.core.markets) if (m.status === "Open" && this.t < m.closeTime) this.latentFor(m.id).step();
      for (const o of this.order(this.collect())) this.execute(o);
      this.core.checkLedger();
      this.recordPrices();
      this.closeDue();
    }
    // Fast-forward past every remaining close and settle.
    for (const m of this.core.markets) if (m.closeTime > this.t) this.t = m.closeTime;
    this.closeDue();
    this.assertConservation();
    return this.result();
  }

  private assertConservation() {
    this.core.checkLedger();
    let funded = 0n;
    for (const v of this.initial.values()) funded += v;
    if (this.ledger.total() !== funded) throw new InvariantError(`ledger total ${this.ledger.total()} != funded ${funded}`);
    for (const m of this.core.markets) {
      if (m.status === "Open" || !m.lpClaimed) throw new InvariantError(`market ${m.id} not settled at end of run`);
      const f = m.flows;
      const out = f.soldOut + f.redeemed + f.poolClaim + f.lpFeesClaimed + f.feesSwept;
      // deposits == payouts + fees + dust (+ remaining, which is the dust once settled)
      if (f.deposited !== out + m.balance) {
        throw new InvariantError(`market ${m.id}: deposited ${f.deposited} != paid ${out} + remaining ${m.balance}`);
      }
      if (m.balance < 0n) throw new InvariantError(`market ${m.id}: paid out more than deposited`);
    }
  }

  private result(): RunResult {
    const pnl: Record<string, bigint> = {};
    for (const account of [...this.initial.keys()].sort()) pnl[account] = this.ledger.balance(account) - this.initial.get(account)!;
    const accounts: Record<string, string[]> = { [LP]: ["lp"] };
    for (const a of this.agents) (accounts[a.account] ??= []).push(a.id);
    const caps: Record<string, CapStats> = {};
    for (const [account, tr] of [...this.treasuries.entries()].sort()) caps[account] = structuredClone(tr.stats);
    const markets: MarketResult[] = this.core.markets.map((m) => {
      const r = this.resolutions.get(m.id)!;
      const kind = r.resolution;
      // LP view: pool remainder + LP fees + the seed's leftover shares at settlement - seed.
      const seedShares = kind === "yes" ? m.seedCreatorYes : kind === "no" ? m.seedCreatorNo : (m.seedCreatorYes + m.seedCreatorNo) / 2n;
      const mis = this.mispricing[m.id];
      return {
        id: m.id,
        creator: m.creator,
        resolution: kind,
        finalPriceBps: this.lastPrice[m.id] ?? 0,
        finalLatentP: r.latent,
        lpPnl: m.flows.poolClaim + m.flows.lpFeesClaimed + seedShares - m.seed,
        feesSwept: m.flows.feesSwept,
        dust: m.balance,
        meanAbsMispricingBps: mis && mis.n ? mis.sum / mis.n : 0,
      };
    });
    return {
      name: this.config.name,
      seed: this.seed.toString(),
      config: this.config,
      pnl,
      accounts,
      markets,
      caps,
      reverts: Object.fromEntries(Object.entries(this.reverts).sort()),
      fills: this.fills,
      overshootBps: this.overshoot,
      txCosts: this.txCosts,
      sinks: { protocol: this.ledger.balance(PROTOCOL), network: this.ledger.balance(NETWORK) },
    };
  }
}
