import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { calcBuy, calcSell, seedReserves } from "../core/fpmm.js";
import { executionOrder, runSimulation, type SimConfig } from "./engine.js";
import { checkInvariants, Ledger, SimContractError, SimMarketCore, type Outcome } from "./market.js";
import { runExperiment, toJson, type ExperimentConfig } from "./report.js";
import { Rng } from "./rng.js";
import { BUCKET_SECONDS, SimTreasury } from "./treasury.js";
import type { PendingOrder } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadConfig = (name: string) => JSON.parse(readFileSync(join(HERE, "configs", `${name}.json`), "utf8")) as ExperimentConfig;
const USDC = 10_000_000n;
const DAY = 86_400n;

function core(feeBps = 100n, protocolShareBps = 10_000n) {
  const ledger = new Ledger();
  const c = new SimMarketCore(ledger, { feeBps, protocolShareBps, feeRecipient: "protocol" });
  return { ledger, core: c };
}

const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof SimContractError && e.code === code, `expected ${code}`);

test("rng is deterministic and fork() streams are independent of draw order", () => {
  const a = new Rng(42n);
  const b = new Rng(42n);
  assert.deepEqual([a.nextU32(), a.nextU32(), a.float()], [b.nextU32(), b.nextU32(), b.float()]);
  const fresh = new Rng(42n).fork("x").nextU32();
  const used = new Rng(42n);
  for (let i = 0; i < 100; i++) used.nextU32();
  assert.equal(used.fork("x").nextU32(), fresh, "fork depends on seed+label only");
  assert.notEqual(new Rng(42n).fork("y").nextU32(), fresh);
  for (let i = 0; i < 1000; i++) {
    const v = a.bigBetween(5n, 9n);
    assert.ok(v >= 5n && v <= 9n);
  }
});

test("same seed and config produce byte-identical results JSON", () => {
  const cfg = { ...loadConfig("mixed"), steps: 120 };
  const first = toJson(runExperiment(cfg, 9n, 2));
  assert.equal(toJson(runExperiment(cfg, 9n, 2)), first);
  assert.notEqual(toJson(runExperiment(cfg, 10n, 2)), first, "a different seed changes the results");
});

test("invariants hold over 10k random steps with all agent types", () => {
  const cfg: SimConfig = {
    ...loadConfig("mixed"),
    steps: 10_000,
    agents: loadConfig("mixed").agents.map((a) =>
      a.type === "oracledesk-maker" ? { ...a, everySteps: 40, maxMarkets: 1_000, closeInSteps: 100 } : a,
    ),
  };
  // Invariants are asserted inside every mutation; any violation throws.
  const r = runSimulation(cfg, 2024n);
  assert.ok(r.markets.length > 50, `markets created: ${r.markets.length}`);
  assert.ok(r.fills > 10_000, `fills: ${r.fills}`);
  const kinds = new Set(r.markets.map((m) => m.resolution));
  assert.ok(kinds.has("yes") && kinds.has("no") && kinds.has("void"));
  assert.ok(r.reverts["sell:InsufficientShares"]! > 0, "oversized noise sells revert, not clamp");
});

