/**
 * Cross-market logical relation schemas, loader, validator, and automatic
 * monotonic-threshold chain discovery (#108).
 */
import { readFileSync } from "node:fs";

export interface ExhaustivePartitionRelation {
  kind: "exhaustive_partition";
  markets: number[];
  label: string;
}

export interface MutuallyExclusiveRelation {
  kind: "mutually_exclusive";
  markets: number[];
  label: string;
}

export interface MonotonicChainEntry {
  marketId: number;
  threshold: bigint;
}

export interface MonotonicChainRelation {
  kind: "monotonic_chain";
  /** Ordered so that entry[i] YES implies entry[i-1] YES (i.e. P(YES_0) >= P(YES_1) >= ...). */
  chain: MonotonicChainEntry[];
  comparison: "Gt" | "Gte" | "Lt" | "Lte";
  asset: string;
}

export type MarketRelation =
  | ExhaustivePartitionRelation
  | MutuallyExclusiveRelation
  | MonotonicChainRelation;

export interface ArbMarketSnapshot {
  marketId: number;
  status: "Open" | "Closed" | "Resolved" | "Voided";
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  closeTime: number;
  priceSpec?: {
    oracle: string;
    asset: string;
    comparison: "Gt" | "Gte" | "Lt" | "Lte";
    threshold: bigint;
  };
}

export class RelationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelationValidationError";
  }
}

export function loadRelations(path: string): MarketRelation[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown[];
  if (!Array.isArray(raw)) {
    throw new RelationValidationError("relations config must be a JSON array");
  }
  return raw.map((item) => {
    const obj = item as Record<string, unknown>;
    if (obj.kind === "exhaustive_partition" || obj.kind === "mutually_exclusive") {
      return {
        kind: obj.kind,
        markets: (obj.markets as number[]).map(Number),
        label: String(obj.label ?? obj.kind),
      };
    }
    if (obj.kind === "monotonic_chain") {
      const chain = (obj.chain as Array<{ marketId: number; threshold: string | number | bigint }>).map(
        (c) => ({
          marketId: Number(c.marketId),
          threshold: BigInt(c.threshold),
        }),
      );
      return {
        kind: "monotonic_chain",
        chain,
        comparison: (obj.comparison as "Gt" | "Gte" | "Lt" | "Lte") ?? "Gt",
        asset: String(obj.asset ?? ""),
      };
    }
    throw new RelationValidationError(`unknown relation kind ${String(obj.kind)}`);
  });
}

/**
 * Validates relations against the active market snapshot and filters out any
 * relation referencing a missing or non-Open market. Throws
 * `RelationValidationError` on structural errors (self-reference, duplicates,
 * fewer than 2 markets, or unsorted monotonic thresholds).
 */
export function validateRelations(
  relations: MarketRelation[],
  marketsById: ReadonlyMap<number, ArbMarketSnapshot>,
): MarketRelation[] {
  const active: MarketRelation[] = [];

  for (const rel of relations) {
    if (rel.kind === "exhaustive_partition" || rel.kind === "mutually_exclusive") {
      if (rel.markets.length < 2) {
        throw new RelationValidationError(`${rel.label}: relation requires at least 2 markets`);
      }
      const seen = new Set<number>();
      for (const id of rel.markets) {
        if (seen.has(id)) {
          throw new RelationValidationError(
            `${rel.label}: duplicate or self-referential market ID ${id}`,
          );
        }
        seen.add(id);
      }
      const allOpen = rel.markets.every((id) => marketsById.get(id)?.status === "Open");
      if (allOpen) active.push(rel);
      continue;
    }

    if (rel.chain.length < 2) {
      throw new RelationValidationError(
        `monotonic_chain(${rel.asset}): requires at least 2 markets`,
      );
    }
    const seen = new Set<number>();
    for (let i = 0; i < rel.chain.length; i++) {
      const entry = rel.chain[i];
      if (seen.has(entry.marketId)) {
        throw new RelationValidationError(
          `monotonic_chain(${rel.asset}): duplicate market ID ${entry.marketId}`,
        );
      }
      seen.add(entry.marketId);
      if (i > 0) {
        const prev = rel.chain[i - 1];
        const isAscending = rel.comparison === "Gt" || rel.comparison === "Gte";
        if (isAscending && entry.threshold <= prev.threshold) {
          throw new RelationValidationError(
            `monotonic_chain(${rel.asset}): Gt/Gte chain must have strictly increasing thresholds`,
          );
        }
        if (!isAscending && entry.threshold >= prev.threshold) {
          throw new RelationValidationError(
            `monotonic_chain(${rel.asset}): Lt/Lte chain must have strictly decreasing thresholds`,
          );
        }
      }
    }
    const allOpen = rel.chain.every((c) => marketsById.get(c.marketId)?.status === "Open");
    if (allOpen) active.push(rel);
  }

  return active;
}

/**
 * Automatically groups open price-mode markets with identical
 * `(oracle, asset, comparison, closeTime)` into monotonic threshold chains.
 *
 * - For `Gt`/`Gte`: sorted by ascending threshold (`K_0 < K_1 < ...`), because
 *   `S_T > K_1 => S_T > K_0`, so `P(YES_0) >= P(YES_1)`.
 * - For `Lt`/`Lte`: sorted by descending threshold (`K_0 > K_1 > ...`), because
 *   `S_T < K_1 => S_T < K_0`, so `P(YES_0) >= P(YES_1)`.
 */
export function discoverMonotonicChains(markets: ArbMarketSnapshot[]): MonotonicChainRelation[] {
  const groups = new Map<string, ArbMarketSnapshot[]>();
  for (const m of markets) {
    if (m.status !== "Open" || !m.priceSpec) continue;
    const key = `${m.priceSpec.oracle}|${m.priceSpec.asset}|${m.priceSpec.comparison}|${m.closeTime}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  const chains: MonotonicChainRelation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const comp = group[0].priceSpec!.comparison;
    const asset = group[0].priceSpec!.asset;
    const sorted = [...group].sort((a, b) => {
      const ta = a.priceSpec!.threshold;
      const tb = b.priceSpec!.threshold;
      if (ta === tb) return a.marketId - b.marketId;
      if (comp === "Gt" || comp === "Gte") {
        return ta < tb ? -1 : 1;
      }
      return ta > tb ? -1 : 1;
    });

    // Deduplicate identical thresholds
    const unique: MonotonicChainEntry[] = [];
    for (const m of sorted) {
      const t = m.priceSpec!.threshold;
      if (unique.length === 0 || unique[unique.length - 1].threshold !== t) {
        unique.push({ marketId: m.marketId, threshold: t });
      }
    }
    if (unique.length >= 2) {
      chains.push({
        kind: "monotonic_chain",
        chain: unique,
        comparison: comp,
        asset,
      });
    }
  }
  return chains;
}
