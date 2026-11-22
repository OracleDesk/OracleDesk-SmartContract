/**
 * Cross-market arbitrage (#108): related markets whose independent FPMM
 * pools price them inconsistently.
 *
 * Relations (P = probability of YES):
 *   implies(A, B):    P(A) <= P(B)   (A cannot happen without B)
 *   complement(A, B): P(A) + P(B) = 1 (exactly one happens)
 *   exclusive(A, B):  P(A) + P(B) <= 1 (at most one happens)
 *
 * The planner never trusts prices alone: for every pair of legs it builds the
 * payoff table over every outcome the relation allows, plus void scenarios
 * (a voided market pays (yes + no) / 2 per share, see fpmm.settleValue), and
 * takes the worst case as the guaranteed payout. Costs are exact integer
 * FPMM collateral (fees, price impact and rounding included) from
 * collateralForShares. Existing treasury holdings are part of the position
 * whose worst case is measured, so the plan's value is what it adds.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { BPS, calcBuy, collateralForShares, MathError, priceYesBps, settleValue, type Settlement } from "../fpmm.js";

export type Side = "Yes" | "No";
export type RelationType = "implies" | "complement" | "exclusive";
type Outcome = "yes" | "no" | "void";

const resolutionDecl = z.object({
  /** How the market resolves, e.g. "price", "signers", "committee". */
  mechanism: z.string().min(1),
  /** What it resolves against, e.g. "reflector:XLM/USD" or a signer set id. */
  source: z.string().min(1),
  /** Optional hex commitment; when given it must equal the market's on-chain resolution_hash. */
  resolutionHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const relationDecl = z.object({
  id: z.string().min(1),
  type: z.enum(["implies", "complement", "exclusive"]),
  a: z.number().int().nonnegative(),
  b: z.number().int().nonnegative(),
  /** Required: a relation between markets with no declared resolution compatibility is rejected. */
  resolution: z.object({ a: resolutionDecl, b: resolutionDecl }),
  /** "joint": the two markets void together or not at all; "independent": either may void alone. */
  voidCorrelation: z.enum(["joint", "independent"]),
  /** Largest allowed difference between the two close times (default 0: equal). */
  maxCloseSkewSecs: z.number().int().nonnegative().default(0),
});

export const RelationsFileSchema = z.object({ relations: z.array(relationDecl).min(1) });
export type RelationDecl = z.output<typeof relationDecl>;

export interface RelationGraph {
  relations: RelationDecl[];
  /** sha256 of the canonical relations JSON; recorded in every trace. */
  hash: string;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Parses an ARB_RELATIONS_FILE document. Throws with every problem listed. */
export function parseRelations(text: string): RelationGraph {
  const parsed = RelationsFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`invalid relations file:\n  - ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  - ")}`);
  }
  const relations = parsed.data.relations;
  const ids = new Set<string>();
  for (const r of relations) {
    if (ids.has(r.id)) throw new Error(`invalid relations file: duplicate relation id ${r.id}`);
    ids.add(r.id);
    if (r.a === r.b) throw new Error(`invalid relations file: relation ${r.id} relates market ${r.a} to itself`);
  }
  return { relations, hash: createHash("sha256").update(canonical(relations)).digest("hex") };
}

export interface MarketSnapshot {
  id: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  closeTime: bigint;
  status: "Open" | "Resolved" | "Void";
  /** Hex of the market's on-chain resolution_hash. */
  resolutionHash: string;
}

export interface Holding {
  yes: bigint;
  no: bigint;
}

/** Every reason `relation` cannot be traded right now; empty when it can. */
export function validateRelation(rel: RelationDecl, markets: Map<bigint, MarketSnapshot>, nowSecs: number): string[] {
  const problems: string[] = [];
  const a = markets.get(BigInt(rel.a));
  const b = markets.get(BigInt(rel.b));
  for (const [label, id, m] of [["a", rel.a, a], ["b", rel.b, b]] as const) {
    if (!m) problems.push(`${rel.id}: market ${label}=${id} does not exist`);
    else if (m.status !== "Open" || m.closeTime <= BigInt(nowSecs)) problems.push(`${rel.id}: market ${label}=${id} is not open`);
  }
  if (a && b) {
    const skew = a.closeTime > b.closeTime ? a.closeTime - b.closeTime : b.closeTime - a.closeTime;
    if (skew > BigInt(rel.maxCloseSkewSecs)) {
      problems.push(`${rel.id}: close times differ by ${skew}s, more than maxCloseSkewSecs=${rel.maxCloseSkewSecs}`);
    }
    const ra = rel.resolution.a;
    const rb = rel.resolution.b;
    if (ra.mechanism !== rb.mechanism || ra.source !== rb.source) {
      problems.push(`${rel.id}: unrelated resolution mechanisms (${ra.mechanism}:${ra.source} vs ${rb.mechanism}:${rb.source})`);
    }
    for (const [label, decl, m] of [["a", ra, a], ["b", rb, b]] as const) {
      if (decl.resolutionHash && decl.resolutionHash !== m.resolutionHash) {
        problems.push(`${rel.id}: market ${label} resolution_hash ${m.resolutionHash} does not match the declared ${decl.resolutionHash}`);
      }
    }
  }
  return problems;
}

