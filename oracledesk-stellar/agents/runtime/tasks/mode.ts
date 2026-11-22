/**
 * The treasury's operating mode as an agent-side gate (#272). Opening new
 * exposure (creating markets, buying) is allowed only in `Normal`; in
 * `AgentsHalted`, `Paused` and `Emergency` the contract would refuse it
 * (`DrawdownTripped`, `Paused`, `EmergencyMode`). Reading the mode once per tick
 * and skipping the work avoids discovering the halt through a failed simulation.
 *
 * Reductions and settlement are not gated here: they follow the contract's own
 * table (`allowed(mode, op)`), and the tasks that do them keep running.
 */
import type { StellarAdapter, TreasuryMode } from "../../stellar/adapter.js";
import type { TaskContext } from "../runtime.js";

type ModeReader = Partial<Pick<StellarAdapter, "treasuryMode">>;

/**
 * True when the task may open positions this tick. An adapter that cannot read
 * the mode (older tests, a deployment that predates #272) is treated as
 * `Normal`, so the contract's own gate stays the backstop.
 */
export async function openingsAllowed(adapter: ModeReader, ctx: TaskContext, task: string): Promise<boolean> {
  if (!adapter.treasuryMode) return true;
  const mode: TreasuryMode = await adapter.treasuryMode();
  if (mode === "Normal") return true;
  ctx.log.info(`${task}_SKIP_MODE`, { mode });
  return false;
}
