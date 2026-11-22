/**
 * Chaos for the proposal watcher (#275): the real watcher logic (`createWatcher`,
 * ticked directly, no Runtime loop), against a resolver model whose every call costs ledger time and may
 * fail, so the dispute window is crossed by latency the way it is on a live
 * RPC. Seeded (`sim/rng.ts`): a seed always reproduces the same run.
 *
 * Scope note. This does not go through the fake HTTP RPC (`FakeNetwork`),
 * which models market-core, treasury and the registry only and has no
 * resolver: the faults here are injected at the adapter boundary, which is
 * what the watcher actually depends on. Faults modelled: per-call latency in
 * ledger seconds, read timeouts, ambiguous submissions (the transaction lands
 * but the response is lost, or it never lands) and transient rejections.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BondBudget } from "../../core/bond-budget.js";
import { DEFAULT_POLICY } from "../../core/dispute-policy.js";
import type { OutcomeSource } from "../../core/outcomes/index.js";
import { LocalTraceStore } from "../../core/trace.js";
import { MarketLocks } from "../../runtime/locks.js";
import type { TaskContext } from "../../runtime/runtime.js";
import { MemoryStateStore } from "../../runtime/state.js";
import { createWatcher, DISPUTES, type DisputeRecord, type WatcherAdapter } from "../../runtime/tasks/watcher.js";
import { NotSubmittedError } from "../../stellar/adapter.js";
import { Rng } from "../../sim/rng.js";

const US = "GWATCHER";
const BOND = 100_000_000n;
const WINDOW = 600n;
const TIMEOUT = 1_800n;
const PROPOSED_AT = 1_000n;
const DEADLINE = PROPOSED_AT + WINDOW;
/** Worst-case ledger seconds one call may take; two of them fit inside minLeadSecs. */
const MAX_LATENCY = 25;

class ChaosResolver {
  now = PROPOSED_AT + 20n;
  state: "SignersPending" | "Disputed" | "Finalized" = "SignersPending";
  dispute: { disputer: string; bond: bigint; token: string; openedAt: bigint; payee?: string } | undefined;
  balance = 10n * BOND;
  log: string[] = [];
  windowClosedRejections = 0;
  disputesLanded = 0;
  claims = 0;

  constructor(private readonly rng: Rng) {}

  /** A call: costs ledger time, and a read may time out. */
  private async call<T>(name: string, fn: () => T, opts: { read?: boolean } = {}): Promise<T> {
    // Mostly quick, with a heavy tail up to MAX_LATENCY: a slow RPC near the deadline.
    this.now += BigInt(this.rng.chance(0.1) ? this.rng.int(MAX_LATENCY + 1) : this.rng.int(4));
    if (opts.read && this.rng.chance(0.03)) throw new Error(`${name}: request timed out`);
    return fn();
  }

  adapter(): WatcherAdapter {
    const c = this;
    return {
      mode: "live",
      agent: US,
      resolutionState: (_id: bigint) => c.call("state", () => c.state, { read: true }),
      disputableConfig: (_id: bigint) =>
        c.call(
          "disputableConfig",
          () => ({ signers: ["S1"], threshold: 1, disputeWindow: WINDOW, disputeBond: BOND, escalation: "Guardian" as const, escalationTimeout: TIMEOUT }),
          { read: true },
        ),
      currentDispute: (_id: bigint) => c.call("currentDispute", () => (c.dispute ? { ...c.dispute } : undefined), { read: true }),
      currentProposal: (_id: bigint) => c.call("currentProposal", () => (c.state === "SignersPending" ? { outcome: "Yes" as const, proposedAt: PROPOSED_AT } : undefined), { read: true }),
      ledgerTime: () => c.call("ledgerTime", () => c.now, { read: true }),
      collateralBalance: (_a: string) => c.call("balance", () => c.balance, { read: true }),
      treasuryPosition: (_id: bigint) => c.call("position", () => ({ yes: 0n, no: 2_000_000_000n }), { read: true }),
      marketSpent: (_id: bigint) => c.call("spent", () => 500_000_000n, { read: true }),
      publishTrace: async (a: { action: string }) => {
        await c.call("publishTrace", () => undefined);
        c.log.push(`trace:${a.action}`);
        return { dryRun: false as const, value: 1n };
      },
      dispute: async (args: { market_id: bigint; alternative: "Yes" | "No" | null }) => {
        await c.call("dispute", () => undefined);
        const roll = c.rng.float();
        if (roll < 0.1) throw new NotSubmittedError("dispute simulation failed: transient"); // never sent
        if (c.now >= DEADLINE) {
          c.windowClosedRejections++;
          throw new NotSubmittedError("dispute simulation failed: DisputeWindowClosed");
        }
        c.log.push(`dispute:${args.alternative}`);
        c.dispute = { disputer: US, bond: BOND, token: "CUSDC", openedAt: c.now };
        c.state = "Disputed";
        c.balance -= BOND;
        c.disputesLanded++;
        if (roll < 0.25) throw new Error("socket hang up"); // landed, but the response was lost
        return { dryRun: false as const, value: undefined, txHash: "H" };
      },
      expireDispute: async (_id: bigint) => {
        await c.call("expire", () => undefined);
        assert.ok(c.dispute && c.now >= c.dispute.openedAt + TIMEOUT, "expire_dispute sent before the escalation timeout");
        c.log.push("expire");
        c.dispute = { ...c.dispute, payee: c.dispute.disputer };
        c.state = "Finalized";
        return { dryRun: false as const, value: undefined };
      },
      claimDisputeBond: async (_id: bigint) => {
        await c.call("claim", () => undefined);
        assert.ok(c.dispute?.payee === US, "claim sent for a bond that is not ours");
        c.log.push("claim");
        c.balance += c.dispute.bond;
        c.dispute = undefined;
        c.claims++;
        return { dryRun: false as const, value: undefined };
      },
    } as unknown as WatcherAdapter;
  }
}

