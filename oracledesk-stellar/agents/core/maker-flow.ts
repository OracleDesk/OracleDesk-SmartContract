/**
 * The market-maker's commit → persist → create → reveal sequence (ADR 0001,
 * "Agent flow and recovery"). Kept free of CLI wiring so the ordering
 * guarantees — above all "no create before the spec is durably stored" —
 * are unit-testable.
 */
import { NotSubmittedError, type AdapterResult } from "../stellar/adapter.js";
import { validateCloseTime, validateSpec, type SpecJson } from "./spec.js";
import type { SpecHasher } from "./spec-hasher.js";
import { newStoredSpec, revealStored, type RecoveryChain, type SpecStore, type StoredSpec } from "./spec-store.js";

export interface CreateWithSpecArgs {
  spec: SpecJson;
  questionHash: Buffer;
  closeTime: bigint;
  /** Minimum gap past `now + dispute_window` for `closeTime`. */
  closeMarginSecs?: number;
  store: SpecStore;
  hasher: SpecHasher;
  chain: RecoveryChain;
  /** Submits agent_create_market with the given resolution_hash. */
  create: (resolutionHash: Buffer) => Promise<AdapterResult<bigint>>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface CreateWithSpecResult {
  commitment: string;
  entry: StoredSpec;
  create: AdapterResult<bigint>;
  /** Live only: whether the immediate reveal succeeded. When false the
   * entry stays `created` and recovery retries it. */
  revealed?: boolean;
}

export async function createMarketWithSpec(args: CreateWithSpecArgs): Promise<CreateWithSpecResult> {
  const now = args.now ?? Date.now;
  const log = args.log ?? ((m) => console.log(m));

  validateSpec(args.spec);
  validateCloseTime(args.closeTime, Math.floor(now() / 1000), args.spec, args.closeMarginSecs);
  const commitment = await args.hasher.hash(args.spec);

  let entry = newStoredSpec({
    commitment,
    spec: args.spec,
    questionHash: args.questionHash.toString("hex"),
    closeTime: args.closeTime,
    now: now(),
  });
  // Durability barrier: if this throws, no create is ever attempted.
  await args.store.put(entry);

  let create: AdapterResult<bigint>;
  try {
    create = await args.create(Buffer.from(commitment, "hex"));
  } catch (err) {
    if (err instanceof NotSubmittedError) {
      // Rejected before submission (e.g. TradeCapExceeded): no market exists.
      await args.store.put({ ...entry, state: "abandoned", lastError: err.message, updatedAt: now() });
    }
    // Otherwise the create may have landed; leave pending_create for recovery.
    throw err;
  }
  if (create.dryRun) return { commitment, entry, create };

  entry = { ...entry, state: "created", marketId: create.value.toString(), updatedAt: now() };
  await args.store.put(entry);

  try {
    entry = await revealStored(args.store, args.chain, entry, now());
    return { commitment, entry, create, revealed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry = { ...entry, lastError: message, updatedAt: now() };
    await args.store.put(entry);
    log(`[market-maker] reveal for market ${entry.marketId} failed, recovery will retry: ${message}`);
    return { commitment, entry, create, revealed: false };
  }
}
