/**
 * Behaviour model of the contract calls the agents make (#106). Prices use
 * the production integer FPMM (core/fpmm.ts); the treasury and registry
 * checks mirror the on-chain validations the agents can trip. Error names are
 * the contracts' own `Error` variants, resolved to codes from the WASM spec.
 *
 * `invoke` is pure with respect to `state`: callers simulate on a clone and
 * apply on the real state, which is what lets a test make simulation and
 * application diverge.
 */
import { buyWithinLimit, calcBuy, MathError, seedReserves } from "../../core/fpmm.js";
import type { ContractName } from "./artifacts.js";

export interface ModelMarket {
  id: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  closeTime: bigint;
  open: boolean;
  creator: string;
  questionHash: string;
}

export interface ModelTrace {
  id: bigint;
  agent: string;
  marketId: bigint;
  action: string;
  traceHash: string;
  cid: string;
}

export interface ModelState {
  markets: ModelMarket[];
  /** Agents the treasury lets trade and create markets. */
  treasuryAgents: string[];
  treasuryBalance: bigint;
  maxTrade: bigint;
  positions: Record<string, bigint>;
  /** Agents registered with the reasoning registry. */
  registryAgents: string[];
  traces: ModelTrace[];
}

export interface ModelEvent {
  contract: ContractName;
  topic: string;
  data: Record<string, unknown>;
}

export interface CallContext {
  /** Ledger close time the call executes at, unix seconds. */
  closeTime: bigint;
  treasuryAddress: string;
}

export type CallOutcome =
  | { ok: true; value: unknown; events: ModelEvent[] }
  | { ok: false; error: string };

/** Functions that never write state or need authorization. */
const READS = new Set(["quote_buy", "quote_sell", "market_count", "get_market", "get_config", "trace_count", "get_trace", "state"]);

export function isWrite(fn: string): boolean {
  return !READS.has(fn);
}

export function initialState(opts: { agents: string[]; balance?: bigint; maxTrade?: bigint }): ModelState {
  return {
    markets: [],
    treasuryAgents: [...opts.agents],
    treasuryBalance: opts.balance ?? 10_000_000_000_000n,
    maxTrade: opts.maxTrade ?? 2_000_000_000n,
    positions: {},
    registryAgents: [...opts.agents],
    traces: [],
  };
}

/** Opens a market directly in the model, as a deploy/seed script would. */
export function seedMarket(
  state: ModelState,
  m: { seed: bigint; yesBps: bigint; closeTime: bigint; creator: string; feeBps?: bigint; questionHash?: string },
): ModelMarket {
  const r = seedReserves(m.seed, m.yesBps);
  const market: ModelMarket = {
    id: BigInt(state.markets.length),
    reserveYes: r.reserveYes,
    reserveNo: r.reserveNo,
    feeBps: m.feeBps ?? 100n,
    closeTime: m.closeTime,
    open: true,
    creator: m.creator,
    questionHash: m.questionHash ?? "00".repeat(32),
  };
  state.markets.push(market);
  return market;
}

type Args = Record<string, unknown>;
type Outcome = { tag: "Yes" | "No" };

function market(state: ModelState, id: unknown): ModelMarket | undefined {
  return state.markets.find((m) => m.id === BigInt(id as bigint));
}

function quote(m: ModelMarket, outcome: Outcome, collateralIn: bigint) {
  const yes = outcome.tag === "Yes";
  return calcBuy(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, collateralIn, m.feeBps);
}

