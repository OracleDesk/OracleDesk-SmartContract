#!/usr/bin/env -S npx tsx
/**
 * agentd: runs the maker and trader tasks continuously in one supervised
 * process (see docs/agent-runtime.md).
 *
 *   npm run agentd -- [--once] [--tasks maker,trader] [--config agentd.json]
 *   npm run agentd -- kill --reason operator
 *   npm run agentd -- rearm --operator alice
 *
 * --once     run each enabled task exactly once and exit (the old CLIs)
 * --tasks    comma-separated subset of: maker, trader, guard, watcher (default maker,trader,guard;
 *            the watcher also needs WATCHER_ENABLED=1 and its own WATCHER_SECRET_KEY)
 * --config   JSON object of env-style overrides, e.g. {"TRADER_INTERVAL_MS": "30000"}
 * kill       write the persistent kill marker and signal the daemon's PID
 * rearm      remove the marker after operator approval
 *
 * Exit codes: 0 clean stop, 1 task failure (--once) / circuit open / lease
 * lost / shutdown with submissions in flight, 2 bad configuration, 3 killed,
 * 75 lease held by another live instance (EX_TEMPFAIL), 130 forced by a second
 * SIGINT.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redactString } from "../core/redact.js";
import { ConfigError, EXIT_CONFIG, EXIT_KILLED, EXIT_TEMPFAIL, intEnv, parseAgentMode } from "../runtime/config.js";
import {
  KILL_CODES,
  KilledError,
  KillSwitch,
  killFilePath,
  readLeasePid,
  startOnchainHalt,
  type KillCode,
  type KillReason,
} from "../runtime/kill-switch.js";
import { LeaseHeldError, type Lease } from "../runtime/lease.js";
import { jsonLogger, type Logger } from "../runtime/log.js";
import { Runtime, type Task } from "../runtime/runtime.js";
import type { StateStore } from "../runtime/state.js";
import { guardTask } from "../runtime/tasks/guard.js";
import { makerTask } from "../runtime/tasks/maker.js";
import { traderTask } from "../runtime/tasks/trader.js";
import { inventoryTask } from "../runtime/tasks/inventory.js";
import type { StellarAdapter } from "../stellar/adapter.js";
import { watcherTask } from "../runtime/tasks/watcher.js";
import { loadAgentConfig } from "../core/config.js";
import { buildAdapter, createLease, createStateStore, inventoryDeps, makerDeps, runtimeOptions, traderDeps, traderRiskCheck, watcherDeps } from "../runtime/wiring.js";

export interface AgentdArgs {
  once: boolean;
  tasks: string[];
  tasksExplicit: boolean;
  command?: "kill" | "rearm";
  reason?: KillCode;
  detail?: string;
  operator?: string;
  signal: boolean;
  config?: string;
}

function parseKillCode(value: string | undefined): KillCode {
  const code = (value ?? "").trim();
  if (!(code in KILL_CODES)) throw new ConfigError(`unknown kill reason ${code} (known: ${Object.keys(KILL_CODES).join(", ")})`);
  return code as KillCode;
}

export function parseArgs(argv: string[]): AgentdArgs {
  const args: AgentdArgs = { once: false, tasks: ["maker", "trader", "inventory"], tasksExplicit: false, signal: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--tasks") {
      args.tasks = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      args.tasksExplicit = true;
    } else if (a === "--config") args.config = argv[++i];
    else if (a === "--reason") args.reason = parseKillCode(argv[++i]);
    else if (a === "--detail") args.detail = argv[++i];
    else if (a === "--operator") args.operator = argv[++i];
    else if (a === "--no-signal") args.signal = false;
    else if (!args.command && (a === "kill" || a === "rearm")) args.command = a;
    else throw new ConfigError(`unknown argument ${a}`);
  }
  if (args.tasks.length === 0) throw new ConfigError("--tasks needs at least one task");
  if (args.command === "kill") {
    args.reason ??= "operator";
    args.detail ??= "operator command";
  }
  if (args.command === "rearm" && !args.operator) throw new ConfigError("rearm requires --operator");
  return args;
}

export interface AgentdOverrides {
  /** Task factories by name (tests inject fakes; default: maker, trader, guard). */
  taskFactories?: Record<string, TaskFactory>;
  state?: StateStore;
  lease?: Lease;
  log?: Logger;
  /** Installs SIGINT/SIGTERM handlers (default true outside --once). */
  handleSignals?: boolean;
}

