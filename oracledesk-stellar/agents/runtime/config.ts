/** Startup configuration shared by agentd and the one-shot CLIs. */

export type AgentMode = "dry-run" | "live";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Exit codes: 2 = bad configuration, 75 = EX_TEMPFAIL (lease held elsewhere). */
export const EXIT_CONFIG = 2;
export const EXIT_TEMPFAIL = 75;

/**
 * `AGENT_MODE` must be exactly "dry-run" or "live" (unset = "dry-run").
 * Anything else used to fall through to the live path; now it is fatal.
 */
export function parseAgentMode(env: NodeJS.ProcessEnv): AgentMode {
  const raw = env.AGENT_MODE;
  if (raw === undefined || raw === "") return "dry-run";
  if (raw === "dry-run" || raw === "live") return raw;
  throw new ConfigError(`AGENT_MODE must be "dry-run" or "live", got ${JSON.stringify(raw)}`);
}

export function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}, got '${raw}'`);
  return n;
}