test("collateral conservation: deposits == payouts + fees + dust + remaining after full settlement", () => {
  const r = runSimulation({ ...loadConfig("mixed"), steps: 300 }, 5n);
  const pnl = Object.values(r.pnl).reduce((a, b) => a + b, 0n);
  const dust = r.markets.reduce((a, m) => a + m.dust, 0n);
  const fees = r.markets.reduce((a, m) => a + m.feesSwept, 0n);
  assert.equal(r.sinks.protocol, fees);
  assert.equal(r.sinks.network, r.txCosts);
  // Every unit an agent lost went to another agent, a fee sink, tx costs or dust.
  assert.equal(pnl + r.sinks.protocol + r.sinks.network + dust, 0n);

  // And directly, per market, on a hand-driven market-core.
  const { ledger, core: c } = core(150n, 6_000n);
  for (const who of ["lp", "a", "b"]) ledger.mint(who, 10_000n * USDC);
  const id = c.createMarket("lp", 500n * USDC, 6_300n, 1_000n, 0n);
  c.buy("a", id, "Yes", 77n * USDC + 3n, 0n, 10n);
  c.buy("b", id, "No", 41n * USDC + 7n, 0n, 20n);
  c.sell("a", id, "Yes", 20n * USDC + 1n, 10n ** 15n, 30n);
  c.claimLpFees(id);
  c.resolve(id, "No", 1_000n);
  for (const h of ["a", "b", "lp"]) c.redeem(h, id);
  c.claimPoolRemainder(id);
  c.sweepFees(id);
  const m = c.market(id);
  const f = m.flows;
  assert.equal(f.deposited, f.soldOut + f.redeemed + f.poolClaim + f.lpFeesClaimed + f.feesSwept + m.balance);
  assert.ok(m.balance >= 0n);
  assert.equal(ledger.total(), 30_000n * USDC);
});

test("SimMarket buy/sell match calcBuy/calcSell exactly (differential vs fpmm.ts)", () => {
  const rng = new Rng(77n);
  for (const yesBps of [100n, 2_500n, 5_000n, 7_300n, 9_900n]) {
    const { ledger, core: c } = core(120n);
    ledger.mint("lp", 1_000n * USDC);
    ledger.mint("t", 100_000n * USDC);
    const seed = 1_000n * USDC;
    const id = c.createMarket("lp", seed, yesBps, 10_000n, 0n);
    const s = seedReserves(seed, yesBps);
    // Seed leftovers credited to the creator, or the invariants would fail here.
    assert.deepEqual(c.market(id).positions.lp ?? { yes: 0n, no: 0n }, { yes: s.creatorYes, no: s.creatorNo });
    let rYes = s.reserveYes;
    let rNo = s.reserveNo;
    for (let i = 0; i < 300; i++) {
      const outcome: Outcome = rng.chance(0.5) ? "Yes" : "No";
      const yes = outcome === "Yes";
      const pos = c.market(id).positions.t ?? { yes: 0n, no: 0n };
      const held = yes ? pos.yes : pos.no;
      if (held > 10n * USDC && rng.chance(0.4)) {
        const out = rng.bigBetween(1n, held / 4n);
        let q;
        try {
          q = calcSell(yes ? rYes : rNo, yes ? rNo : rYes, out, 120n);
        } catch {
          continue;
        }
        if (q.sharesIn > held) continue;
        assert.equal(c.sell("t", id, outcome, out, held, 1n), q.sharesIn);
        [rYes, rNo] = yes ? [q.newReserveSold, q.newReserveOther] : [q.newReserveOther, q.newReserveSold];
      } else {
        const amt = rng.bigBetween(1n * USDC, 300n * USDC);
        const q = calcBuy(yes ? rYes : rNo, yes ? rNo : rYes, amt, 120n);
        assert.equal(c.buy("t", id, outcome, amt, q.sharesOut, 1n), q.sharesOut);
        [rYes, rNo] = yes ? [q.newReserveBought, q.newReserveOther] : [q.newReserveOther, q.newReserveBought];
      }
      assert.equal(c.market(id).reserveYes, rYes);
      assert.equal(c.market(id).reserveNo, rNo);
    }
  }
});

