/**
 * Fair-value replay for trade traces (#331). Kept out of `trace.ts` so the
 * trace module stays dependency-free (the x402 server compiles it too).
 */
import type { BuyInputs, ReasoningTraceV2, SellInputs } from "./trace.js";
import { priceModel, type PriceModel } from "./strategies/volatility.js";


/**
 * Recomputes a buy/sell trace's fair value from its recorded `model` and
 * returns both numbers. `matches` is false when the recorded bps cannot be
 * reproduced, which means the trace's inputs are incomplete or were edited.
 * Traces without a model (static or external sources) return `undefined`.
 */
export function replayFairValue(
  trace: ReasoningTraceV2,
): { recordedBps: number; replayedBps: number; matches: boolean } | undefined {
  if (trace.action !== "buy" && trace.action !== "sell") return undefined;
  const fv = (trace.inputs as BuyInputs | SellInputs).fairValue;
  if (!fv.model) return undefined;
  const replayedBps = priceModel(fv.model as unknown as PriceModel).fairYesBps;
  return { recordedBps: fv.bps, replayedBps, matches: replayedBps === fv.bps };
}
