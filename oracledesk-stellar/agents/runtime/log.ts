/** One structured JSON log line per event (`{ts, level, event, ...fields}`). */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v instanceof Error ? { name: v.name, message: v.message } : v;

export function jsonLogger(write: (line: string) => void = (l) => console.log(l), base: LogFields = {}): Logger {
  const emit = (level: string) => (event: string, fields: LogFields = {}) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields }, replacer));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** Collects entries in memory; for tests. */
export function memoryLogger(): Logger & { entries: { level: string; event: string; fields: LogFields }[] } {
  const entries: { level: string; event: string; fields: LogFields }[] = [];
  const push = (level: string) => (event: string, fields: LogFields = {}) => entries.push({ level, event, fields });
  return { entries, info: push("info"), warn: push("warn"), error: push("error") };
}
