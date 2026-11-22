#!/usr/bin/env -S npx tsx
/**
 * Market Maker agent, one shot: polls signal sources, decides whether a
 * signal is confident enough to seed a market, builds and records a
 * reasoning trace, and (in "live" mode) creates the market through the
 * treasury. Skips markets whose question_hash already exists on-chain, and
 * signals already processed (live state in AGENT_STATE_PATH).
 *
 * A thin wrapper over the runtime's maker task (runtime/tasks/maker.ts), run
 * exactly once under the single-instance lease; `npm run agentd` runs the
 * same task continuously. Defaults to dry-run. Set AGENT_MODE=live and
 * MAKER_SECRET_KEY (or the shared AGENT_SECRET_KEY) to submit real testnet
 * transactions — see .env.example. Configuration is validated by
 * core/config.ts first; `--print-config` prints it (secret redacted) and
 * exits, `--offline` skips the network probes in dry-run.
 */
import "dotenv/config";
import { redactString } from "../core/redact.js";
import { describeConfig, loadAgentConfig } from "../core/config.js";
import { ConfigError, EXIT_CONFIG, EXIT_TEMPFAIL } from "../runtime/config.js";
import { LeaseHeldError } from "../runtime/lease.js";
import { Runtime } from "../runtime/runtime.js";
import { makerTask } from "../runtime/tasks/maker.js";
import { buildAdapter, createLease, createStateStore, makerDeps, runtimeOptions } from "../runtime/wiring.js";

async function main() {
  const cfg = await loadAgentConfig({ role: "maker" });
  if (cfg.printConfig) {
    console.log(JSON.stringify(describeConfig(cfg), null, 2));
    return;
  }
  const adapter = buildAdapter(cfg);
  console.log(`[market-maker] mode=${cfg.mode} network=${cfg.network}`);
  const runtime = new Runtime({
    tasks: [makerTask(makerDeps(cfg, adapter, cfg.deployments), { intervalMs: 0 })],
    state: await createStateStore(cfg.mode, cfg.env, cfg.deployments.contracts.treasury),
    lease: createLease(cfg.env),
    ...runtimeOptions(cfg.env),
  });
  await runtime.runOnce();
}

main().catch((err) => {
  console.error(redactString(err instanceof Error ? err.message : String(err)));
  process.exit(err instanceof LeaseHeldError ? EXIT_TEMPFAIL : err instanceof ConfigError ? EXIT_CONFIG : 1);
});
