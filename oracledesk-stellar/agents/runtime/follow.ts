/**
 * `trader --follow` (#105): instead of re-evaluating every market on a timer,
 * the trader polls contract events and re-evaluates only the markets the
 * handlers queue. Each tick of the follow task polls once, delivers the
 * events, then runs the normal trader tick restricted to the queued markets.
 *
 * Checkpoints live in EVENTS_STATE_DIR, one file per network and contract set.
 */
import { join } from "node:path";
import type { AgentConfig } from "../core/config.js";
import { priceYesBps } from "../core/fpmm.js";
import { EventDecoder } from "../core/events/decode.js";
import { Dispatcher, ProcessedLru } from "../core/events/dispatch.js";
import { finalityTracker, proposalWatch, resync, tradeReevaluate } from "../core/events/handlers.js";
import { EventSubscriber, FileCheckpointStore, type EventsRpc } from "../core/events/subscriber.js";
import type { StellarAdapter } from "../stellar/adapter.js";
import type { Task, TaskContext } from "./runtime.js";
import { traderTick, type TraderCandidate, type TraderDeps } from "./tasks/trader.js";

export const FINAL = "events.final";

/** Market ids waiting for re-evaluation, deduplicated, in arrival order. */
export class MarketQueue {
  private readonly ids = new Set<bigint>();
  enqueue(id: bigint): void {
    this.ids.add(id);
  }
  drain(): bigint[] {
    const out = [...this.ids];
    this.ids.clear();
    return out;
  }
  get size(): number {
    return this.ids.size;
  }
}

export type FollowAdapter = Pick<
  StellarAdapter,
  "rpcServer" | "contractIds" | "getMarket" | "disputableConfig" | "treasuryPosition" | "resolutionState" | "mode" | "agent" | "quoteBuy" | "agentBuyV2" | "publishTrace"
>;

export interface FollowDeps {
  cfg: Pick<AgentConfig, "network" | "events">;
  adapter: FollowAdapter;
  /** The trader's deps; its `candidates` are filtered to queued markets. */
  trader: TraderDeps;
  rpc?: EventsRpc;
  decoder?: EventDecoder;
  nowSecs: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export async function followTask(d: FollowDeps): Promise<Task & { queue: MarketQueue; subscriber: EventSubscriber }> {
  const ids = d.adapter.contractIds();
  const contracts = { market_core: ids.market_core, resolver: ids.resolver, treasury: ids.treasury, reasoning_registry: ids.reasoning_registry };
  const decoder = d.decoder ?? (await EventDecoder.fromBindings(contracts));
  const checkpoints = new FileCheckpointStore(d.cfg.events.stateDir, { network: d.cfg.network, contractIds: Object.values(contracts) });
  const lru = new ProcessedLru(10_000, (await checkpoints.load()).processed);
  const queue = new MarketQueue();
  const log = d.log ?? (() => undefined);
  let ctx: TaskContext | undefined;

  const readMarket = async (marketId: bigint) => {
    const m = await d.adapter.getMarket(marketId);
    if (!m) return undefined;
    return { marketId, open: m.status === "Open" && m.closeTime > BigInt(d.nowSecs()), yesBps: Number(priceYesBps(m.reserveYes, m.reserveNo)) };
  };

  const dispatcher = new Dispatcher({
    lru,
    concurrency: d.cfg.events.concurrency,
    maxAttempts: d.cfg.events.maxAttempts,
    deadLetterPath: join(d.cfg.events.stateDir, "dead-letter.jsonl"),
    log,
    handlers: [
      tradeReevaluate({ threshold: d.cfg.events.tradeThresholdStroops, readMarket, enqueue: (id) => queue.enqueue(id), log }),
      proposalWatch({
        exposure: async (id) => {
          const p = await d.adapter.treasuryPosition(id);
          return p.yes + p.no;
        },
        proposalState: (id) => d.adapter.resolutionState(id),
        // The market's committed window (resolver `Disputable(id)`); the config
        // constant is only the fallback for a market that does not expose one.
        disputeWindowSecs: async (id) => (await d.adapter.disputableConfig(id))?.disputeWindow ?? BigInt(d.cfg.events.disputeWindowSecs),
        alert: (a) => log("PROPOSAL_ALERT", { ...a }),
      }),
      finalityTracker({
        markFinal: (id, via) => {
          ctx?.state.set(FINAL, id.toString(), { via, at: d.nowSecs() });
          log("MARKET_FINAL", { market: id, via });
        },
      }),
    ],
  });

  const subscriber = new EventSubscriber({
    rpc: d.rpc ?? d.adapter.rpcServer(),
    decoder,
    checkpoints,
    pageLimit: d.cfg.events.pageLimit,
    pollIntervalMs: d.cfg.events.pollIntervalMs,
    onBatch: (events) => dispatcher.dispatch(events),
    // Events were lost: re-evaluate every market the trader could trade.
    onResync: resync({
      reloadAll: async () => {
        for (const c of await d.trader.candidates()) queue.enqueue(BigInt(c.market.marketId));
      },
      log,
    }),
    processedIds: () => lru.toJSON(),
    log,
  });

  return {
    name: "trader",
    mode: d.adapter.mode,
    intervalMs: d.cfg.events.pollIntervalMs,
    queue,
    subscriber,
    async run(c) {
      ctx = c;
      await subscriber.pollOnce();
      const wanted = new Set(queue.drain().map(String));
      if (wanted.size === 0) return;
      const candidates = async (): Promise<TraderCandidate[]> =>
        (await d.trader.candidates()).filter((x) => wanted.has(String(x.market.marketId)));
      await traderTick({ ...d.trader, candidates }, c);
    },
  };
}
