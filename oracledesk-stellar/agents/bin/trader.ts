#!/usr/bin/env -S npx tsx
/**
 * Trader agent, one shot: reads chain state, compares implied price to a
 * fair-value estimate, and trades the mispricing if the edge clears the
 * configured threshold. Every trade is preceded by a recorded trace.
 *
 * Bounds are never zero: the trade size comes from the strategy, then a
 * fresh `quote_buy` immediately before submission turns into
 * `min_shares_out` (quote minus SLIPPAGE_BPS) and a `limit_price_bps`
 * backstop, plus a `deadline` — so a stale or sandwiched transaction
 * reverts on-chain instead of executing at an arbitrary price.
 *
 * A thin wrapper over the runtime's trader task (runtime/tasks/trader.ts),
 * run exactly once under the single-instance lease; `npm run agentd` runs
 * the same task continuously. Defaults to dry-run. Set AGENT_MODE=live and
 * TRADER_SECRET_KEY (or the shared AGENT_SECRET_KEY) to submit real testnet
 * transactions — see .env.example. Configuration is validated by
 * core/config.ts first; `--print-config` prints it (secret redacted) and
 * exits, `--offline` skips the network probes in dry-run. `--follow` keeps
 * running and reacts to contract events instead (see runtime/follow.ts).
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { redactString } from "../core/redact.js";
import { describeConfig, loadAgentConfig, type AgentConfig, type Tunables } from "../core/config.js";
import type { DueDiligenceVerdict } from "../core/due-diligence.js";
import { LocalTraceStore } from "../core/trace.js";
import { followTask } from "../runtime/follow.js";
import { arbitrageTask } from "../runtime/tasks/arbitrage.js";
import { jsonLogger } from "../runtime/log.js";
import { ConfigError, EXIT_CONFIG, EXIT_TEMPFAIL } from "../runtime/config.js";
import { LeaseHeldError } from "../runtime/lease.js";
import { Runtime } from "../runtime/runtime.js";
import { traderTask } from "../runtime/tasks/trader.js";
import { buildAdapter, createLease, createStateStore, runtimeOptions, traderDeps } from "../runtime/wiring.js";
import type { StellarAdapter } from "../stellar/adapter.js";

/**
 * Exported (and injectable) so tests can drive the whole trade flow with a
 * fake adapter and clock. `now` returns unix seconds. An adapter bound to a
 * deployment reads markets from chain state; one without (a test fake)
 * trades the demo fixture market. `run` is the validated config (or, in
 * tests, `parseTunables(env)`).
 */
export async function main(
  adapter: StellarAdapter,
  run: Tunables,
  now: () => number = () => Math.floor(Date.now() / 1000),
  dueDiligence?: (marketId: bigint) => Promise<DueDiligenceVerdict>,
): Promise<void> {
  const deployments = (adapter as Partial<StellarAdapter>).deployments;
  const runtime = new Runtime({
    tasks: [traderTask(traderDeps(run, adapter, deployments, now, dueDiligence), { intervalMs: 0 }), ...arbTasks(run, adapter, now, 0)],
    state: await createStateStore(adapter.mode, run.env, deployments?.contracts.treasury ?? "unbound"),
    lease: createLease(run.env),
    ...runtimeOptions(run.env),
  });
  await runtime.runOnce();
}

/** The arbitrage task when ARB_ENABLED (#108); see runtime/tasks/arbitrage.ts. */
function arbTasks(run: Tunables, adapter: StellarAdapter, now: () => number, intervalMs: number) {
  if (!run.arb.enabled) return [];
  return [arbitrageTask({ adapter, cfg: run.arb, traceStore: new LocalTraceStore(run.traceStoreDir), nowSecs: now }, { intervalMs })];
}

/**
 * `--follow`: runs until stopped (SIGINT/SIGTERM), re-evaluating only the
 * markets that contract events point at (#105). Without the flag, behaviour
 * is unchanged: one evaluation of every market, then exit.
 */
export async function follow(cfg: AgentConfig, adapter: StellarAdapter, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<number> {
  const log = jsonLogger();
  const task = await followTask({
    cfg,
    adapter,
    trader: traderDeps(cfg, adapter, cfg.deployments, now),
    nowSecs: now,
    log: (event, fields) => log.info(event, fields),
  });
  const runtime = new Runtime({
    tasks: [task, ...arbTasks(cfg, adapter, now, cfg.events.pollIntervalMs)],
    state: await createStateStore(cfg.mode, cfg.env, cfg.deployments.contracts.treasury),
    lease: createLease(cfg.env),
    log,
    ...runtimeOptions(cfg.env),
  });
  const stop = (signal: NodeJS.Signals) => void runtime.stop(signal);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runtime.start();
  return runtime.exitCode;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadAgentConfig({ role: "trader" })
    .then((cfg) => {
      if (cfg.printConfig) {
        console.log(JSON.stringify(describeConfig(cfg), null, 2));
        return;
      }
      console.log(`[trader] mode=${cfg.mode} network=${cfg.network}${process.argv.includes("--follow") ? " follow" : ""}`);
      if (process.argv.includes("--follow")) {
        return follow(cfg, buildAdapter(cfg)).then((code) => {
          process.exitCode = code;
        });
      }
      return main(buildAdapter(cfg), cfg);
    })
    .catch((err) => {
      console.error(redactString(err instanceof Error ? err.message : String(err)));
      process.exit(err instanceof LeaseHeldError ? EXIT_TEMPFAIL : err instanceof ConfigError ? EXIT_CONFIG : 1);
    });
}
