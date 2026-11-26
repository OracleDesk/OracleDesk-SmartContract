/**
 * Typed decoding of OracleDesk contract events (#105).
 *
 * Every event is decoded with the contract specification embedded in the
 * generated bindings (packages/bindings/*), via the SDK's `Spec.parseEvent`:
 * no XDR layouts are written by hand here. Events this module does not map
 * to a typed variant, and events that do not decode, become `Unknown`.
 */
import type { contract, rpc } from "@stellar/stellar-sdk";
import { fromTraceAction, type TraceActionType } from "../trace.js";

export type ContractName = "market_core" | "resolver" | "treasury" | "reasoning_registry";

/** Binding package per contract; each exports a `Client` carrying the spec. */
export const BINDINGS: Record<ContractName, string> = {
  market_core: "@oracledesk/bindings-market-core",
  resolver: "@oracledesk/bindings-resolver",
  treasury: "@oracledesk/bindings-treasury",
  reasoning_registry: "@oracledesk/bindings-reasoning-registry",
};

export type Side = "Yes" | "No";
/** A resolver's attested outcome: Invalid voids the market. */
export type AttestedOutcome = Side | "Invalid";

export interface EventMeta {
  /** RPC event id; unique and ordered. Used for idempotency. */
  id: string;
  ledger: number;
  /** Ledger close time, unix seconds. */
  closedAt: number;
  txHash: string;
  contract: ContractName;
  contractId: string;
}

export type OracleDeskEvent = EventMeta &
  (
    | {
        kind: "Trade";
        marketId: bigint;
        trader: string;
        outcome: Side;
        isBuy: boolean;
        collateral: bigint;
        shares: bigint;
        fee: bigint;
        reserveYes: bigint;
        reserveNo: bigint;
      }
    | { kind: "MarketCreated"; marketId: bigint; creator: string; closeTime: bigint; seedAmount: bigint; initialYesBps: number }
    /** `outcome` is null when the market resolved void (no winning side). */
    | { kind: "MarketResolved"; marketId: bigint; outcome: Side | null }
    | { kind: "ResolutionProposed"; marketId: bigint; outcome: AttestedOutcome; proposedAt: bigint }
    | { kind: "ResolutionFinalized"; marketId: bigint; outcome: AttestedOutcome; finalizedAt: bigint }
    /** `alternative` is null when the disputer claims the market is invalid. */
    | { kind: "Disputed"; marketId: bigint; disputer: string; bond: bigint; alternative: Side | null }
    /** `verdict` is the escalation ruling; a timeout reports Invalid with `disputerWon` false. */
    | { kind: "DisputeSettled"; marketId: bigint; verdict: AttestedOutcome; disputerWon: boolean; payout: bigint }
    | { kind: "PriceResolution"; marketId: bigint; price: bigint; priceTimestamp: bigint; outcome: Side; fromSnapshot: boolean }
    | { kind: "TracePublished"; traceId: bigint; marketId: bigint; agent: string; action: string; traceHash: string; ipfsCid: string }
    /** Not a typed variant: `name` is the spec event name when it decoded. */
    | { kind: "Unknown"; name?: string; data?: Record<string, unknown> }
  );

export type EventKind = OracleDeskEvent["kind"];

/** The market an event concerns, if any; drives per-market ordering. */
export function marketOf(e: OracleDeskEvent): bigint | undefined {
  return "marketId" in e ? e.marketId : undefined;
}

type Tagged = { tag: string };
const tag = (v: unknown): string => (v as Tagged).tag;
const side = (v: unknown): Side => tag(v) as Side;

/** Decodes raw RPC events with the four contracts' binding specs. */
export class EventDecoder {
  private readonly byId: Map<string, { name: ContractName; spec: contract.Spec }>;

  constructor(contracts: Partial<Record<ContractName, { id: string; spec: contract.Spec }>>) {
    this.byId = new Map(
      (Object.entries(contracts) as [ContractName, { id: string; spec: contract.Spec }][]).map(([name, c]) => [c.id, { name, spec: c.spec }]),
    );
  }

  /** Loads each contract's spec from its generated bindings package. */
  static async fromBindings(ids: Record<ContractName, string>): Promise<EventDecoder> {
    const contracts: Partial<Record<ContractName, { id: string; spec: contract.Spec }>> = {};
    for (const name of Object.keys(BINDINGS) as ContractName[]) {
      const mod = (await import(BINDINGS[name])) as { Client: new (o: unknown) => { spec: contract.Spec } };
      // The spec is embedded in the generated Client; nothing here talks to an RPC.
      const client = new mod.Client({ contractId: ids[name], networkPassphrase: "", rpcUrl: "https://unused.invalid" });
      contracts[name] = { id: ids[name], spec: client.spec };
    }
    return new EventDecoder(contracts);
  }