test("SimMarket mirrors market-core preconditions and error names", () => {
  const { ledger, core: c } = core();
  ledger.mint("lp", 10_000n * USDC);
  ledger.mint("t", 10n * USDC);
  throwsCode(() => c.createMarket("lp", 99n * USDC, 5_000n, 100n, 0n), "InvalidAmount");
  throwsCode(() => c.createMarket("lp", 100n * USDC, 99n, 100n, 0n), "InvalidProbability");
  throwsCode(() => c.createMarket("lp", 100n * USDC, 5_000n, 0n, 0n), "InvalidCloseTime");
  const id = c.createMarket("lp", 100n * USDC, 5_000n, 100n, 0n);
  throwsCode(() => c.buy("t", id, "Yes", 1n * USDC, 10n ** 12n, 1n), "SlippageExceeded");
  throwsCode(() => c.sell("t", id, "Yes", 1n * USDC, 10n ** 15n, 1n), "InsufficientShares");
  throwsCode(() => c.buy("t", id, "Yes", 1n * USDC, 0n, 100n), "MarketClosed");
  throwsCode(() => c.redeem("t", id), "NotFinal");
  throwsCode(() => c.resolve(id, "Yes", 99n), "NotClosedYet");
  c.resolve(id, "Yes", 100n);
  throwsCode(() => c.buy("t", id, "Yes", 1n * USDC, 0n, 1n), "MarketNotOpen");
  throwsCode(() => c.redeem("t", id), "NothingToRedeem");
  c.claimPoolRemainder(id);
  throwsCode(() => c.claimPoolRemainder(id), "AlreadyClaimed");
  throwsCode(() => c.buy("t", 99, "Yes", 1n, 0n, 1n), "MarketNotFound");
});

function treasuryWorld(caps: { maxTrade: bigint; maxMarket: bigint; maxDaily: bigint }) {
  const { ledger, core: c } = core();
  ledger.mint("lp", 1_000n * USDC);
  ledger.mint("tr", 10_000n * USDC);
  const id = c.createMarket("lp", 1_000n * USDC, 5_000n, 1_000_000n, 0n);
  const tr = new SimTreasury("tr", ledger, c, caps, {});
  return { ledger, core: c, tr, id };
}

test("SimTreasury daily window resets on first call after 86400s of sim time", () => {
  // The contract's window is 25 hourly buckets (the trade's hour plus the 24
  // before it): usage stays counted for the whole 24h and is gone on the
  // first call once the next hour starts.
  const { tr, id } = treasuryWorld({ maxTrade: 100n * USDC, maxMarket: 10_000n * USDC, maxDaily: 100n * USDC });
  const t0 = 10n * BUCKET_SECONDS;
  tr.agentBuy("od", id, "Yes", 100n * USDC, 0n, t0);
  throwsCode(() => tr.agentBuy("od", id, "Yes", 1n * USDC, 0n, t0 + 3_600n), "DailyCapExceeded");
  throwsCode(() => tr.agentBuy("od", id, "Yes", 1n * USDC, 0n, t0 + DAY), "DailyCapExceeded");
  assert.equal(tr.dailyUsage(t0 + DAY + BUCKET_SECONDS), 0n);
  tr.agentBuy("od", id, "Yes", 100n * USDC, 0n, t0 + DAY + BUCKET_SECONDS);
  assert.equal(tr.stats.bindings.DailyCapExceeded, 2);
});

test("cap failure reverts the market mutation (atomicity)", () => {
  const { ledger, core: c, tr, id } = treasuryWorld({ maxTrade: 100n * USDC, maxMarket: 150n * USDC, maxDaily: 1_000n * USDC });
  throwsCode(() => tr.agentBuy("od", id, "Yes", 101n * USDC, 0n, 1n), "TradeCapExceeded");
  tr.agentBuy("od", id, "Yes", 100n * USDC, 0n, 1n);
  const before = structuredClone({ core: c.state, ledger: ledger.state, tr: tr.state });
  // Passes the per-trade check and market-core, then fails max_market.
  throwsCode(() => tr.agentBuy("od", id, "No", 60n * USDC, 0n, 2n), "MarketCapExceeded");
  assert.deepEqual({ core: c.state, ledger: ledger.state, tr: tr.state }, before);
  checkInvariants(c.market(id));
  // Sells are uncapped.
  tr.agentSell("od", id, "Yes", 10n * USDC, 10n ** 15n, 3n);
  assert.equal(tr.marketExposure(id), 100n * USDC);
});

