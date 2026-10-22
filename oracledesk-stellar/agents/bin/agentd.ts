#!/usr/bin/env -S npx tsx
/**
 * agentd: runs the maker and trader tasks continuously in one supervised
 * process (see docs/agent-runtime.md).
 *
 *   npm run agentd -- [--once] [--tasks maker,trader] [--config agentd.json]
 *
 * --once     run each enabled task exactly once and exit (the old CLIs)
 * --tasks    comma-separated subset of: maker, trader (default both)
 * --config   JSON object of env-style overrides, e.g. {"TRADER_INTERVAL_MS": "30000"}
 *
 * Exit codes: 0 clean stop, 1 task failure (--once) / circuit open / lease
 * lost / shutdown with submissions in flight, 2 bad configuration, 75 lease
 * held by another live instance (EX_TEMPFAIL), 130 forced by a second SIGINT.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigError, EXIT_CONFIG, EXIT_TEMPFAIL, intEnv, parseAgentMode } from "../runtime/config.js";
import { LeaseHeldError, type Lease } from "../runtime/lease.js";
import { jsonLogger, type Logger } from "../runtime/log.js";
import { Runtime, type Task } from "../runtime/runtime.js";
import type { StateStore } from "../runtime/state.js";
import { makerTask } from "../runtime/tasks/maker.js";
import { traderTask } from "../runtime/tasks/trader.js";
import { buildAdapter, createLease, createStateStore, loadDeployments, makerDeps, runtimeOptions, traderDeps } from "../runtime/wiring.js";

export interface AgentdArgs {
  once: boolean;
  tasks: string[];
  config?: string;
}

export function parseArgs(argv: string[]): AgentdArgs {
  const args: AgentdArgs = { once: false, tasks: ["maker", "trader"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--tasks") args.tasks = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--config") args.config = argv[++i];
    else throw new ConfigError(`unknown argument ${a}`);
  }
  if (args.tasks.length === 0) throw new ConfigError("--tasks needs at least one task");
  return args;
}

export interface AgentdOverrides {
  /** Task factories by name (tests inject fakes; default: maker, trader). */
  taskFactories?: Record<string, (env: NodeJS.ProcessEnv) => Task>;
  state?: StateStore;
  lease?: Lease;
  log?: Logger;
  /** Installs SIGINT/SIGTERM handlers (default true outside --once). */
  handleSignals?: boolean;
}

function defaultFactories(): Record<string, (env: NodeJS.ProcessEnv) => Task> {
  return {
    maker: (env) => {
      const deployments = loadDeployments();
      const adapter = buildAdapter("maker", parseAgentMode(env), env, deployments);
      return makerTask(makerDeps(env, adapter, deployments), {
        intervalMs: intEnv(env, "MAKER_INTERVAL_MS", 5 * 60_000),
        jitterMs: intEnv(env, "MAKER_JITTER_MS", 15_000),
      });
    },
    trader: (env) => {
      const deployments = loadDeployments();
      const adapter = buildAdapter("trader", parseAgentMode(env), env, deployments);
      return traderTask(traderDeps(env, adapter, deployments, () => Math.floor(Date.now() / 1000)), {
        intervalMs: intEnv(env, "TRADER_INTERVAL_MS", 60_000),
        jitterMs: intEnv(env, "TRADER_JITTER_MS", 5_000),
      });
    },
  };
}

/** Runs agentd and resolves with its exit code (never calls process.exit). */
export async function runAgentd(argv: string[], baseEnv: NodeJS.ProcessEnv, o: AgentdOverrides = {}): Promise<number> {
  const log = o.log ?? jsonLogger();
  let runtime!: Runtime;
  let args!: AgentdArgs;
  try {
    args = parseArgs(argv);
    const overrides = args.config ? (JSON.parse(readFileSync(args.config, "utf8")) as Record<string, unknown>) : {};
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)])) };
    const mode = parseAgentMode(env);
    const factories = o.taskFactories ?? defaultFactories();
    const tasks = args.tasks.map((name) => {
      const make = factories[name];
      if (!make) throw new ConfigError(`unknown task ${name} (known: ${Object.keys(factories).join(", ")})`);
      return make(env);
    });
    const scope = o.taskFactories ? "agentd" : loadDeployments().contracts.treasury;
    runtime = new Runtime({
      tasks,
      state: o.state ?? (await createStateStore(mode, env, scope)),
      lease: o.lease ?? createLease(env),
      log,
      ...runtimeOptions(env),
    });
    log.info("AGENTD_CONFIG", { mode, once: args.once, tasks: args.tasks });
  } catch (err) {
    log.error("AGENTD_BAD_CONFIG", { err });
    return EXIT_CONFIG;
  }

  try {
    if (args.once) {
      await runtime.runOnce();
      return runtime.exitCode;
    }
    if (o.handleSignals !== false) installSignalHandlers(runtime, log);
    await runtime.start();
    return runtime.exitCode;
  } catch (err) {
    if (err instanceof LeaseHeldError) {
      log.error("LEASE_HELD", { holder: err.holder });
      return EXIT_TEMPFAIL;
    }
    log.error("AGENTD_FAILED", { err });
    return 1;
  }
}

function installSignalHandlers(runtime: Runtime, log: Logger): void {
  let interrupts = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signal === "SIGINT" && ++interrupts > 1) {
      log.error("FORCED_EXIT", { signal, inFlight: runtime.inFlightCount });
      process.exit(130);
    }
    log.info("SIGNAL", { signal });
    void runtime.stop(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runAgentd(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
