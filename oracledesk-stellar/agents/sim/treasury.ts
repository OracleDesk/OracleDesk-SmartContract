/**
 * Off-chain mirror of contracts/treasury's cap semantics, one instance per
 * OracleDesk deployment (each with its own ledger account).
 *
 * Mirrored exactly: `check_trade_size` (per-agent and global `max_trade`,
 * `TradeCapExceeded`) before the market-core call; then `reserve_capacity`
 * after it — lifetime per-market `max_market` (`MarketCapExceeded`), the
 * global and per-agent sliding daily windows (25 hourly buckets advanced by
 * *sim* time: `DailyCapExceeded`, `AgentDailyCapExceeded`) — with the whole
 * invocation, market mutation included, reverted when a cap fails, as
 * Soroban atomicity does. `agent_sell` is uncapped. The creation seed cap
 * (`max_seed`) is checked up front.
 *
 * Not mirrored (see docs/simulation.md): the price band / slippage-floor /
 * impact checks of `do_agent_buy`, `max_net_exposure`, liquidity reserves
 * and the remaining creation policy (horizons, categories, rate limits).
 * TODO: dedupe with the shared treasury risk mirror once that issue lands.
 */
import { atomicallyOnMarket, SimContractError, type Ledger, type Outcome, type SimMarketCore, type Stateful } from "./market.js";

/** Width of one bucket of the sliding daily window (treasury `BUCKET_SECONDS`). */
export const BUCKET_SECONDS = 3_600n;
/** The trade's own hour plus the 24 before it (treasury `BUCKETS`). */
export const BUCKETS = 25;

export interface UsageWindow {
  headHour: bigint;
  amounts: bigint[];
  headIdx: number;
}

export function newWindow(): UsageWindow {
  return { headHour: 0n, amounts: Array.from({ length: BUCKETS }, () => 0n), headIdx: 0 };
}

/** treasury `advance`. */
export function advanceWindow(w: UsageWindow, nowHour: bigint): void {
  if (nowHour <= w.headHour) return;
  const diff = nowHour - w.headHour;
  const steps = Number(diff < BigInt(BUCKETS) ? diff : BigInt(BUCKETS));
  for (let i = 0; i < steps; i++) {
    w.headIdx = (w.headIdx + 1) % BUCKETS;
    w.amounts[w.headIdx] = 0n;
  }
  w.headHour = nowHour;
}

export function windowSum(w: UsageWindow): bigint {
  return w.amounts.reduce((a, b) => a + b, 0n);
}

/** treasury `consume_window`: returns the new total or throws `code`. */
export function consumeWindow(w: UsageWindow, now: bigint, amount: bigint, maxDaily: bigint, code: string): bigint {
  advanceWindow(w, now / BUCKET_SECONDS);
  const total = windowSum(w) + amount;
  if (total > maxDaily) throw new SimContractError(code);
  w.amounts[w.headIdx] = w.amounts[w.headIdx]! + amount;
  return total;
}

export interface GlobalCaps {
  maxTrade: bigint;
  maxMarket: bigint;
  maxDaily: bigint;
  /** Creation policy `max_seed` (default: unlimited). */
  maxSeed?: bigint;
}

export interface AgentCaps {
  maxTrade: bigint;
  maxDaily: bigint;
}

export const CAP_ERRORS = [
  "TradeCapExceeded",
  "MarketCapExceeded",
  "DailyCapExceeded",
  "AgentDailyCapExceeded",
  "SeedCapExceeded",
] as const;

export interface TreasuryState {
  exposure: Record<number, { amount: bigint; open: boolean }>;
  window: UsageWindow;
  agentWindows: Record<string, UsageWindow>;
}

/** Bookkeeping kept outside `state`, so a reverted call still counts. */
export interface CapStats {
  attempts: number;
  bindings: Record<string, number>;
  /** Highest global window sum / max_daily reached (0..1). */
  peakDailyUtil: number;
  /** Highest market exposure / max_market reached (0..1). */
  peakMarketUtil: number;
}

export class SimTreasury implements Stateful {
  state: TreasuryState = { exposure: {}, window: newWindow(), agentWindows: {} };
  readonly stats: CapStats = { attempts: 0, bindings: {}, peakDailyUtil: 0, peakMarketUtil: 0 };

