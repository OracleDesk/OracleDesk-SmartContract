/**
 * Latent "true probability" processes. Each market carries a latent p_t that
 * informed agents observe with noise; at close the outcome is drawn from the
 * final p_T, or the market is voided with probability `voidRate`. Floats are
 * fine here: p is a model quantity, never a collateral amount.
 */
import type { Rng } from "./rng.js";

export type OutcomeConfig =
  | { kind: "fixed"; p0: P0; voidRate?: number }
  | { kind: "drift"; p0: P0; sigma: number; voidRate?: number }
  | { kind: "jump"; p0: P0; jumpRate: number; jumpSize: number; voidRate?: number };

/** A fixed starting probability, or uniform in [min, max]. */
export type P0 = number | { min: number; max: number };

export type Resolution = "yes" | "no" | "void";

const P_MIN = 0.001;
const P_MAX = 0.999;
const clampP = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export class LatentProcess {
  private x: number;

  /** `rng` must be this market's own stream. */
  constructor(
    private readonly cfg: OutcomeConfig,
    private readonly rng: Rng,
  ) {
    const p0 = typeof cfg.p0 === "number" ? cfg.p0 : cfg.p0.min + rng.float() * (cfg.p0.max - cfg.p0.min);
    this.x = logit(clampP(p0));
  }

  get p(): number {
    return clampP(sigmoid(this.x));
  }

  /** Advances one step. */
  step(): void {
    if (this.cfg.kind === "drift") {
      this.x += this.cfg.sigma * this.rng.normal();
    } else if (this.cfg.kind === "jump" && this.rng.chance(this.cfg.jumpRate)) {
      this.x += this.cfg.jumpSize * this.rng.normal();
    }
    this.x = logit(clampP(sigmoid(this.x)));
  }

  /** Draws the resolution from the current p (call once, at close). */
  resolve(): Resolution {
    if (this.rng.chance(this.cfg.voidRate ?? 0)) return "void";
    return this.rng.chance(this.p) ? "yes" : "no";
  }
}