  contractIds(): string[] {
    return [...this.byId.keys()];
  }

  /** The binding spec used for `name`'s events. */
  spec(name: ContractName): contract.Spec {
    const found = [...this.byId.values()].find((c) => c.name === name);
    if (!found) throw new Error(`no spec loaded for ${name}`);
    return found.spec;
  }

  decode(raw: rpc.Api.EventResponse): OracleDeskEvent | undefined {
    const contractId = raw.contractId?.contractId();
    const known = contractId ? this.byId.get(contractId) : undefined;
    if (!contractId || !known) return undefined;
    const meta: EventMeta = {
      id: raw.id,
      ledger: raw.ledger,
      closedAt: Math.floor(Date.parse(raw.ledgerClosedAt) / 1000),
      txHash: raw.txHash,
      contract: known.name,
      contractId,
    };
    const parsed = known.spec.parseEvent(raw.topic, raw.value);
    if (!parsed) return { ...meta, kind: "Unknown" };
    const d = parsed.data as Record<string, unknown>;
    switch (`${known.name}.${parsed.name}`) {
      case "market_core.Trade":
        return {
          ...meta,
          kind: "Trade",
          marketId: d.market_id as bigint,
          trader: d.trader as string,
          outcome: side(d.outcome),
          isBuy: d.is_buy as boolean,
          collateral: d.collateral as bigint,
          shares: d.shares as bigint,
          fee: d.fee as bigint,
          reserveYes: d.reserve_yes as bigint,
          reserveNo: d.reserve_no as bigint,
        };
      case "market_core.MarketCreated":
        return {
          ...meta,
          kind: "MarketCreated",
          marketId: d.market_id as bigint,
          creator: d.creator as string,
          closeTime: d.close_time as bigint,
          seedAmount: d.seed_amount as bigint,
          initialYesBps: d.initial_yes_bps as number,
        };
      case "market_core.MarketResolved":
        return { ...meta, kind: "MarketResolved", marketId: d.market_id as bigint, outcome: d.outcome == null ? null : side(d.outcome) };
      case "resolver.ResolutionProposedV2":
        return { ...meta, kind: "ResolutionProposed", marketId: d.market_id as bigint, outcome: tag(d.outcome) as AttestedOutcome, proposedAt: d.proposed_at as bigint };
      case "resolver.ResolutionFinalizedV2":
        return { ...meta, kind: "ResolutionFinalized", marketId: d.market_id as bigint, outcome: tag(d.outcome) as AttestedOutcome, finalizedAt: d.finalized_at as bigint };
      case "resolver.Disputed":
        return {
          ...meta,
          kind: "Disputed",
          marketId: d.market_id as bigint,
          disputer: d.disputer as string,
          bond: d.bond as bigint,
          alternative: d.alternative == null ? null : side(d.alternative),
        };
      case "resolver.DisputeSettled":
        return {
          ...meta,
          kind: "DisputeSettled",
          marketId: d.market_id as bigint,
          verdict: tag(d.verdict) as AttestedOutcome,
          disputerWon: d.disputer_won as boolean,
          payout: d.payout as bigint,
        };
      case "resolver.PriceResolution":
      case "resolver.PriceResolutionV2":
        return {
          ...meta,
          kind: "PriceResolution",
          marketId: d.market_id as bigint,
          price: d.price as bigint,
          priceTimestamp: d.price_timestamp as bigint,
          outcome: side(d.outcome),
          fromSnapshot: (d.from_snapshot as boolean | undefined) ?? false,
        };
      case "reasoning_registry.TracePublished":
        return {
          ...meta,
          kind: "TracePublished",
          traceId: d.trace_id as bigint,
          marketId: d.market_id as bigint,
          agent: d.agent as string,
          // The event carries the `TraceAction` enum, not a string.
          action:
            typeof d.action === "object" && d.action !== null && "tag" in d.action
              ? fromTraceAction(d.action as TraceActionType)
              : String(d.action),
          traceHash: Buffer.from(d.trace_hash as Uint8Array).toString("hex"),
          ipfsCid: String(d.ipfs_cid),
        };
      default:
        return { ...meta, kind: "Unknown", name: parsed.name, data: d };
    }
  }
}