type TaskFactory = (env: NodeJS.ProcessEnv) => Task | Promise<Task>;

/** Each real task validates its own role's config (core/config.ts), including
 * the network probes and mainnet interlock; `scope` records the treasury the
 * state store is keyed by. */
type SendGuard = { check?: () => void | Promise<void> };

function defaultFactories(
  scope: { treasury?: string; adapter?: StellarAdapter },
  sendGuard: SendGuard,
): Record<string, TaskFactory> {
  return {
    maker: async (env) => {
      const cfg = await loadAgentConfig({ role: "maker", env, argv: [] });
      scope.treasury = cfg.deployments.contracts.treasury;
      const adapter = buildAdapter(cfg, sendGuard);
      scope.adapter ??= adapter;
      return makerTask(makerDeps(cfg, adapter, cfg.deployments), {
        intervalMs: intEnv(env, "MAKER_INTERVAL_MS", 5 * 60_000),
        jitterMs: intEnv(env, "MAKER_JITTER_MS", 15_000),
      });
    },
    trader: async (env) => {
      const cfg = await loadAgentConfig({ role: "trader", env, argv: [] });
      scope.treasury = cfg.deployments.contracts.treasury;
      const adapter = buildAdapter(cfg, sendGuard);
      scope.adapter ??= adapter;
      return traderTask(traderDeps(cfg, adapter, cfg.deployments, () => Math.floor(Date.now() / 1000), undefined, traderRiskCheck(adapter)), {
        intervalMs: intEnv(env, "TRADER_INTERVAL_MS", 60_000),
        jitterMs: intEnv(env, "TRADER_JITTER_MS", 5_000),
      });
    },
    inventory: async (env) => {
      const cfg = await loadAgentConfig({ role: "trader", env, argv: [] });
      scope.treasury = cfg.deployments.contracts.treasury;
      const adapter = buildAdapter(cfg, sendGuard);
      scope.adapter ??= adapter;
      return inventoryTask(inventoryDeps(cfg, adapter, cfg.deployments), {
        intervalMs: intEnv(env, "INVENTORY_INTERVAL_MS", 60_000),
        jitterMs: intEnv(env, "INVENTORY_JITTER_MS", 5_000),
      });
    },
    // The proposal watcher (#275): a dedicated key, off unless WATCHER_ENABLED.
    watcher: async (env) => {
      const cfg = await loadAgentConfig({ role: "watcher", env, argv: [] });
      if (!cfg.watcher.enabled) throw new ConfigError("the watcher task needs WATCHER_ENABLED=1");
      scope.treasury ??= cfg.deployments.contracts.treasury;
      return watcherTask(watcherDeps(cfg, buildAdapter(cfg)), { intervalMs: cfg.watcher.intervalMs, jitterMs: 1_000 });
    },
    guard: async (env) => {
      const cfg = await loadAgentConfig({ role: "trader", env, argv: [] });
      scope.treasury = cfg.deployments.contracts.treasury;
      const adapter = buildAdapter(cfg, sendGuard);
      scope.adapter ??= adapter;
      return guardTask(adapter, intEnv(env, "GUARD_INTERVAL_MS", 30_000));
    },
  };
}

