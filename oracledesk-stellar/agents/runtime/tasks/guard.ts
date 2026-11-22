import type { StellarAdapter } from "../../stellar/adapter.js";
import type { Task, TaskContext } from "../runtime.js";

export interface GuardDeps {
  adapter: Pick<StellarAdapter, "mode" | "drawdownStatus">;
}

export async function guardTick(deps: GuardDeps, ctx: TaskContext): Promise<void> {
  const status = await deps.adapter.drawdownStatus();
  ctx.log.info("GUARD_DRAWDOWN", {
    tripped: status.tripped,
    windowPnl: status.windowPnl.toString(),
    maxDrawdown: status.maxDrawdown.toString(),
  });
  if (status.tripped) {
    await ctx.kill({
      code: "drawdown",
      detail: `window pnl ${status.windowPnl} breached max drawdown ${status.maxDrawdown}`,
      at: ctx.now(),
    });
  }
}

export function guardTask(
  deps: GuardDeps,
  opts: { intervalMs: number; jitterMs?: number } = { intervalMs: 30_000 },
): Task {
  return { name: "guard", mode: deps.adapter.mode, ...opts, run: (ctx) => guardTick(deps, ctx) };
}