/** The (A, B) outcomes the relation allows, including void scenarios. */
export function scenarios(type: RelationType, voidCorrelation: "joint" | "independent"): [Outcome, Outcome][] {
  const normal: [Outcome, Outcome][] = (
    [
      ["yes", "yes"],
      ["yes", "no"],
      ["no", "yes"],
      ["no", "no"],
    ] as [Outcome, Outcome][]
  ).filter(([a, b]) => {
    if (type === "implies") return !(a === "yes" && b === "no");
    if (type === "complement") return a !== b;
    return !(a === "yes" && b === "yes");
  });
  const voids: [Outcome, Outcome][] =
    voidCorrelation === "joint"
      ? [["void", "void"]]
      : [
          ["void", "void"],
          ["void", "yes"],
          ["void", "no"],
          ["yes", "void"],
          ["no", "void"],
        ];
  return [...normal, ...voids];
}

/** Worst-case payout of holding `a` and `b` across `table`. */
export function guaranteedPayout(table: [Outcome, Outcome][], a: Holding, b: Holding): bigint {
  let min: bigint | undefined;
  for (const [oa, ob] of table) {
    const v = settleValue(oa as Settlement, a.yes, a.no) + settleValue(ob as Settlement, b.yes, b.no);
    if (min === undefined || v < min) min = v;
  }
  return min ?? 0n;
}

export interface ArbCaps {
  /** Treasury per-trade cap (stroops). */
  maxTrade: bigint;
  /** Remaining max_market headroom per market (stroops). */
  marketHeadroom: Map<bigint, bigint>;
  /** Remaining rolling max_daily (stroops). */
  dailyRemaining: bigint;
  /** ARB_MAX_NOTIONAL: most a plan may spend across both legs. */
  maxNotional: bigint;
}

export interface ArbThresholds {
  /** ARB_MIN_PROFIT_STROOPS */
  minProfit: bigint;
  /** ARB_MIN_PROFIT_BPS: profit as a share of cost. */
  minProfitBps: bigint;
}

export interface ArbLeg {
  marketId: bigint;
  outcome: Side;
  /** min_shares_out for the buy: the plan's share count. */
  shares: bigint;
  collateral: bigint;
  /** What calcBuy returns for `collateral` (at least `shares`). */
  expectedShares: bigint;
}

export interface ArbPlan {
  relationId: string;
  relationType: RelationType;
  graphHash: string;
  /** In execution order: the less liquid market first. */
  legs: [ArbLeg, ArbLeg];
  shares: bigint;
  cost: bigint;
  /** Increase in worst-case payout the legs add to existing holdings. */
  payoutGain: bigint;
  profit: bigint;
  profitBps: bigint;
  snapshots: MarketSnapshot[];
}

export type PlanResult = { plan: ArbPlan } | { plan: undefined; reason: string };

interface Candidate {
  a: Side;
  b: Side;
}
const CANDIDATES: Candidate[] = [
  { a: "Yes", b: "Yes" },
  { a: "Yes", b: "No" },
  { a: "No", b: "Yes" },
  { a: "No", b: "No" },
];

/** The exact cost of `shares` of `side` in `m`, or undefined if unbuyable. */
function buyCost(m: MarketSnapshot, side: Side, shares: bigint): { collateral: bigint; shares: bigint } | undefined {
  const [rB, rO] = side === "Yes" ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
  try {
    const collateral = collateralForShares(rB, rO, shares, m.feeBps);
    return { collateral, shares: calcBuy(rB, rO, collateral, m.feeBps).sharesOut };
  } catch (err) {
    if (err instanceof MathError) return undefined;
    throw err;
  }
}

const add = (h: Holding, side: Side, n: bigint): Holding => (side === "Yes" ? { yes: h.yes + n, no: h.no } : { yes: h.yes, no: h.no + n });

/** The verification scan around the search result, in shares. */
export const VERIFY_RADIUS = 64n;

