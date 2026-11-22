/**
 * The proposal watcher (#275): an optimistic oracle is only as safe as its
 * challengers, so this task follows resolver proposals on disputable signer
 * markets, independently works out the expected outcome, and disputes a wrong
 * proposal inside its window, with a bond, when that protects a position the
 * treasury holds.
 *
 * Time. The dispute window is measured in ledger time, which RPC event
 * delivery lags, so the task never trusts an event's age: every tick re-reads
 * `state()`, the proposal and the latest ledger close time, evaluates once as
 * soon as a proposal is seen and again at `deadline - 2 * minLeadSecs`, and
 * refuses to sign with less than `minLeadSecs` left. A missed event therefore
 * cannot lose a window (the tick finds the proposal through `trackAll`).
 *
 * Money. A correct dispute only refunds the bond; a wrong one forfeits it. See
 * core/dispute-policy.ts for the rule and core/bond-budget.ts for the cap.
 *
 * Every dispute is preceded by a published reasoning trace, and is followed to
 * settlement: `expire_dispute` once the escalation timeout lapses, then
 * `claim_dispute_bond` when the watcher is the payee.
 */
import { join } from "node:path";
import { BondBudget } from "../../core/bond-budget.js";
import type { AgentConfig } from "../../core/config.js";
import { alternativeFor, decideDispute, type DisputeDecision, type DisputePolicyConfig, type Exposure } from "../../core/dispute-policy.js";
import { EventDecoder, type OracleDeskEvent } from "../../core/events/decode.js";
import { Dispatcher, ProcessedLru, type EventHandler } from "../../core/events/dispatch.js";
import { EventSubscriber, FileCheckpointStore, type EventsRpc } from "../../core/events/subscriber.js";
import { combineVerdicts, type OutcomeSource, type OutcomeVerdict, type WatchedMarket } from "../../core/outcomes/index.js";
import { buildTrace, type TraceStore } from "../../core/trace.js";
import { NotSubmittedError, type StellarAdapter } from "../../stellar/adapter.js";
import { AbortedError, type Task, type TaskContext } from "../runtime.js";
import type { StateStore } from "../state.js";
import { publishPendingTraces, recordPendingTrace } from "./traces.js";

export const TRACKED = "watcher.tracked";
export const DISPUTES = "watcher.disputes";

type Of<K extends OracleDeskEvent["kind"]> = Extract<OracleDeskEvent, { kind: K }>;
type Outcome = "Yes" | "No" | "Invalid";

/** A proposal the watcher is following. */
export interface TrackedProposal {
  outcome: Outcome;
  proposedAt: bigint;
  /** The market's committed `dispute_window`, seconds. */
  disputeWindow: bigint;
  disputeBond: bigint;
  escalationTimeout: bigint;
  /** Evaluated once since the proposal was seen. */
  firstDone: boolean;
  /** Evaluated again in the late checkpoint. */
  lateDone: boolean;
  /** The last evaluation could not reach a decision (a source failed): try again. */
  retry: boolean;
}

export type DisputeStatus =
  /** Intent recorded, transaction in flight or unconfirmed. */
  | "submitting"
  /** Our dispute is open; follow escalation. */
  | "open"
  /** Settled; payee not yet read. */
  | "settled"
  /** Settled in our favour: the bond is claimable. */
  | "won"
  /** Settled against us: the bond went to market-core's treasury. */
  | "lost"
  /** Bond paid out to us. */
  | "claimed"
  /** Someone else disputed first; nothing of ours is at stake. */
  | "foreign";

export interface DisputeRecord {
  status: DisputeStatus;
  bond: bigint;
  txHash?: string;
  openedAt?: bigint;
  escalationTimeout?: bigint;
  /** Set once `expire_dispute` was submitted so it is not sent twice. */
  expired?: boolean;
  /** From `DisputeSettled`: the bond returns to the disputer. */
  disputerWon?: boolean;
}

export type WatcherAdapter = Pick<
  StellarAdapter,
  | "mode"
  | "agent"
  | "resolutionState"
  | "disputableConfig"
  | "currentDispute"
  | "currentProposal"
  | "ledgerTime"
  | "collateralBalance"
  | "treasuryPosition"
  | "marketSpent"
  | "dispute"
  | "expireDispute"
  | "claimDisputeBond"
  | "publishTrace"
>;

