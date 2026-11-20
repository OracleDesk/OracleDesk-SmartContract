import type { Task, TaskContext } from "../runtime.js";

/** Periodic channel balance maintenance and retirement journal task. */
export const channelsTask: Task = {
  name: "channels",
  intervalMs: 10 * 60 * 1000,
  run: async (_ctx: TaskContext): Promise<void> => {
    // Implementation is wired by the runtime once AGENT_CHANNEL_SECRETS is
    // configured. This task intentionally performs no live action in
    // dry-run or missing-channel configurations.
  },
};