const wrongProposal: OutcomeSource = {
  name: "oracle",
  supports: () => true,
  determine: async () => ({ outcome: "No", confidenceBps: 9_900, evidence: {} }),
};

async function run(seed: bigint) {
  const rng = new Rng(seed);
  const chain = new ChaosResolver(rng.fork("chain"));
  const state = new MemoryStateStore();
  const cfg = { maxBondStroops: BOND, budgetStroops: 3n * BOND, maxDisputesPerDay: 5 };
  const ctx: TaskContext = {
    signal: new AbortController().signal,
    state,
    locks: new MarketLocks(state),
    submit: (fn) => fn(),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => Number(chain.now) * 1000,
  };
  const watcher = createWatcher({
    adapter: chain.adapter(),
    sources: [wrongProposal],
    traceStore: new LocalTraceStore(mkdtempSync(join(tmpdir(), "chaos-watcher-"))),
    budget: (s) => new BondBudget(s, cfg),
    policy: DEFAULT_POLICY,
    marketInfo: async () => ({ closeTime: 900n }),
    candidates: async () => [1n],
  });
  // Ticks every ~5 s of ledger time through the window, the escalation timeout and a margin after.
  let errors = 0;
  for (let i = 0; i < 700; i++) {
    try {
      await watcher.tick(ctx);
    } catch {
      errors++;
    }
    chain.now += 5n;
    if (chain.state === "Finalized" && !chain.dispute) break;
  }
  return { chain, state, budget: new BondBudget(state, cfg), errors };
}

const SEEDS = Array.from({ length: 60 }, (_, i) => BigInt(i + 1));

test("under latency and faults around the deadline, the watcher keeps its invariants on every seed", async () => {
  let disputed = 0;
  for (const seed of SEEDS) {
    const { chain, state, budget } = await run(seed);
    const ctxMsg = `seed ${seed}`;

    // The ledger-time margin works: latency never pushed a signed dispute past the window.
    assert.equal(chain.windowClosedRejections, 0, `${ctxMsg}: a dispute reached the chain after the window closed`);
    // Never more than one dispute per market, and never a dispute without a trace first.
    assert.ok(chain.disputesLanded <= 1, `${ctxMsg}: duplicate dispute`);
    const iDispute = chain.log.findIndex((l) => l.startsWith("dispute"));
    if (iDispute >= 0) {
      assert.ok(chain.log.slice(0, iDispute).includes("trace:other:dispute"), `${ctxMsg}: dispute without a published trace`);
      disputed++;
    }
    // Bond accounting: derived totals add up and never exceed the budget.
    const t = budget.totals();
    assert.equal(t.committed, t.atRisk + t.refunded + t.forfeited, `${ctxMsg}: ledger identity`);
    assert.ok(t.atRisk <= 3n * BOND, `${ctxMsg}: over budget`);
    // Eventually consistent with the chain once things are quiet.
    const rec = state.get<DisputeRecord>(DISPUTES, "1");
    assert.notEqual(rec?.status, "submitting", `${ctxMsg}: still reconciling an uncertain submission`);
    if (chain.disputesLanded === 1) {
      // A landed dispute is followed to the end: expired after the timeout, then claimed; the wallet is whole.
      assert.equal(rec?.status, "claimed", `${ctxMsg}: dispute not followed to settlement (${rec?.status})`);
      assert.equal(chain.balance, 10n * BOND, `${ctxMsg}: bond not recovered`);
      assert.equal(t.atRisk, 0n, `${ctxMsg}: bond still at risk after claim`);
    } else {
      assert.equal(t.atRisk, 0n, `${ctxMsg}: bond committed for a dispute that never landed`);
      assert.equal(chain.balance, 10n * BOND, `${ctxMsg}: wallet changed without a dispute`);
    }
  }
  // Faults make some seeds miss the window, but the margin keeps it the exception.
  assert.ok(disputed >= SEEDS.length * 0.8, `only ${disputed}/${SEEDS.length} seeds disputed in time`);
});

test("a run is reproducible from its seed", async () => {
  const a = await run(7n);
  const b = await run(7n);
  assert.deepEqual(a.chain.log, b.chain.log);
  assert.equal(a.chain.now, b.chain.now);
});