export interface WatcherDeps {
  adapter: WatcherAdapter;
  sources: OutcomeSource[];
  traceStore: TraceStore;
  /** The budget over the runtime's state store (known only once the runtime starts). */
  budget: (state: StateStore) => BondBudget;
  policy: DisputePolicyConfig;
  /** market-core market facts the sources need. */
  marketInfo: (marketId: bigint) => Promise<{ metaUri?: string; closeTime: bigint } | undefined>;
  /** Markets worth scanning for pending proposals (those the treasury holds). Optional. */
  candidates?: () => Promise<bigint[]>;
  /** Raises an operator-visible alert (disagreeing sources, exhausted budget, …). */
  alert?: (code: string, fields: Record<string, unknown>) => void;
}

export interface Watcher {
  /** Event handlers for the watcher's own dispatcher. */
  handlers: EventHandler[];
  tick(ctx: TaskContext): Promise<void>;
  /** Proposals currently followed (for tests and status output). */
  tracked(ctx: TaskContext): [string, TrackedProposal][];
}

const secs = (v: bigint) => v.toString();
const nowSecs = (ctx: TaskContext) => Math.floor(ctx.now() / 1000);

export function createWatcher(d: WatcherDeps): Watcher {
  const live = d.adapter.mode === "live";
  const us = () => d.adapter.agent;

  /** Starts following `marketId` if it has a pending proposal on a disputable market. */
  async function track(ctx: TaskContext, marketId: bigint, proposal: { outcome: Outcome; proposedAt: bigint }): Promise<void> {
    const cfg = await d.adapter.disputableConfig(marketId);
    if (!cfg) return; // not a disputable market: nothing to challenge
    const key = marketId.toString();
    const prev = ctx.state.get<TrackedProposal>(TRACKED, key);
    if (prev && prev.outcome === proposal.outcome && prev.proposedAt === proposal.proposedAt) return;
    ctx.state.set<TrackedProposal>(TRACKED, key, {
      outcome: proposal.outcome,
      proposedAt: proposal.proposedAt,
      disputeWindow: cfg.disputeWindow,
      disputeBond: cfg.disputeBond,
      escalationTimeout: cfg.escalationTimeout,
      firstDone: false,
      lateDone: false,
      retry: false,
    });
    ctx.log.info("WATCHER_TRACK", { market: marketId, outcome: proposal.outcome, proposedAt: proposal.proposedAt, window: cfg.disputeWindow });
  }

  // The handlers only see events, which carry no TaskContext; they stage work
  // in `inbox` and the next tick (which has the context) applies it. Events are
  // at-least-once, and every step below is idempotent.
  type Inbox =
    | { kind: "proposed"; marketId: bigint; outcome: Outcome; proposedAt: bigint }
    | { kind: "disputed"; marketId: bigint; disputer: string; bond: bigint; closedAt: number }
    | { kind: "settled"; marketId: bigint; disputerWon: boolean }
    | { kind: "final"; marketId: bigint };
  const inbox: Inbox[] = [];

  const handlers: EventHandler[] = [
    {
      name: "WatcherProposed",
      kinds: ["ResolutionProposed"],
      async handle(e) {
        const p = e as Of<"ResolutionProposed">;
        inbox.push({ kind: "proposed", marketId: p.marketId, outcome: p.outcome, proposedAt: p.proposedAt });
      },
    },
    {
      name: "WatcherDisputed",
      kinds: ["Disputed"],
      async handle(e) {
        const x = e as Of<"Disputed">;
        inbox.push({ kind: "disputed", marketId: x.marketId, disputer: x.disputer, bond: x.bond, closedAt: x.closedAt });
      },
    },
    {
      name: "WatcherSettled",
      kinds: ["DisputeSettled"],
      async handle(e) {
        const x = e as Of<"DisputeSettled">;
        inbox.push({ kind: "settled", marketId: x.marketId, disputerWon: x.disputerWon });
      },
    },
    {
      name: "WatcherFinal",
      kinds: ["ResolutionFinalized", "MarketResolved"],
      async handle(e) {
        inbox.push({ kind: "final", marketId: (e as Of<"ResolutionFinalized" | "MarketResolved">).marketId });
      },
    },
  ];

  async function drainInbox(ctx: TaskContext): Promise<void> {
    for (const ev of inbox.splice(0)) {
      const key = ev.marketId.toString();
      switch (ev.kind) {
        case "proposed":
          await track(ctx, ev.marketId, ev);
          break;
        case "disputed": {
          ctx.state.delete(TRACKED, key); // finalization is frozen: nothing left to dispute
          const mine = ev.disputer === us();
          const rec = ctx.state.get<DisputeRecord>(DISPUTES, key);
          if (mine) {
            ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: rec?.status === "submitting" || !rec ? "open" : rec.status, bond: ev.bond, openedAt: BigInt(ev.closedAt) });
          } else if (!rec) {
            // Another party disputed first. Not ours to fund; the bond budget is untouched.
            ctx.state.set<DisputeRecord>(DISPUTES, key, { status: "foreign", bond: 0n });
            ctx.log.info("WATCHER_FOREIGN_DISPUTE", { market: ev.marketId, disputer: ev.disputer });
          }
          break;
        }
        case "settled": {
          const rec = ctx.state.get<DisputeRecord>(DISPUTES, key);
          if (rec && (rec.status === "open" || rec.status === "submitting")) ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: "settled", disputerWon: ev.disputerWon });
          break;
        }
        case "final":
          ctx.state.delete(TRACKED, key);
          break;
      }
    }
  }

  /** Re-reads `state()` and the proposal. Returns the proposal to act on, or undefined (and untracks) if there is none. */
  async function fresh(ctx: TaskContext, marketId: bigint, t: TrackedProposal): Promise<TrackedProposal | undefined> {
    const key = marketId.toString();
    const state = await d.adapter.resolutionState(marketId);
    if (state !== "SignersPending") {
      // Disputed (by us or someone else) or final: the window is no longer ours to use.
      ctx.state.delete(TRACKED, key);
      if (state === "Disputed") await adoptDispute(ctx, marketId, t);
      return undefined;
    }
    const proposal = await d.adapter.currentProposal(marketId);
    if (!proposal) {
      ctx.state.delete(TRACKED, key); // cancelled without an event
      ctx.log.info("WATCHER_PROPOSAL_GONE", { market: marketId });
      return undefined;
    }
    if (proposal.outcome !== t.outcome || proposal.proposedAt !== t.proposedAt) {
      await track(ctx, marketId, proposal); // a new round: restart the schedule
      return ctx.state.get<TrackedProposal>(TRACKED, key);
    }
    return t;
  }

  /** The market is Disputed: record it as ours or foreign, from the chain. */
  async function adoptDispute(ctx: TaskContext, marketId: bigint, t: TrackedProposal): Promise<void> {
    const key = marketId.toString();
    const rec = ctx.state.get<DisputeRecord>(DISPUTES, key);
    if (rec && rec.status !== "submitting") return;
    const dispute = await d.adapter.currentDispute(marketId);
    if (!dispute) return;
    if (dispute.disputer === us()) {
      ctx.state.set<DisputeRecord>(DISPUTES, key, {
        ...rec,
        status: "open",
        bond: dispute.bond,
        openedAt: dispute.openedAt,
        escalationTimeout: t.escalationTimeout,
      });
    } else {
      d.budget(ctx.state).release(marketId);
      ctx.state.set<DisputeRecord>(DISPUTES, key, { status: "foreign", bond: 0n });
    }
  }

  async function evaluate(ctx: TaskContext, marketId: bigint, t: TrackedProposal, now: bigint): Promise<void> {
    const key = marketId.toString();
    const deadline = t.proposedAt + t.disputeWindow;
    const secondsLeft = deadline - now;
    const info = await d.marketInfo(marketId);
    const market: WatchedMarket = {
      marketId,
      metaUri: info?.metaUri,
      closeTime: info?.closeTime ?? 0n,
      proposal: { outcome: t.outcome, proposedAt: t.proposedAt },
    };
    const supporting = d.sources.filter((s) => s.supports(market));
    let failed = false;
    const results = await Promise.all(
      supporting.map(async (s) => {
        try {
          return { source: s.name, verdict: await s.determine(market, ctx.signal) };
        } catch (err) {
          failed = true;
          ctx.log.warn("WATCHER_SOURCE_FAILED", { market: marketId, source: s.name, err });
          return { source: s.name, verdict: undefined };
        }
      }),
    );
    const checkpoint: Partial<TrackedProposal> = now >= deadline - 2n * d.policy.minLeadSecs ? { firstDone: true, lateDone: true } : { firstDone: true };
    ctx.state.set<TrackedProposal>(TRACKED, key, { ...t, ...checkpoint, retry: failed });

    const combined = combineVerdicts(results);
    if (combined.kind === "none") {
      ctx.log.info("WATCHER_NO_VERDICT", { market: marketId, sources: supporting.map((s) => s.name) });
      return;
    }
    if (combined.kind === "conflict") {
      d.alert?.("WATCHER_SOURCES_DISAGREE", { market: marketId, verdicts: combined.verdicts.map((v) => ({ source: v.source, outcome: v.verdict.outcome, confidenceBps: v.verdict.confidenceBps })) });
      ctx.log.warn("WATCHER_SOURCES_DISAGREE", { market: marketId });
      return;
    }
    const verdict = combined.verdict;
    if (verdict.outcome === t.outcome) {
      ctx.log.info("WATCHER_AGREES", { market: marketId, outcome: t.outcome, confidenceBps: verdict.confidenceBps });
      return;
    }

    const [position, costBasis, balance] = await Promise.all([
      d.adapter.treasuryPosition(marketId),
      d.adapter.marketSpent(marketId),
      d.adapter.collateralBalance(us()),
    ]);
    const exposure: Exposure = { yes: position.yes, no: position.no, costBasis };
    const available = d.budget(ctx.state).available(balance, nowSecs(ctx));
    const decision = decideDispute({ proposal: t.outcome, verdict, exposure, bond: t.disputeBond, budgetAvailable: available, secondsLeft }, d.policy);
    ctx.log.info("WATCHER_DECISION", { market: marketId, proposal: t.outcome, verdict: verdict.outcome, confidenceBps: verdict.confidenceBps, decision, secondsLeft });
    if (!decision.dispute) {
      if (decision.reason === "BUDGET") d.alert?.("WATCHER_BUDGET_EXHAUSTED", { market: marketId, bond: t.disputeBond, available, balance });
      return;
    }
    await submitDispute(ctx, marketId, t, verdict, exposure, decision, combined.sources);
  }

  async function submitDispute(
    ctx: TaskContext,
    marketId: bigint,
    t: TrackedProposal,
    verdict: OutcomeVerdict,
    exposure: Exposure,
    decision: Extract<DisputeDecision, { dispute: true }>,
    sources: string[],
  ): Promise<void> {
    const key = marketId.toString();
    await ctx.locks.withLock(marketId, async () => {
      if (ctx.signal.aborted || ctx.state.get<DisputeRecord>(DISPUTES, key)) return;
      // Re-read everything the decision rests on, at the latest ledger, just before signing.
      const current = await fresh(ctx, marketId, t);
      if (!current) return;
      const now = await d.adapter.ledgerTime();
      const secondsLeft = current.proposedAt + current.disputeWindow - now;
      if (secondsLeft < d.policy.minLeadSecs) {
        ctx.log.warn("WATCHER_TOO_LATE", { market: marketId, secondsLeft });
        return;
      }

      const trace = buildTrace({
        agent: "trader",
        marketId: Number(marketId),
        action: "other:dispute",
        reasoning:
          `Disputing proposal ${t.outcome} on market ${marketId}: independent sources (${sources.join(", ")}) conclude ${verdict.outcome} ` +
          `at ${verdict.confidenceBps} bps; the treasury stands to protect ${decision.protectedValue} stroops against a ${t.disputeBond} stroop bond.`,
        inputs: {
          proposal: { outcome: t.outcome, proposedAt: t.proposedAt, disputeWindow: t.disputeWindow, secondsLeft },
          verdict,
          sources,
          exposure,
          bond: t.disputeBond,
          protectedValue: decision.protectedValue,
        },
      });
      const { cid } = await d.traceStore.put(trace.hash, trace.json);
      if (live) {
        recordPendingTrace(ctx, { marketId, action: "other:dispute", traceHash: trace.hash, cid });
        await publishPendingTraces(d.adapter, ctx); // the trace goes on-chain before the dispute
      }

      d.budget(ctx.state).commit(marketId, t.disputeBond, nowSecs(ctx));
      ctx.state.set<DisputeRecord>(DISPUTES, key, { status: "submitting", bond: t.disputeBond, escalationTimeout: t.escalationTimeout });
      try {
        const res = await ctx.submit(
          () => d.adapter.dispute({ market_id: marketId, alternative: alternativeFor(verdict.outcome) }),
          `dispute:${key}`,
        );
        if (res.dryRun) {
          d.budget(ctx.state).release(marketId);
          ctx.state.delete(DISPUTES, key);
          ctx.log.info("WATCHER_DISPUTE_DRY_RUN", { market: marketId, res });
          return;
        }
        ctx.state.set<DisputeRecord>(DISPUTES, key, { status: "open", bond: t.disputeBond, txHash: res.txHash, openedAt: now, escalationTimeout: t.escalationTimeout });
        ctx.state.delete(TRACKED, key);
        ctx.log.info("WATCHER_DISPUTED", { market: marketId, bond: t.disputeBond, txHash: res.txHash });
      } catch (err) {
        if (err instanceof NotSubmittedError) {
          // Certainly not on chain: free the bond.
          d.budget(ctx.state).release(marketId);
          if (/DisputeActive/.test(err.message)) {
            // Someone else disputed first: success for our purposes, follow theirs.
            ctx.state.set<DisputeRecord>(DISPUTES, key, { status: "foreign", bond: 0n });
            ctx.state.delete(TRACKED, key);
            ctx.log.info("WATCHER_LOST_RACE", { market: marketId });
            return;
          }
          ctx.state.delete(DISPUTES, key);
          ctx.state.set<TrackedProposal>(TRACKED, key, { ...current, retry: true });
          ctx.log.warn("WATCHER_DISPUTE_REJECTED", { market: marketId, err });
          return;
        }
        // The transaction may have landed: keep the bond committed, record
        // "submitting", and let the next tick reconcile with the chain.
        ctx.log.error("WATCHER_DISPUTE_UNCERTAIN", { market: marketId, err });
        throw err;
      }
    });
  }

  /** One pass over everything we have in flight: reconcile, expire, claim. */
  async function follow(ctx: TaskContext): Promise<void> {
    for (const [key, rec] of ctx.state.entries<DisputeRecord>(DISPUTES)) {
      if (ctx.signal.aborted) return;
      if (rec.status === "claimed" || rec.status === "lost" || rec.status === "foreign") continue;
      const marketId = BigInt(key);
      const dispute = await d.adapter.currentDispute(marketId);

      if (rec.status === "submitting") {
        // Reconcile an uncertain submission against the chain.
        if (dispute && dispute.disputer === us()) {
          ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: "open", openedAt: dispute.openedAt });
        } else if (!dispute) {
          const state = await d.adapter.resolutionState(marketId);
          if (state !== "Disputed") {
            d.budget(ctx.state).release(marketId);
            ctx.state.delete(DISPUTES, key);
          }
        } else {
          d.budget(ctx.state).release(marketId);
          ctx.state.set<DisputeRecord>(DISPUTES, key, { status: "foreign", bond: 0n });
        }
        continue;
      }

      if (!dispute) {
        // The entry is removed once `claim_dispute_bond` ran (by us or anyone).
        // A timeout or a ruling in our favour pays the bond back to us.
        if (rec.status === "settled" || rec.status === "won") {
          if (rec.expired || rec.disputerWon || rec.status === "won") d.budget(ctx.state).resolve(marketId, "refunded");
          else d.budget(ctx.state).resolve(marketId, "forfeited");
          ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: rec.expired || rec.disputerWon || rec.status === "won" ? "claimed" : "lost" });
        }
        continue;
      }

      if (dispute.payee !== undefined) {
        if (dispute.payee === us()) {
          d.budget(ctx.state).resolve(marketId, "refunded");
          ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: "won" });
          await ctx.submit(() => d.adapter.claimDisputeBond(marketId), `claim:${key}`);
          ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: "claimed" });
          ctx.log.info("WATCHER_BOND_CLAIMED", { market: marketId, bond: dispute.bond });
        } else {
          d.budget(ctx.state).resolve(marketId, "forfeited");
          ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: "lost" });
          ctx.log.warn("WATCHER_BOND_FORFEITED", { market: marketId, bond: dispute.bond, payee: dispute.payee });
        }
        continue;
      }

      // Still open: has escalation timed out?
      const timeout = rec.escalationTimeout ?? (await d.adapter.disputableConfig(marketId))?.escalationTimeout;
      if (timeout === undefined || rec.expired) continue;
      const now = await d.adapter.ledgerTime();
      if (now >= dispute.openedAt + timeout) {
        ctx.log.info("WATCHER_EXPIRE_DISPUTE", { market: marketId, openedAt: dispute.openedAt, timeout });
        await ctx.submit(() => d.adapter.expireDispute(marketId), `expire:${key}`);
        ctx.state.set<DisputeRecord>(DISPUTES, key, { ...rec, status: "settled", expired: true, escalationTimeout: timeout });
      }
    }
  }

  /** Finds pending proposals the event stream never delivered (retention gap, restart). */
  async function discover(ctx: TaskContext): Promise<void> {
    if (!d.candidates) return;
    for (const marketId of await d.candidates()) {
      const key = marketId.toString();
      if (ctx.state.get<TrackedProposal>(TRACKED, key) || ctx.state.get<DisputeRecord>(DISPUTES, key)) continue;
      if ((await d.adapter.resolutionState(marketId)) !== "SignersPending") continue;
      const proposal = await d.adapter.currentProposal(marketId);
      if (proposal) await track(ctx, marketId, proposal);
    }
  }

  async function tick(ctx: TaskContext): Promise<void> {
    await drainInbox(ctx);
    await discover(ctx);
    const now = await d.adapter.ledgerTime();
    let firstError: unknown;
    for (const [key, t0] of ctx.state.entries<TrackedProposal>(TRACKED)) {
      if (ctx.signal.aborted) return;
      const marketId = BigInt(key);
      try {
        const t = await fresh(ctx, marketId, t0);
        if (!t) continue;
        const deadline = t.proposedAt + t.disputeWindow;
        if (now >= deadline) {
          ctx.state.delete(TRACKED, key); // window closed; finalize_signers is next
          ctx.log.info("WATCHER_WINDOW_CLOSED", { market: marketId, deadline: secs(deadline) });
          continue;
        }
        const late = now >= deadline - 2n * d.policy.minLeadSecs;
        if (!t.firstDone || (late && !t.lateDone) || t.retry) await evaluate(ctx, marketId, t, now);
      } catch (err) {
        if (err instanceof AbortedError || ctx.signal.aborted) throw err;
        // One market's failure must not stop the others from being checked.
        ctx.log.error("WATCHER_MARKET_FAILED", { market: marketId, err });
        firstError ??= err;
      }
    }
    try {
      await follow(ctx);
    } catch (err) {
      firstError ??= err;
    }
    if (firstError) throw firstError; // let the runtime's backoff and circuit see it
  }

  return { handlers, tick, tracked: (ctx) => ctx.state.entries<TrackedProposal>(TRACKED) };
}