export function planArbitrage(input: {
  relation: RelationDecl;
  graphHash: string;
  markets: Map<bigint, MarketSnapshot>;
  holdings: Map<bigint, Holding>;
  caps: ArbCaps;
  thresholds: ArbThresholds;
}): PlanResult {
  const { relation: rel } = input;
  const ma = input.markets.get(BigInt(rel.a));
  const mb = input.markets.get(BigInt(rel.b));
  if (!ma || !mb) return { plan: undefined, reason: "market missing" };
  const ha = input.holdings.get(ma.id) ?? { yes: 0n, no: 0n };
  const hb = input.holdings.get(mb.id) ?? { yes: 0n, no: 0n };
  const table = scenarios(rel.type, rel.voidCorrelation);
  const base = guaranteedPayout(table, ha, hb);
  const headroom = (id: bigint) => input.caps.marketHeadroom.get(id) ?? 0n;

  let best: { profit: bigint; s: bigint; c: Candidate; la: { collateral: bigint; shares: bigint }; lb: { collateral: bigint; shares: bigint } } | undefined;

  for (const c of CANDIDATES) {
    const evaluate = (s: bigint) => {
      const la = buyCost(ma, c.a, s);
      const lb = buyCost(mb, c.b, s);
      if (!la || !lb) return undefined;
      const cost = la.collateral + lb.collateral;
      const feasible =
        la.collateral <= input.caps.maxTrade &&
        lb.collateral <= input.caps.maxTrade &&
        la.collateral <= headroom(ma.id) &&
        lb.collateral <= headroom(mb.id) &&
        cost <= input.caps.dailyRemaining &&
        cost <= input.caps.maxNotional;
      const gain = guaranteedPayout(table, add(ha, c.a, la.shares), add(hb, c.b, lb.shares)) - base;
      return { feasible, profit: gain - cost, la, lb };
    };
    const first = evaluate(1n);
    if (!first?.feasible) continue;
    // Largest feasible share count: feasibility only gets harder as s grows.
    let lo = 1n;
    let hi = 2n;
    while (evaluate(hi)?.feasible && hi < 1n << 62n) [lo, hi] = [hi, hi * 2n];
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (evaluate(mid)?.feasible) lo = mid;
      else hi = mid;
    }
    const sMax = lo;
    const profitAt = (s: bigint) => {
      const e = evaluate(s);
      return e?.feasible ? e.profit : undefined;
    };
    // Integer ternary search for the peak of a (near-)concave profit curve.
    let l = 1n;
    let r = sMax;
    while (r - l > 2n) {
      const m1 = l + (r - l) / 3n;
      const m2 = r - (r - l) / 3n;
      if ((profitAt(m1) ?? -(1n << 120n)) < (profitAt(m2) ?? -(1n << 120n))) l = m1 + 1n;
      else r = m2 - 1n;
    }
    // Rounding makes the curve slightly jagged: scan around the result.
    const center = (l + r) / 2n;
    const from = center > VERIFY_RADIUS ? center - VERIFY_RADIUS : 1n;
    const to = center + VERIFY_RADIUS < sMax ? center + VERIFY_RADIUS : sMax;
    for (let s = from; s <= to; s++) {
      const e = evaluate(s);
      if (!e?.feasible) continue;
      if (!best || e.profit > best.profit || (e.profit === best.profit && s < best.s)) best = { profit: e.profit, s, c, la: e.la, lb: e.lb };
    }
  }

  if (!best || best.profit <= 0n) return { plan: undefined, reason: "no profitable combination: prices are coherent after costs" };
  const cost = best.la.collateral + best.lb.collateral;
  const profitBps = (best.profit * BPS) / cost;
  if (best.profit < input.thresholds.minProfit) {
    return { plan: undefined, reason: `profit ${best.profit} below ARB_MIN_PROFIT_STROOPS=${input.thresholds.minProfit}` };
  }
  if (profitBps < input.thresholds.minProfitBps) {
    return { plan: undefined, reason: `profit ${profitBps} bps below ARB_MIN_PROFIT_BPS=${input.thresholds.minProfitBps}` };
  }
  const legA: ArbLeg = { marketId: ma.id, outcome: best.c.a, shares: best.s, collateral: best.la.collateral, expectedShares: best.la.shares };
  const legB: ArbLeg = { marketId: mb.id, outcome: best.c.b, shares: best.s, collateral: best.lb.collateral, expectedShares: best.lb.shares };
  const liquidity = (m: MarketSnapshot) => m.reserveYes + m.reserveNo;
  const legs: [ArbLeg, ArbLeg] = liquidity(ma) <= liquidity(mb) ? [legA, legB] : [legB, legA];
  return {
    plan: {
      relationId: rel.id,
      relationType: rel.type,
      graphHash: input.graphHash,
      legs,
      shares: best.s,
      cost,
      payoutGain: best.profit + cost,
      profit: best.profit,
      profitBps,
      snapshots: [ma, mb],
    },
  };
}

/** YES probability of a snapshot, in bps; for logs and traces. */
export function yesBps(m: MarketSnapshot): bigint {
  return priceYesBps(m.reserveYes, m.reserveNo);
}
