import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BondBudget } from "../../core/bond-budget.js";
import { DEFAULT_POLICY } from "../../core/dispute-policy.js";
import type { OracleDeskEvent } from "../../core/events/decode.js";
import type { OutcomeSource, OutcomeVerdict } from "../../core/outcomes/index.js";
import { LocalTraceStore } from "../../core/trace.js";
import { NotSubmittedError } from "../../stellar/adapter.js";
import { MarketLocks } from "../locks.js";
import type { TaskContext } from "../runtime.js";
import { MemoryStateStore } from "../state.js";
import { createWatcher, DISPUTES, TRACKED, type DisputeRecord, type TrackedProposal, type WatcherAdapter, type WatcherDeps } from "./watcher.js";

const US = "GWATCHER";
const TREASURY = "CMARKETCORETREASURY";
const BOND = 100_000_000n;
const WINDOW = 600n;
const TIMEOUT = 3_600n;
const PROPOSED_AT = 1_000n;

type Side = "Yes" | "No" | "Invalid";

/** An in-memory resolver + clock: just enough chain for the watcher's reads and writes. */
class FakeChain {
  now = 1_100n;
  state: "SignersPending" | "Disputed" | "Finalized" | "Unconfigured" = "SignersPending";
  proposal: { outcome: Side; proposedAt: bigint } | undefined = { outcome: "Yes", proposedAt: PROPOSED_AT };
  disputable = true;
  dispute: { disputer: string; bond: bigint; token: string; openedAt: bigint; payee?: string } | undefined;
  position = { yes: 0n, no: 2_000_000_000n };
  costBasis = 500_000_000n;
  balance = 10_000_000_000n;
  calls: string[] = [];
  rejectDisputeWith: string | undefined;

  adapter(mode: "live" | "dry-run" = "live"): WatcherAdapter {
    const chain = this;
    return {
      mode,
      agent: US,
      resolutionState: async () => chain.state,
      disputableConfig: async () =>
        chain.disputable
          ? { signers: ["S1", "S2"], threshold: 2, disputeWindow: WINDOW, disputeBond: BOND, escalation: "Guardian" as const, escalationTimeout: TIMEOUT }
          : undefined,
      currentDispute: async () => (chain.dispute ? { ...chain.dispute } : undefined),
      currentProposal: async () => (chain.proposal ? { ...chain.proposal } : undefined),
      ledgerTime: async () => chain.now,
      collateralBalance: async () => chain.balance,
      treasuryPosition: async () => ({ ...chain.position }),
      marketSpent: async () => chain.costBasis,
      dispute: async (args: { market_id: bigint; alternative: Side | null }) => {
        chain.calls.push(`dispute:${args.market_id}:${args.alternative}`);
        if (mode === "dry-run") return { dryRun: true, contractId: "R", method: "dispute", args };
        if (chain.rejectDisputeWith) throw new NotSubmittedError(chain.rejectDisputeWith);
        chain.dispute = { disputer: US, bond: BOND, token: "CUSDC", openedAt: chain.now };
        chain.state = "Disputed";
        chain.balance -= BOND;
        return { dryRun: false, value: undefined, txHash: "HASH1" };
      },
      expireDispute: async (id: bigint) => {
        chain.calls.push(`expire:${id}`);
        chain.dispute = { ...chain.dispute!, payee: chain.dispute!.disputer }; // timeout refunds the disputer
        chain.state = "Finalized";
        return { dryRun: false, value: undefined };
      },
      claimDisputeBond: async (id: bigint) => {
        chain.calls.push(`claim:${id}`);
        chain.balance += chain.dispute!.bond;
        chain.dispute = undefined;
        return { dryRun: false, value: undefined };
      },
      publishTrace: async (args: { action: string }) => {
        chain.calls.push(`trace:${args.action}`);
        return { dryRun: false, value: 1n };
      },
    } as unknown as WatcherAdapter;
  }