// ─── Task wiring ──────────────────────────────────────────────────────────────

export interface WatcherTaskDeps extends WatcherDeps {
  cfg: Pick<AgentConfig, "network" | "events">;
  adapter: WatcherAdapter & Pick<StellarAdapter, "rpcServer" | "contractIds">;
  rpc?: EventsRpc;
  decoder?: EventDecoder;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * The watcher as a runtime task, with its own EventSubscriber and Dispatcher
 * (and its own checkpoint directory: the trader's follow task polls the same
 * contracts and must not share a cursor). Each tick polls events, then runs
 * {@link Watcher.tick}, whose state polling is the backstop for missed events.
 */
export async function watcherTask(d: WatcherTaskDeps, opts: { intervalMs: number; jitterMs?: number }): Promise<Task & { watcher: Watcher; subscriber: EventSubscriber }> {
  const ids = d.adapter.contractIds();
  const contracts = { market_core: ids.market_core, resolver: ids.resolver, treasury: ids.treasury, reasoning_registry: ids.reasoning_registry };
  const decoder = d.decoder ?? (await EventDecoder.fromBindings(contracts));
  const dir = join(d.cfg.events.stateDir, "watcher");
  const checkpoints = new FileCheckpointStore(dir, { network: d.cfg.network, contractIds: Object.values(contracts) });
  const lru = new ProcessedLru(10_000, (await checkpoints.load()).processed);
  const watcher = createWatcher(d);
  const log = d.log ?? (() => undefined);
  const dispatcher = new Dispatcher({
    lru,
    concurrency: d.cfg.events.concurrency,
    maxAttempts: d.cfg.events.maxAttempts,
    deadLetterPath: join(dir, "dead-letter.jsonl"),
    log,
    handlers: watcher.handlers,
  });
  const subscriber = new EventSubscriber({
    rpc: d.rpc ?? d.adapter.rpcServer(),
    decoder,
    checkpoints,
    pageLimit: d.cfg.events.pageLimit,
    pollIntervalMs: d.cfg.events.pollIntervalMs,
    onBatch: (events) => dispatcher.dispatch(events),
    // Events were lost: the next tick's `candidates` scan rediscovers any
    // pending proposal from the resolver's own state.
    onResync: async (reason) => {
      log("WATCHER_RESYNC", { reason });
    },
    processedIds: () => lru.toJSON(),
    log,
  });
  return {
    name: "watcher",
    mode: d.adapter.mode,
    intervalMs: opts.intervalMs,
    jitterMs: opts.jitterMs,
    watcher,
    subscriber,
    async run(ctx) {
      await subscriber.pollOnce();
      await watcher.tick(ctx);
    },
  };
}
