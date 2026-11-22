/**
 * Test support for core/events (#105): real XDR events encoded from the
 * binding specs, and a fake `getEvents` RPC with a retention window, cursor
 * pagination and failed-call flags, shaped like the SDK's parsed responses.
 */
import { Contract, StrKey, xdr, type contract, type rpc } from "@stellar/stellar-sdk";
import { EventDecoder, type ContractName } from "./decode.js";
import type { EventsRpc } from "./subscriber.js";

export const IDS: Record<ContractName, string> = {
  market_core: StrKey.encodeContract(Buffer.alloc(32, 1)),
  resolver: StrKey.encodeContract(Buffer.alloc(32, 2)),
  treasury: StrKey.encodeContract(Buffer.alloc(32, 3)),
  reasoning_registry: StrKey.encodeContract(Buffer.alloc(32, 4)),
};

export const TRADER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5));

let decoder: Promise<EventDecoder> | undefined;
export function testDecoder(): Promise<EventDecoder> {
  decoder ??= EventDecoder.fromBindings(IDS);
  return decoder;
}

/** Topics and data for spec event `name`, encoded exactly as the contract would. */
export function encodeEvent(spec: contract.Spec, name: string, values: Record<string, unknown>): { topic: xdr.ScVal[]; value: xdr.ScVal } {
  const event = spec.findEvent(name);
  if (!event) throw new Error(`no event ${name} in spec`);
  const topicParam = (p: xdr.ScSpecEventParamV0) => p.location().value === xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList().value;
  const topic = [
    ...event.prefixTopics().map((t) => xdr.ScVal.scvSymbol(t.toString())),
    ...event.params().filter(topicParam).map((p) => spec.nativeToScVal(values[p.name().toString()], p.type())),
  ];
  const data = event.params().filter((p) => !topicParam(p));
  const format = event.dataFormat().value;
  let value: xdr.ScVal;
  if (format === xdr.ScSpecEventDataFormat.scSpecEventDataFormatMap().value) {
    value = xdr.ScVal.scvMap(
      data
        .map((p) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(p.name().toString()), val: spec.nativeToScVal(values[p.name().toString()], p.type()) }))
        .sort((a, b) => a.key().sym().toString().localeCompare(b.key().sym().toString())),
    );
  } else if (format === xdr.ScSpecEventDataFormat.scSpecEventDataFormatVec().value) {
    value = xdr.ScVal.scvVec(data.map((p) => spec.nativeToScVal(values[p.name().toString()], p.type())));
  } else {
    value = data[0] ? spec.nativeToScVal(values[data[0].name().toString()], data[0].type()) : xdr.ScVal.scvVoid();
  }
  return { topic, value };
}

export interface StoredEvent {
  contract: ContractName;
  name?: string;
  values?: Record<string, unknown>;
  ledger: number;
  successful?: boolean;
  /** Raw topics/data, for events that should not decode. */
  raw?: { topic: xdr.ScVal[]; value: xdr.ScVal };
}

const CLOSE_TIME_0 = 1_700_000_000;

/** In-memory getEvents with RPC semantics: ids order events, cursors resume after an id. */
export class FakeEventsRpc implements EventsRpc {
  latest = 1_000;
  oldest = 1;
  readonly requests: rpc.Server.GetEventsRequest[] = [];
  private readonly events: (rpc.Api.EventResponse & { contractRaw: string })[] = [];
  private perLedger = new Map<number, number>();

  constructor(private readonly specs: Record<ContractName, contract.Spec>) {}

  static async create(): Promise<FakeEventsRpc> {
    const d = await testDecoder();
    const specs = Object.fromEntries((Object.keys(IDS) as ContractName[]).map((n) => [n, d.spec(n)])) as Record<ContractName, contract.Spec>;
    return new FakeEventsRpc(specs);
  }

  spec(name: ContractName): contract.Spec {
    return this.specs[name];
  }

  /** Appends an event; returns its id. */
  emit(e: StoredEvent): string {
    const index = this.perLedger.get(e.ledger) ?? 0;
    this.perLedger.set(e.ledger, index + 1);
    const { topic, value } = e.raw ?? encodeEvent(this.specs[e.contract], e.name!, e.values ?? {});
    const id = `${String(e.ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`;
    this.events.push({
      id,
      type: "contract",
      ledger: e.ledger,
      ledgerClosedAt: new Date((CLOSE_TIME_0 + e.ledger * 5) * 1000).toISOString(),
      transactionIndex: index,
      operationIndex: 0,
      inSuccessfulContractCall: e.successful ?? true,
      txHash: Buffer.alloc(32, e.ledger % 256).toString("hex"),
      contractId: new Contract(IDS[e.contract]),
      contractRaw: IDS[e.contract],
      topic,
      value,
    });
    this.events.sort((a, b) => (a.id < b.id ? -1 : 1));
    this.latest = Math.max(this.latest, e.ledger);
    return id;
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: this.latest };
  }

  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    this.requests.push(request);
    const r = request as { cursor?: string; startLedger?: number; limit?: number; filters: rpc.Api.EventFilter[] };
    if (r.startLedger !== undefined && (r.startLedger < this.oldest || r.startLedger > this.latest + 1)) {
      throw { code: -32600, message: `startLedger must be between the oldest ledger: ${this.oldest} and the latest ledger: ${this.latest}` };
    }
    const ids = new Set(r.filters.flatMap((f) => f.contractIds ?? []));
    const after = (e: { id: string; ledger: number }) => (r.cursor ? e.id > r.cursor : e.ledger >= r.startLedger!);
    const matched = this.events.filter((e) => e.ledger >= this.oldest && after(e) && (ids.size === 0 || ids.has(e.contractRaw)));
    const page = matched.slice(0, r.limit ?? 100);
    const cursor = page.length > 0 ? page.at(-1)!.id : `${String(this.latest).padStart(19, "0")}-9999999999`;
    return {
      latestLedger: this.latest,
      oldestLedger: this.oldest,
      latestLedgerCloseTime: String(CLOSE_TIME_0 + this.latest * 5),
      oldestLedgerCloseTime: String(CLOSE_TIME_0 + this.oldest * 5),
      cursor,
      events: page.map(({ contractRaw: _c, ...e }) => e),
    };
  }
}

export function trade(market: bigint, collateral: bigint, ledger: number, extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    contract: "market_core",
    name: "Trade",
    ledger,
    values: {
      market_id: market,
      trader: TRADER,
      outcome: { tag: "Yes", values: undefined },
      is_buy: true,
      collateral,
      shares: collateral * 2n,
      fee: collateral / 100n,
      reserve_yes: 1_000n,
      reserve_no: 2_000n,
    },
    ...extra,
  };
}