test("sandwich ordering executes front-run before victim and back-run after", () => {
  const o = (seq: number, agentId: string, extra: Partial<PendingOrder> = {}): PendingOrder =>
    ({ kind: "buy", marketId: 0, outcome: "Yes", collateralIn: 1n, minSharesOut: 0n, agentId, seq, ...extra }) as PendingOrder;
  const pending = [
    o(0, "a"),
    o(1, "victim"),
    o(2, "b"),
    o(3, "mev", { sandwich: { victim: 1, leg: "front" } }),
    o(4, "mev", { kind: "sellShares", shares: "all", sandwich: { victim: 1, leg: "back" } } as Partial<PendingOrder>),
  ];
  for (let s = 0n; s < 20n; s++) {
    const seqs = executionOrder(pending, "sandwich", new Rng(s)).map((x) => x.seq);
    const v = seqs.indexOf(1);
    assert.equal(seqs[v - 1], 3, `front-run right before victim: ${seqs}`);
    assert.equal(seqs[v + 1], 4, `back-run right after victim: ${seqs}`);
    assert.equal(seqs.length, 5);
  }
  // Without the sandwich policy, legs are just shuffled in.
  assert.deepEqual(executionOrder(pending, "shuffle", new Rng(1n)).map((x) => x.seq).sort(), [0, 1, 2, 3, 4]);

  // End to end: a victim with min_shares_out 0 is filled after the front-run.
  const cfg: SimConfig = { ...loadConfig("sandwich"), steps: 100 };
  delete (cfg as ExperimentConfig).sweep;
  const od = cfg.agents.find((a) => a.type === "oracledesk-trader")!;
  const unprotected = runSimulation({ ...cfg, agents: cfg.agents.map((a) => (a === od ? { ...a, slippageBps: null } : a)) }, 3n);
  const protectedRun = runSimulation({ ...cfg, agents: cfg.agents.map((a) => (a === od ? { ...a, slippageBps: 50 } : a)) }, 3n);
  assert.ok((protectedRun.reverts["buy:SlippageExceeded"] ?? 0) > (unprotected.reverts["buy:SlippageExceeded"] ?? 0));
});

test("void settlement pays (yes+no)/2 floor and records dust", () => {
  const { ledger, core: c } = core(100n);
  for (const who of ["lp", "a", "b"]) ledger.mint(who, 1_000n * USDC);
  const id = c.createMarket("lp", 300n * USDC, 6_700n, 100n, 0n);
  c.buy("a", id, "Yes", 33n * USDC + 1n, 0n, 1n);
  c.buy("b", id, "No", 17n * USDC + 3n, 0n, 1n);
  c.buy("b", id, "Yes", 5n * USDC + 7n, 0n, 1n);
  c.voidMarket(id);
  const m = c.market(id);
  for (const h of ["a", "b", "lp"]) {
    const p = { ...m.positions[h]! };
    const before = ledger.balance(h);
    assert.equal(c.redeem(h, id), (p.yes + p.no) / 2n);
    assert.equal(ledger.balance(h) - before, (p.yes + p.no) / 2n);
  }
  const pool = (m.reserveYes + m.reserveNo) / 2n;
  assert.equal(c.claimPoolRemainder(id), pool);
  c.sweepFees(id);
  // Floors leave dust behind; it is reported, never paid out.
  const f = c.market(id).flows;
  assert.equal(c.market(id).balance, f.deposited - f.redeemed - f.poolClaim - f.lpFeesClaimed - f.feesSwept);
  assert.ok(c.market(id).balance >= 0n);
  const runs = runSimulation({ ...loadConfig("mixed"), steps: 200 }, 11n).markets.filter((x) => x.resolution === "void");
  assert.ok(runs.every((x) => x.dust >= 0n));
});