  constructor(
    /** Ledger account this treasury trades and holds positions as. */
    readonly account: string,
    private readonly ledger: Ledger,
    private readonly core: SimMarketCore,
    private readonly caps: GlobalCaps,
    private readonly agents: Record<string, AgentCaps>,
  ) {}

  private policy(agent: string): AgentCaps {
    return this.agents[agent] ?? { maxTrade: this.caps.maxTrade, maxDaily: this.caps.maxDaily };
  }

  /** One invocation: atomic over ledger, market-core and this treasury. */
  private invoke<T>(marketId: number | undefined, fn: () => T): T {
    this.stats.attempts++;
    try {
      return atomicallyOnMarket(this.core, [this.ledger, this], marketId, fn);
    } catch (err) {
      if (err instanceof SimContractError && (CAP_ERRORS as readonly string[]).includes(err.code)) {
        this.stats.bindings[err.code] = (this.stats.bindings[err.code] ?? 0) + 1;
      }
      throw err;
    }
  }

  private checkTradeSize(agent: string, amount: bigint): void {
    if (amount <= 0n) throw new SimContractError("InvalidAmount");
    if (amount > this.policy(agent).maxTrade || amount > this.caps.maxTrade) {
      throw new SimContractError("TradeCapExceeded");
    }
  }

  /** treasury `reserve_capacity`, called after the market-core call. */
  private reserveCapacity(agent: string, marketId: number, amount: bigint, now: bigint): void {
    const exposure = this.state.exposure[marketId] ?? { amount: 0n, open: false };
    const newMarket = exposure.amount + amount;
    if (newMarket > this.caps.maxMarket) throw new SimContractError("MarketCapExceeded");
    const daily = consumeWindow(this.state.window, now, amount, this.caps.maxDaily, "DailyCapExceeded");
    const agentWindow = (this.state.agentWindows[agent] ??= newWindow());
    consumeWindow(agentWindow, now, amount, this.policy(agent).maxDaily, "AgentDailyCapExceeded");
    this.state.exposure[marketId] = { amount: newMarket, open: true };
    this.stats.peakDailyUtil = Math.max(this.stats.peakDailyUtil, ratio(daily, this.caps.maxDaily));
    this.stats.peakMarketUtil = Math.max(this.stats.peakMarketUtil, ratio(newMarket, this.caps.maxMarket));
  }

  agentCreateMarket(agent: string, seed: bigint, initialYesBps: bigint, closeTime: bigint, now: bigint): number {
    return this.invoke(undefined, () => {
      if (seed <= 0n) throw new SimContractError("InvalidAmount");
      if (this.caps.maxSeed !== undefined && seed > this.caps.maxSeed) throw new SimContractError("SeedCapExceeded");
      const id = this.core.createMarket(this.account, seed, initialYesBps, closeTime, now);
      this.reserveCapacity(agent, id, seed, now);
      return id;
    });
  }

  agentBuy(agent: string, marketId: number, outcome: Outcome, collateralIn: bigint, minSharesOut: bigint, now: bigint): bigint {
    return this.invoke(marketId, () => {
      this.checkTradeSize(agent, collateralIn);
      const shares = this.core.buy(this.account, marketId, outcome, collateralIn, minSharesOut, now);
      this.reserveCapacity(agent, marketId, collateralIn, now);
      return shares;
    });
  }

  /** Uncapped: selling returns capital to the treasury. */
  agentSell(agent: string, marketId: number, outcome: Outcome, collateralOut: bigint, maxSharesIn: bigint, now: bigint): bigint {
    void agent;
    return this.invoke(marketId, () => this.core.sell(this.account, marketId, outcome, collateralOut, maxSharesIn, now));
  }

  /** Current global window sum at `now` (read-only). */
  dailyUsage(now: bigint): bigint {
    const w = structuredClone(this.state.window);
    advanceWindow(w, now / BUCKET_SECONDS);
    return windowSum(w);
  }

  marketExposure(marketId: number): bigint {
    return this.state.exposure[marketId]?.amount ?? 0n;
  }
}

function ratio(a: bigint, b: bigint): number {
  return b > 0n ? Number((a * 1_000_000n) / b) / 1_000_000 : 0;
}
