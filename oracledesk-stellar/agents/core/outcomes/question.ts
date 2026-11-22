/**
 * The machine-readable price question a market's `meta_uri` may declare (#275).
 * Markets whose metadata has no such block are not covered by PriceRuleSource.
 */
export type OracleAsset = { tag: "Stellar" | "Other"; value: string };

export interface PriceQuestion {
  /** Reflector contract the resolution rule reads. */
  reflector: string;
  asset: OracleAsset;
  /** Threshold in the feed's own decimals, a whole-number string. */
  threshold: string;
  direction: "Above" | "AtOrAbove" | "Below" | "AtOrBelow";
  /** Unix seconds. */
  closeTime: number | string;
  /** Seconds a record may lag `closeTime` (the committed `max_staleness`). */
  maxStaleness: number | string;
}

const DIRECTIONS = new Set(["Above", "AtOrAbove", "Below", "AtOrBelow"]);

/** Parses `metadata.price_question`; anything malformed is "no price question". */
export function parsePriceQuestion(raw: unknown): PriceQuestion | undefined {
  const q = (raw as { price_question?: Record<string, unknown> } | undefined)?.price_question;
  if (!q || typeof q !== "object") return undefined;
  const asset = q.asset as { tag?: unknown; value?: unknown } | undefined;
  const whole = (v: unknown) => (typeof v === "string" || typeof v === "number") && /^-?\d+$/.test(String(v));
  if (
    typeof q.reflector !== "string" ||
    !asset ||
    (asset.tag !== "Stellar" && asset.tag !== "Other") ||
    typeof asset.value !== "string" ||
    !whole(q.threshold) ||
    typeof q.direction !== "string" ||
    !DIRECTIONS.has(q.direction) ||
    !whole(q.closeTime) ||
    !whole(q.maxStaleness)
  ) {
    return undefined;
  }
  return {
    reflector: q.reflector,
    asset: { tag: asset.tag, value: asset.value },
    threshold: String(q.threshold),
    direction: q.direction as PriceQuestion["direction"],
    closeTime: String(q.closeTime),
    maxStaleness: String(q.maxStaleness),
  };
}
