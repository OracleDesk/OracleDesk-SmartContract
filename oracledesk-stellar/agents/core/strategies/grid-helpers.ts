import assert from "node:assert/strict";
import { comparePrice, rescale, type Direction } from "./grid.js";
import { boundaryFeedUnits } from "./volatility.js";

/** Exhaustively checks `boundaryFeedUnits` against the resolver's own comparison. */
export function boundaryFeedUnitsCheck(): void {
  const dirs: Direction[] = ["Above", "AtOrAbove", "Below", "AtOrBelow"];
  for (const dir of dirs)
    for (const [feedDec, thrDec] of [[7, null], [7, 2], [2, 4], [0, 3]] as [number, number | null][])
      for (const threshold of [0n, 1n, 7n, 19n, 20n, 21n, 123n, 999n]) {
        const b = boundaryFeedUnits(dir, threshold, thrDec, feedDec);
        for (let p = 0n; p < 2_000n; p += 1n) {
          const { price, threshold: t } = thrDec === null ? { price: p, threshold } : rescale(p, feedDec, threshold, thrDec);
          const yes = comparePrice(dir, price, t) === "Yes";
          const predicted = dir === "Above" || dir === "AtOrAbove" ? p >= b : p <= b;
          assert.equal(predicted, yes, `${dir} feed=${feedDec} thr=${thrDec} T=${threshold} p=${p}`);
        }
      }
}
