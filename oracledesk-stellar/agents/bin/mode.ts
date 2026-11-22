import { parseAgentMode, type AgentMode } from "../runtime/config.js";

/**
 * Parses and validates an `AGENT_MODE` value (`"dry-run"` or `"live"`).
 * Undefined defaults to `"dry-run"`; any other string (including `""`) throws
 * a `ConfigError` so typos can never silently fall into live execution.
 */
export function parseMode(value: string | undefined): AgentMode {
  return parseAgentMode({ AGENT_MODE: value });
}