export function invoke(state: ModelState, contract: ContractName, fn: string, a: Args, ctx: CallContext): CallOutcome {
  const fail = (error: string): CallOutcome => ({ ok: false, error });
  try {
    switch (`${contract}.${fn}`) {
      case "market_core.market_count":
        return { ok: true, value: BigInt(state.markets.length), events: [] };

      case "market_core.quote_buy": {
        const m = market(state, a.market_id);
        if (!m) return fail("MarketNotFound");
        if (!m.open) return fail("MarketNotOpen");
        if (ctx.closeTime >= m.closeTime) return fail("MarketClosed");
        return { ok: true, value: quote(m, a.outcome as Outcome, a.collateral_in as bigint).sharesOut, events: [] };
      }

      case "treasury.agent_buy":
      case "treasury.agent_buy_v2": {
        const agent = a.agent as string;
        if (!state.treasuryAgents.includes(agent)) return fail("Unauthorized");
        const collateralIn = a.collateral_in as bigint;
        if (collateralIn <= 0n) return fail("InvalidAmount");
        if (collateralIn > state.maxTrade) return fail("TradeCapExceeded");
        if (collateralIn > state.treasuryBalance) return fail("InsufficientBalance");
        const m = market(state, a.market_id);
        if (!m || !m.open || ctx.closeTime >= m.closeTime) return fail("MarketNotOpen");
        if (fn === "agent_buy_v2" && ctx.closeTime > (a.deadline as bigint)) return fail("MarketCoreCallFailed");
        const q = quote(m, a.outcome as Outcome, collateralIn);
        if (q.sharesOut < (a.min_shares_out as bigint)) return fail("SlippageExceeded");
        if (fn === "agent_buy_v2" && !buyWithinLimit(collateralIn, q.sharesOut, BigInt(a.limit_price_bps as number))) {
          return fail("MarketCoreCallFailed");
        }
        const yes = (a.outcome as Outcome).tag === "Yes";
        if (yes) [m.reserveYes, m.reserveNo] = [q.newReserveBought, q.newReserveOther];
        else [m.reserveNo, m.reserveYes] = [q.newReserveBought, q.newReserveOther];
        state.treasuryBalance -= collateralIn;
        const key = `${m.id}:${(a.outcome as Outcome).tag}`;
        state.positions[key] = (state.positions[key] ?? 0n) + q.sharesOut;
        return {
          ok: true,
          value: q.sharesOut,
          events: [{ contract: "treasury", topic: "trade", data: { market_id: m.id, collateral_in: collateralIn, shares_out: q.sharesOut } }],
        };
      }

      case "treasury.agent_create_market": {
        const agent = a.agent as string;
        if (!state.treasuryAgents.includes(agent)) return fail("Unauthorized");
        const seed = a.seed_amount as bigint;
        if (seed <= 0n || seed > state.treasuryBalance) return fail("InsufficientBalance");
        if ((a.close_time as bigint) <= ctx.closeTime) return fail("CloseTimeTooSoon");
        const qh = Buffer.from(a.question_hash as Buffer).toString("hex");
        const m = seedMarket(state, {
          seed,
          yesBps: BigInt(a.initial_yes_bps as number),
          closeTime: a.close_time as bigint,
          creator: ctx.treasuryAddress,
          questionHash: qh,
        });
        state.treasuryBalance -= seed;
        return { ok: true, value: m.id, events: [{ contract: "treasury", topic: "market_created", data: { market_id: m.id } }] };
      }

      case "reasoning_registry.publish_trace": {
        const agent = a.agent as string;
        if (!state.registryAgents.includes(agent)) return fail("AgentNotRegistered");
        if (!(a.action as string)) return fail("EmptyAction");
        if (!(a.ipfs_cid as string)) return fail("EmptyCid");
        const t: ModelTrace = {
          id: BigInt(state.traces.length),
          agent,
          marketId: a.market_id as bigint,
          action: String(a.action),
          traceHash: Buffer.from(a.trace_hash as Buffer).toString("hex"),
          cid: String(a.ipfs_cid),
        };
        state.traces.push(t);
        return { ok: true, value: t.id, events: [{ contract: "reasoning_registry", topic: "trace", data: { id: t.id, market_id: t.marketId } }] };
      }

      default:
        throw new Error(`fake RPC: no model for ${contract}.${fn}`);
    }
  } catch (err) {
    if (err instanceof MathError) return fail("InvalidAmount");
    throw err;
  }
}