/** Runs agentd and resolves with its exit code (never calls process.exit). */
export async function runAgentd(argv: string[], baseEnv: NodeJS.ProcessEnv, o: AgentdOverrides = {}): Promise<number> {
  const log = o.log ?? jsonLogger();
  let runtime!: Runtime;
  let killSwitch!: KillSwitch;
  let args!: AgentdArgs;
  let env!: NodeJS.ProcessEnv;
  let mode!: ReturnType<typeof parseAgentMode>;
  try {
    args = parseArgs(argv);
    const overrides = args.config ? (JSON.parse(readFileSync(args.config, "utf8")) as Record<string, unknown>) : {};
    env = { ...baseEnv, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)])) };
    mode = parseAgentMode(env);
    if (args.command) {
      const state = o.state ?? await createStateStore(mode, env, "agentd");
      const killSwitch = new KillSwitch({ state, file: killFilePath(env), log });
      if (args.command === "kill") {
        const reason: KillReason = { code: args.reason!, detail: args.detail!, at: Date.now() };
        await killSwitch.trip(reason);
        if (args.signal) {
          const pid = readLeasePid(env);
          if (pid === undefined) log.warn("KILL_SIGNAL_NO_PID");
          else {
            try {
              process.kill(pid, "SIGUSR2");
              log.info("KILL_SIGNAL_SENT", { pid });
            } catch (err) {
              log.warn("KILL_SIGNAL_FAILED", { pid, err });
            }
          }
        }
        return EXIT_KILLED;
      }
      await killSwitch.rearm(args.operator!);
      return 0;
    }

    const real: { treasury?: string; adapter?: StellarAdapter } = {};
    const sendGuard: SendGuard = {};
    const factories = o.taskFactories ?? defaultFactories(real, sendGuard);
    const autoGuard = !o.taskFactories && !args.tasksExplicit && args.tasks.includes("maker") && args.tasks.includes("trader");
    const taskNames = autoGuard ? [...args.tasks, "guard"] : args.tasks;
    const tasks = await Promise.all(
      taskNames.map((name) => {
        const make = factories[name];
        if (!make) throw new ConfigError(`unknown task ${name} (known: ${Object.keys(factories).join(", ")})`);
        return make(env);
      }),
    );
    const scope = o.taskFactories ? "agentd" : real.treasury ?? "agentd";
    const state = o.state ?? await createStateStore(mode, env, scope);
    killSwitch = new KillSwitch({
      state,
      file: killFilePath(env),
      log,
      onTrip: (reason) => {
        if (runtime) runtime.kill(reason);
        if (!o.taskFactories) {
          void startOnchainHalt({ state, log, file: killFilePath(env), adapter: () => real.adapter });
        }
      },
    });
    sendGuard.check = async () => {
      const reason = await killSwitch.check();
      if (reason) throw new KilledError(reason);
    };
    runtime = new Runtime({
      tasks,
      state,
      lease: o.lease ?? createLease(env),
      killSwitch,
      log,
      ...runtimeOptions(env),
    });
    log.info("AGENTD_CONFIG", { mode, once: args.once, tasks: taskNames });
  } catch (err) {
    log.error("AGENTD_BAD_CONFIG", { err });
    return EXIT_CONFIG;
  }

  let cleanup: (() => void) | undefined;
  try {
    if (args.once) {
      await runtime.runOnce();
      return runtime.exitCode;
    }
    if (o.handleSignals !== false) {
      cleanup = installSignalHandlers(runtime, log, killSwitch, env);
    }
    await runtime.start();
    return runtime.exitCode;
  } catch (err) {
    if (err instanceof LeaseHeldError) {
      log.error("LEASE_HELD", { holder: err.holder });
      return EXIT_TEMPFAIL;
    }
    log.error("AGENTD_FAILED", { err });
    return 1;
  } finally {
    cleanup?.();
  }
}

function installSignalHandlers(runtime: Runtime, log: Logger, killSwitch: KillSwitch, env: NodeJS.ProcessEnv): () => void {
  let interrupts = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signal === "SIGINT" && ++interrupts > 1) {
      log.error("FORCED_EXIT", { signal, inFlight: runtime.inFlightCount });
      process.exit(130);
    }
    log.info("SIGNAL", { signal });
    void runtime.stop(signal);
  };
  const onKill = () => {
    log.info("KILL_SIGNAL", { file: killFilePath(env) });
    void killSwitch.check();
  };
  const poll = setInterval(() => void killSwitch.check(), 1_000);
  poll.unref();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGUSR2", onKill);
  return () => clearInterval(poll);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runAgentd(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(redactString(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    },
  );
}