  /** The guardian rules; `upheld` means the proposal stood. */
  settle(upheld: boolean): void {
    this.dispute = { ...this.dispute!, payee: upheld ? TREASURY : this.dispute!.disputer };
    this.state = "Finalized";
  }
}

const verdictSource = (verdict: OutcomeVerdict | undefined, name = "test-source"): OutcomeSource => ({
  name,
  supports: () => true,
  determine: async () => verdict,
});
const sure = (outcome: Side, confidenceBps = 9_900): OutcomeVerdict => ({ outcome, confidenceBps, evidence: { fixture: true } });

function setup(opts: { chain?: FakeChain; sources?: OutcomeSource[]; mode?: "live" | "dry-run"; budget?: { maxBond: bigint; total: bigint; perDay: number } } = {}) {
  const chain = opts.chain ?? new FakeChain();
  const state = new MemoryStateStore();
  const alerts: { code: string; fields: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const ctx: TaskContext = {
    signal: new AbortController().signal,
    state,
    locks: new MarketLocks(state),
    submit: (fn) => fn(),
    log: { info: (e) => void logs.push(e), warn: (e) => void logs.push(e), error: (e) => void logs.push(e) },
    now: () => Number(chain.now) * 1000,
  };
  const b = opts.budget ?? { maxBond: BOND, total: 10n * BOND, perDay: 5 };
  const deps: WatcherDeps = {
    adapter: chain.adapter(opts.mode),
    sources: opts.sources ?? [verdictSource(sure("No"))],
    traceStore: new LocalTraceStore(mkdtempSync(join(tmpdir(), "watcher-"))),
    budget: (s) => new BondBudget(s, { maxBondStroops: b.maxBond, budgetStroops: b.total, maxDisputesPerDay: b.perDay }),
    policy: DEFAULT_POLICY,
    marketInfo: async () => ({ metaUri: "ipfs://q", closeTime: 900n }),
    alert: (code, fields) => void alerts.push({ code, fields }),
  };
  const watcher = createWatcher(deps);
  const emit = async (e: Record<string, unknown>) => {
    const event = { id: "1", ledger: 1, closedAt: Number(chain.now), txHash: "t", contract: "resolver", contractId: "C", ...e } as OracleDeskEvent;
    for (const h of watcher.handlers.filter((x) => x.kinds.includes(event.kind))) await h.handle(event);
  };
  const proposed = (outcome: Side = "Yes", proposedAt = PROPOSED_AT) => emit({ kind: "ResolutionProposed", marketId: 1n, outcome, proposedAt });
  const budget = () => deps.budget(state);
  return { chain, state, ctx, watcher, emit, proposed, alerts, logs, budget };
}

const record = (s: ReturnType<typeof setup>) => s.state.get<DisputeRecord>(DISPUTES, "1");

test("proposal the sources contradict: publishes a trace, then disputes before the deadline", async () => {
  const s = setup();
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, ["trace:other:dispute", "dispute:1:No"], "the trace goes on-chain before the dispute is sent");
  assert.deepEqual([record(s)?.status, record(s)?.bond, record(s)?.txHash], ["open", BOND, "HASH1"]);
  assert.equal(s.budget().totals().atRisk, BOND);
  assert.equal(s.state.get(TRACKED, "1"), undefined, "no longer tracked: the dispute freezes finalization");
});

