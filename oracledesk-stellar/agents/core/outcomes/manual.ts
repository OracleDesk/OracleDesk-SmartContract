/**
 * ManualSource (#275): an operator-maintained `watcher-verdicts.json` for
 * categories with no machine source. Re-read on every call so an operator can
 * add a verdict while a dispute window is open.
 *
 *   { "12": { "outcome": "No", "confidenceBps": 10000, "note": "see ticket" } }
 */
import { readFile } from "node:fs/promises";
import type { AttestedOutcome } from "../events/decode.js";
import type { OutcomeSource, OutcomeVerdict, WatchedMarket } from "./types.js";

export class ManualSource implements OutcomeSource {
  readonly name = "manual";
  constructor(private readonly path: string) {}

  supports(): boolean {
    return true;
  }

  async determine(m: WatchedMarket): Promise<OutcomeVerdict | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const entry = (JSON.parse(raw) as Record<string, { outcome?: string; confidenceBps?: number; note?: string }>)[m.marketId.toString()];
    if (!entry) return undefined;
    const ok = entry.outcome === "Yes" || entry.outcome === "No" || entry.outcome === "Invalid";
    const bps = entry.confidenceBps;
    if (!ok || typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new Error(`${this.path}: invalid verdict for market ${m.marketId}`);
    }
    return { outcome: entry.outcome as AttestedOutcome, confidenceBps: bps, evidence: { file: this.path, note: entry.note ?? null } };
  }
}