test("a proposal the sources agree with is never disputed", async () => {
  const s = setup({ sources: [verdictSource(sure("Yes"))] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, []);
  assert.equal(record(s), undefined);
  assert.equal(s.budget().totals().committed, 0n);
});

test("disagreeing sources alert and never dispute", async () => {
  const s = setup({ sources: [verdictSource(sure("No"), "a"), verdictSource(sure("Yes"), "b")] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, []);
  assert.deepEqual(s.alerts.map((a) => a.code), ["WATCHER_SOURCES_DISAGREE"]);
});

test("low confidence, or no exposure on the verdict's side, does not dispute", async () => {
  const low = setup({ sources: [verdictSource(sure("No", 9_000))] });
  await low.proposed("Yes");
  await low.watcher.tick(low.ctx);
  assert.deepEqual(low.chain.calls, []);

  const chain = new FakeChain();
  chain.position = { yes: 5_000_000_000n, no: 0n };
  const flat = setup({ chain });
  await flat.proposed("Yes");
  await flat.watcher.tick(flat.ctx);
  assert.deepEqual(chain.calls, [], "the treasury would not gain from a No ruling");
});

test("a window with less than minLeadSecs left is not disputed", async () => {
  const chain = new FakeChain();
  chain.now = PROPOSED_AT + WINDOW - 59n;
  const s = setup({ chain });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(chain.calls, []);
});

test("evaluates at once and again at deadline - 2*minLeadSecs, not on every tick", async () => {
  let calls = 0;
  const counting: OutcomeSource = { name: "count", supports: () => true, determine: async () => (calls++, sure("Yes")) };
  const s = setup({ sources: [counting] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  await s.watcher.tick(s.ctx);
  assert.equal(calls, 1, "first evaluation only");
  s.chain.now = PROPOSED_AT + WINDOW - 2n * DEFAULT_POLICY.minLeadSecs;
  await s.watcher.tick(s.ctx);
  await s.watcher.tick(s.ctx);
  assert.equal(calls, 2, "plus one late check");
});

test("a missed ResolutionProposed event is recovered by scanning resolver state", async () => {
  const chain = new FakeChain();
  const s = setup({ chain });
  // No event is ever emitted; `candidates` (markets the treasury holds) finds the proposal.
  const withCandidates = createWatcher({
    adapter: chain.adapter(),
    sources: [verdictSource(sure("No"))],
    traceStore: new LocalTraceStore(mkdtempSync(join(tmpdir(), "watcher-"))),
    budget: (st) => new BondBudget(st, { maxBondStroops: BOND, budgetStroops: 10n * BOND, maxDisputesPerDay: 5 }),
    policy: DEFAULT_POLICY,
    marketInfo: async () => ({ closeTime: 900n }),
    candidates: async () => [1n],
  });
  assert.equal(withCandidates.tracked(s.ctx).length, 0);
  await withCandidates.tick(s.ctx);
  assert.deepEqual(chain.calls, ["trace:other:dispute", "dispute:1:No"]);
});

test("a proposal cancelled without an event is dropped by the state poll", async () => {
  const s = setup({ sources: [verdictSource(sure("Yes"))] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.equal(s.watcher.tracked(s.ctx).length, 1);
  s.chain.proposal = undefined; // the guardian cancelled it; no ResolutionProposed/Cancelled event reached us
  await s.watcher.tick(s.ctx);
  assert.equal(s.watcher.tracked(s.ctx).length, 0);
});

test("a re-proposal (new round) restarts the evaluation schedule", async () => {
  const s = setup({ sources: [verdictSource(sure("Yes"))] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.equal(s.state.get<TrackedProposal>(TRACKED, "1")?.firstDone, true);
  s.chain.proposal = { outcome: "No", proposedAt: PROPOSED_AT + 50n };
  await s.watcher.tick(s.ctx);
  const t = s.state.get<TrackedProposal>(TRACKED, "1");
  assert.deepEqual([t?.outcome, t?.proposedAt], ["No", PROPOSED_AT + 50n]);
});

test("a dispute that settles in our favour is claimed and the bond returns to the budget", async () => {
  const s = setup();
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  s.chain.settle(false); // ruling overturned the proposal: payee is us
  await s.emit({ kind: "DisputeSettled", marketId: 1n, verdict: "No", disputerWon: true, payout: BOND });
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls.slice(-1), ["claim:1"]);
  assert.equal(record(s)?.status, "claimed");
  assert.deepEqual(s.budget().totals(), { committed: BOND, atRisk: 0n, refunded: BOND, forfeited: 0n });
  assert.equal(s.chain.balance, 10_000_000_000n, "bond is back in the wallet");
});

test("a dispute that loses forfeits the bond to market-core's treasury and is not claimed", async () => {
  const s = setup();
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  s.chain.settle(true); // proposal upheld: payee is the market-core treasury
  await s.watcher.tick(s.ctx);
  assert.ok(!s.chain.calls.some((c) => c.startsWith("claim")));
  assert.equal(record(s)?.status, "lost");
  assert.deepEqual(s.budget().totals(), { committed: BOND, atRisk: 0n, refunded: 0n, forfeited: BOND });
});

test("an open dispute is left alone until escalation times out, then expired and claimed", async () => {
  const s = setup();
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  const opened = s.chain.now;
  s.chain.now = opened + TIMEOUT - 1n;
  await s.watcher.tick(s.ctx);
  assert.ok(!s.chain.calls.some((c) => c.startsWith("expire")), "one second early");
  s.chain.now = opened + TIMEOUT;
  await s.watcher.tick(s.ctx);
  await s.emit({ kind: "DisputeSettled", marketId: 1n, verdict: "Invalid", disputerWon: false, payout: BOND });
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls.slice(-2), ["expire:1", "claim:1"]);
  assert.equal(record(s)?.status, "claimed");
  assert.equal(s.budget().totals().refunded, BOND);
  await s.watcher.tick(s.ctx);
  assert.equal(s.chain.calls.filter((c) => c.startsWith("expire")).length, 1, "expire is sent once");
});

test("budget exhaustion alerts and does not dispute", async () => {
  const s = setup({ budget: { maxBond: BOND, total: BOND, perDay: 5 } });
  s.budget().commit(99n, BOND, Number(s.chain.now)); // another dispute already uses the whole budget
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, []);
  assert.deepEqual(s.alerts.map((a) => a.code), ["WATCHER_BUDGET_EXHAUSTED"]);
});

test("the wallet balance, not just the configured budget, caps the bond", async () => {
  const chain = new FakeChain();
  chain.balance = BOND - 1n;
  const s = setup({ chain });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(chain.calls, []);
  assert.equal(s.alerts[0]?.code, "WATCHER_BUDGET_EXHAUSTED");
});

test("another party disputing first counts as success: nothing is spent and their dispute is followed", async () => {
  const chain = new FakeChain();
  chain.rejectDisputeWith = "dispute simulation failed: DisputeActive";
  const s = setup({ chain });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.equal(record(s)?.status, "foreign");
  assert.equal(s.budget().totals().committed, 0n, "the bond was released");
  assert.equal(s.watcher.tracked(s.ctx).length, 0);
});

test("a rejected submission frees the bond and is retried while the window lasts", async () => {
  const chain = new FakeChain();
  chain.rejectDisputeWith = "dispute simulation failed: some transient RPC error";
  const s = setup({ chain });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.equal(record(s), undefined);
  assert.equal(s.budget().totals().committed, 0n);
  assert.equal(s.state.get<TrackedProposal>(TRACKED, "1")?.retry, true);
  chain.rejectDisputeWith = undefined;
  await s.watcher.tick(s.ctx);
  assert.equal(record(s)?.status, "open");
});

/** A watcher whose `dispute` call fails ambiguously: `lands` says whether the transaction reached the chain first. */
function ambiguousSubmit(lands: boolean) {
  const chain = new FakeChain();
  const adapter = chain.adapter();
  const real = adapter.dispute.bind(adapter);
  adapter.dispute = (async (args: Parameters<typeof real>[0]) => {
    if (lands) await real(args);
    throw new Error("socket hang up"); // the response never arrives
  }) as typeof adapter.dispute;
  const s = setup({ chain });
  const cfg = { maxBondStroops: BOND, budgetStroops: 10n * BOND, maxDisputesPerDay: 5 };
  const watcher = createWatcher({
    adapter,
    sources: [verdictSource(sure("No"))],
    traceStore: new LocalTraceStore(mkdtempSync(join(tmpdir(), "watcher-"))),
    budget: (st) => new BondBudget(st, cfg),
    policy: DEFAULT_POLICY,
    marketInfo: async () => ({ closeTime: 900n }),
    candidates: async () => [1n],
  });
  return { s, chain, watcher, budget: new BondBudget(s.state, cfg) };
}

test("a submission that may have landed keeps the bond committed and reconciles from the chain", async () => {
  const { s, watcher, budget } = ambiguousSubmit(true);
  await assert.rejects(() => watcher.tick(s.ctx), /socket hang up/, "the runtime still sees the failure");
  assert.equal(record(s)?.status, "open", "reconciled in the same tick: our dispute is on chain");
  assert.equal(budget.totals().atRisk, BOND, "the bond stays committed");
});

test("a submission that did not land is reconciled away and its bond released", async () => {
  const { s, watcher, budget } = ambiguousSubmit(false);
  await assert.rejects(() => watcher.tick(s.ctx), /socket hang up/);
  assert.equal(record(s), undefined);
  assert.equal(budget.totals().committed, 0n);
});

test("dry-run decides and logs but spends nothing and records no dispute", async () => {
  const s = setup({ mode: "dry-run" });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, ["dispute:1:No"], "no trace is published in dry-run");
  assert.equal(record(s), undefined);
  assert.equal(s.budget().totals().committed, 0n);
});

test("non-disputable markets are ignored", async () => {
  const chain = new FakeChain();
  chain.disputable = false;
  const s = setup({ chain });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.equal(s.watcher.tracked(s.ctx).length, 0);
  assert.deepEqual(chain.calls, []);
});

test("an Invalid verdict disputes with no explicit alternative; an Invalid proposal needs a Yes/No one", async () => {
  const chain = new FakeChain();
  chain.position = { yes: 0n, no: 0n };
  chain.costBasis = 2_000_000_000n; // a refund would be worth a lot
  const s = setup({ chain, sources: [verdictSource(sure("Invalid"))] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(chain.calls, ["trace:other:dispute", "dispute:1:null"]);
});

test("another party's Disputed event untracks the market and records it as foreign", async () => {
  const s = setup({ sources: [verdictSource(sure("Yes"))] });
  await s.proposed("Yes");
  await s.emit({ kind: "Disputed", marketId: 1n, disputer: "GSOMEONEELSE", bond: BOND, alternative: "No" });
  await s.watcher.tick(s.ctx);
  assert.equal(record(s)?.status, "foreign");
  assert.equal(s.watcher.tracked(s.ctx).length, 0);
});

test("finalization, or a closed window, stops tracking", async () => {
  const s = setup({ sources: [verdictSource(sure("Yes"))] });
  await s.proposed("Yes");
  s.chain.now = PROPOSED_AT + WINDOW;
  await s.watcher.tick(s.ctx);
  assert.equal(s.watcher.tracked(s.ctx).length, 0);
  await s.proposed("Yes");
  await s.emit({ kind: "ResolutionFinalized", marketId: 1n, outcome: "Yes", finalizedAt: PROPOSED_AT + WINDOW });
  await s.watcher.tick(s.ctx);
  assert.equal(s.watcher.tracked(s.ctx).length, 0);
});

test("a failing source is retried on the next tick and does not dispute meanwhile", async () => {
  let fail = true;
  const flaky: OutcomeSource = {
    name: "flaky",
    supports: () => true,
    determine: async () => {
      if (fail) throw new Error("rpc down");
      return sure("No");
    },
  };
  const s = setup({ sources: [flaky] });
  await s.proposed("Yes");
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, []);
  fail = false;
  await s.watcher.tick(s.ctx);
  assert.deepEqual(s.chain.calls, ["trace:other:dispute", "dispute:1:No"]);
});
