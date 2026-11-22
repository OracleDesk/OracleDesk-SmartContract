/**
 * A deterministic fake Soroban RPC (#106): JSON-RPC 2.0 over HTTP, answering
 * with SDK-compatible shapes and real base64 XDR, so the production
 * StellarAdapter and the SDK's contract client run unmodified against it.
 *
 * - Ledger clock: one ledger closes per accepted transaction; tests can
 *   advance it. Close times feed deadlines and market expiry.
 * - Accounts: sequence numbers are enforced (txBAD_SEQ), signatures are
 *   verified (txBAD_AUTH), time bounds are enforced (txTOO_LATE).
 * - Contracts: real WASM served from ledger entries; calls are decoded with
 *   the WASM's spec and executed by the behaviour model (model.ts).
 * - Faults: a FaultPlan injects network, RPC and transaction failures.
 *
 * Every accepted transaction is recorded in `submissions`; `applied` lists
 * the contract calls that actually changed state, which is what the chaos
 * invariants (no double trade, trace for every trade) are checked against.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Address,
  Keypair,
  scValToNative,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { resourceFeeOf, type FeeDistribution, type FeeStatsResponse } from "../../stellar/fees.js";
import type { ContractArtifact, ContractName } from "./artifacts.js";
import { FaultPlan, type Fault, type RpcMethod } from "./faults.js";
import { invoke, isWrite, type ModelEvent, type ModelState } from "./model.js";

export interface LedgerClock {
  sequence: number;
  /** Close time of `sequence`, unix seconds. */
  closeTime: number;
  secsPerLedger: number;
}

export interface Submission {
  hash: string;
  contract: ContractName;
  fn: string;
  args: Record<string, unknown>;
  status: "SUCCESS" | "FAILED";
  ledger: number;
  error?: string;
}

interface TxRecord {
  submission: Submission;
  envelopeXdr: string;
  resultXdr: string;
  resultMetaXdr: string;
  closeTime: number;
  hiddenPolls: number;
  feeCharged: string;
  feeBump: boolean;
}

interface ParsedEnvelope {
  tx: Transaction;
  feeBump?: FeeBumpTransaction;
}

interface StoredEvent {
  ledger: number;
  closeTime: number;
  txHash: string;
  index: number;
  contractId: string;
  event: xdr.ContractEvent;
}

export interface FakeRpcOptions {
  networkPassphrase: string;
  contracts: Record<string, ContractArtifact>;
  accounts: Record<string, bigint>;
  state: ModelState;
  treasuryAddress: string;
  plan?: FaultPlan;
  clock?: Partial<LedgerClock>;
  surge?: { minInclusion: string | number | bigint; ledgers: number };
}

const RESOURCE_FEE = 50_000;
const BASE_FEE = 100;

export class FakeSorobanRpc {
  readonly clock: LedgerClock;
  plan: FaultPlan;
  readonly state: ModelState;
  /** Every request, in order, with the contract function it invoked. */
  readonly requests: { method: string; fn?: string }[] = [];
  /** Transactions the fake accepted for inclusion, in order. */
  readonly submissions: Submission[] = [];
  private readonly txs = new Map<string, TxRecord>();
  private readonly queued = new Map<string, ParsedEnvelope>();
  private readonly events: StoredEvent[] = [];
  private readonly sequences: Map<string, bigint>;
  private readonly ids: Map<string, ContractArtifact>;
  private surge?: { minInclusion: bigint; untilLedger: number };
  private server?: Server;

  constructor(private readonly o: FakeRpcOptions) {
    this.clock = { sequence: 1_000, closeTime: 1_700_000_000, secsPerLedger: 5, ...o.clock };
    this.plan = o.plan ?? FaultPlan.none();
    this.state = o.state;
    this.sequences = new Map(Object.entries(o.accounts));
    this.ids = new Map(Object.entries(o.contracts));
    if (o.surge) this.setSurge(o.surge.minInclusion, o.surge.ledgers);
  }

  get url(): string {
    const addr = this.server?.address() as AddressInfo | undefined;
    if (!addr) throw new Error("fake RPC not started");
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Successful contract calls that changed state, in order. */
  get applied(): Submission[] {
    return this.submissions.filter((s) => s.status === "SUCCESS");
  }

  sequenceOf(account: string): bigint {
    return this.sequences.get(account) ?? 0n;
  }

  advance(ledgers = 1): void {
    this.clock.sequence += ledgers;
    this.clock.closeTime += ledgers * this.clock.secsPerLedger;
  }

  setSurge(minInclusion: string | number | bigint, ledgers: number): void {
    this.surge = { minInclusion: BigInt(minInclusion), untilLedger: this.clock.sequence + ledgers };
  }

  private surgeActive(): boolean {
    return this.surge !== undefined && this.clock.sequence < this.surge.untilLedger;
  }

  private feeDistribution(): FeeDistribution {
    const typical = this.surgeActive() ? this.surge!.minInclusion : BigInt(BASE_FEE);
    const value = typical.toString();
    const high = this.surgeActive() ? (typical * 10n).toString() : "1000";
    return {
      max: high,
      min: "100",
      mode: value,
      p10: "100",
      p20: "100",
      p30: "100",
      p40: "100",
      p50: value,
      p60: value,
      p70: value,
      p80: high,
      p90: high,
      p95: high,
      p99: high,
      transactionCount: "100",
      ledgerCount: 100,
    };
  }

  private getFeeStats(): FeeStatsResponse {
    const distribution = this.feeDistribution();
    return {
      sorobanInclusionFee: distribution,
      inclusionFee: distribution,
      latestLedger: this.clock.sequence,
    };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  // ─── HTTP / JSON-RPC ───────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return this.reply(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const method = body.method as RpcMethod;
    const params = body.params ?? {};
    const fn = this.functionOf(method, params);
    this.requests.push({ method, fn });
    const faults = this.plan.next(method, fn);
    for (const f of faults) if (f.kind === "latency") await sleep(f.ms);
    if (method === "getFeeStats" || method === "sendTransaction") {
      for (const f of faults) {
        if (f.kind === "surge") this.setSurge(f.minInclusion, f.ledgers);
      }
    }
    const fatal = faults.find((f) => f.kind === "timeout" || f.kind === "http" || f.kind === "rpc-error");
    if (fatal?.kind === "timeout") {
      await sleep(fatal.ms);
      req.socket.destroy();
      return;
    }
    if (fatal?.kind === "http") {
      res.writeHead(fatal.status, { "content-type": "text/plain" });
      res.end(`fake RPC: injected HTTP ${fatal.status}`);
      return;
    }
    if (fatal?.kind === "rpc-error") {
      return this.reply(res, 200, { jsonrpc: "2.0", id: body.id ?? 1, error: { code: fatal.code, message: fatal.message } });
    }
    let result: unknown;
    try {
      result = this.dispatch(method, params, faults);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.reply(res, 200, { jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32602, message } });
    }
    if (faults.some((f) => f.kind === "reset-after-accept")) {
      // The transaction is already applied; the client never hears back.
      req.socket.destroy();
      return;
    }
    this.reply(res, 200, { jsonrpc: "2.0", id: body.id ?? 1, result });
  }

  private reply(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  private dispatch(method: RpcMethod, p: Record<string, unknown>, faults: Fault[]): unknown {
    switch (method) {
      case "getHealth":
        return { status: "healthy", latestLedger: this.clock.sequence, oldestLedger: 1, ledgerRetentionWindow: 120_960 };
      case "getNetwork":
        return { passphrase: this.o.networkPassphrase, protocolVersion: 23 };
      case "getLatestLedger":
        return { id: Buffer.alloc(32, this.clock.sequence % 256).toString("hex"), protocolVersion: 23, sequence: this.clock.sequence };
      case "getLedgerEntries":
        return this.getLedgerEntries(p.keys as string[]);
      case "getFeeStats":
        return this.getFeeStats();
      case "simulateTransaction":
        return this.simulate(p.transaction as string, faults);
      case "sendTransaction":
        return this.send(p.transaction as string, faults);
      case "getTransaction":
        return this.getTransaction(p.hash as string);
      case "getEvents":
        return this.getEvents(p);
      default:
        throw new Error(`method ${String(method)} not supported`);
    }
  }

  // ─── Ledger entries ────────────────────────────────────────────────────────

  private getLedgerEntries(keys: string[]) {
    const entries = [];
    for (const raw of keys ?? []) {
      const key = xdr.LedgerKey.fromXDR(raw, "base64");
      const data = this.entryFor(key);
      if (!data) continue;
      entries.push({
        key: raw,
        xdr: data.toXDR("base64"),
        lastModifiedLedgerSeq: 1,
        liveUntilLedgerSeq: this.clock.sequence + 1_000_000,
      });
    }
    return { entries, latestLedger: this.clock.sequence };
  }

  private entryFor(key: xdr.LedgerKey): xdr.LedgerEntryData | undefined {
    switch (key.switch()) {
      case xdr.LedgerEntryType.account(): {
        const id = StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519());
        const seq = this.sequences.get(id);
        if (seq === undefined) return undefined;
        return xdr.LedgerEntryData.account(
          new xdr.AccountEntry({
            accountId: key.account().accountId(),
            balance: xdr.Int64.fromString("100000000000"),
            seqNum: xdr.Int64.fromString(seq.toString()), // SequenceNumber is an Int64 typedef
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 0, 0, 0]),
            signers: [],
            ext: new xdr.AccountEntryExt(0),
          }),
        );
      }
      case xdr.LedgerEntryType.contractData(): {
        const cd = key.contractData();
        if (cd.key().switch() !== xdr.ScValType.scvLedgerKeyContractInstance()) return undefined;
        const id = Address.fromScAddress(cd.contract()).toString();
        const artifact = this.ids.get(id);
        if (!artifact) return undefined;
        return xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: new xdr.ExtensionPoint(0),
            contract: cd.contract(),
            key: cd.key(),
            durability: xdr.ContractDataDurability.persistent(),
            val: xdr.ScVal.scvContractInstance(
              new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(artifact.hash), storage: null }),
            ),
          }),
        );
      }
      case xdr.LedgerEntryType.contractCode(): {
        const hash = key.contractCode().hash();
        const artifact = [...this.ids.values()].find((a) => a.hash.equals(hash));
        if (!artifact) return undefined;
        return xdr.LedgerEntryData.contractCode(
          new xdr.ContractCodeEntry({ ext: new xdr.ContractCodeEntryExt(0), hash, code: artifact.wasm }),
        );
      }
      default:
        return undefined;
    }
  }

  // ─── Contract calls ────────────────────────────────────────────────────────

  private parse(envelope: string): ParsedEnvelope {
    const tx = TransactionBuilder.fromXDR(envelope, this.o.networkPassphrase) as Transaction | FeeBumpTransaction;
    if ("innerTransaction" in tx) return { tx: tx.innerTransaction, feeBump: tx };
    return { tx };
  }

  private inclusionRate(envelope: string, parsed = this.parse(envelope)): bigint {
    const outer = parsed.feeBump ?? parsed.tx;
    return BigInt(outer.fee);
  }

  private feeCharged(parsed: ParsedEnvelope): bigint {
    const resource = resourceFeeOf(parsed.tx);
    const operations = BigInt(parsed.tx.operations.length + (parsed.feeBump ? 1 : 0));
    return BigInt((parsed.feeBump ?? parsed.tx).fee) * operations + resource;
  }

  private callOf(tx: Transaction) {
    const op = tx.operations[0];
    if (!op || op.type !== "invokeHostFunction") throw new Error("only invokeHostFunction transactions are modelled");
    const call = op.func.invokeContract();
    const contractId = Address.fromScAddress(call.contractAddress()).toString();
    const artifact = this.ids.get(contractId);
    if (!artifact) throw new Error(`unknown contract ${contractId}`);
    const fn = call.functionName().toString();
    const inputs = artifact.spec.getFunc(fn).inputs();
    const args: Record<string, unknown> = {};
    call.args().forEach((v, i) => {
      const input = inputs[i];
      if (input) args[input.name().toString()] = artifact.spec.scValToNative(v, input.type());
    });
    return { artifact, contractId, fn, args, call };
  }

  /** The contract function a simulate/send request invokes, for fault matching. */
  private functionOf(method: string, p: Record<string, unknown>): string | undefined {
    if (method !== "simulateTransaction" && method !== "sendTransaction") return undefined;
    try {
      return this.callOf(this.parse(p.transaction as string).tx).fn;
    } catch {
      return undefined;
    }
  }

  private run(state: ModelState, artifact: ContractArtifact, fn: string, args: Record<string, unknown>, closeTime: number) {
    return invoke(state, artifact.name, fn, args, { closeTime: BigInt(closeTime), treasuryAddress: this.o.treasuryAddress });
  }

  private errorCode(artifact: ContractArtifact, name: string): number {
    const code = artifact.errors.get(name);
    if (code === undefined) throw new Error(`fake RPC: ${artifact.name} has no Error::${name} in its spec`);
    return code;
  }

  private returnScVal(artifact: ContractArtifact, fn: string, value: unknown): xdr.ScVal {
    const out = artifact.spec.getFunc(fn).outputs()[0];
    if (!out) return xdr.ScVal.scvVoid();
    const type = out.switch() === xdr.ScSpecType.scSpecTypeResult() ? out.result().okType() : out;
    return artifact.spec.nativeToScVal(value, type);
  }

  private simulate(envelope: string, faults: Fault[]) {
    const { tx } = this.parse(envelope);
    const { artifact, contractId, fn, args, call } = this.callOf(tx);
    const base = { latestLedger: this.clock.sequence, events: [] as string[] };
    const injected = faults.find((f) => f.kind === "contract-error");
    const outcome = injected?.kind === "contract-error"
      ? ({ ok: false, error: injected.error } as const)
      : this.run(structuredClone(this.state), artifact, fn, args, this.clock.closeTime + this.clock.secsPerLedger);
    if (!outcome.ok) {
      return { ...base, error: `HostError: Error(Contract, #${this.errorCode(artifact, outcome.error)})\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:${contractId}, topics:[error, Error(Contract, #${this.errorCode(artifact, outcome.error)})]` };
    }
    const write = isWrite(fn);
    const instance = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({ contract: call.contractAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }),
    );
    const data = new SorobanDataBuilder()
      .setResources(1_000_000, 10_000, write ? 1_000 : 0)
      .setResourceFee(RESOURCE_FEE)
      .setReadOnly(write ? [] : [instance])
      .setReadWrite(write ? [instance] : [])
      .build();
    const auth = write
      ? [
          new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
              function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
              subInvocations: [],
            }),
          }).toXDR("base64"),
        ]
      : [];
    return {
      ...base,
      transactionData: data.toXDR("base64"),
      minResourceFee: String(RESOURCE_FEE),
      results: [{ auth, xdr: this.returnScVal(artifact, fn, outcome.value).toXDR("base64") }],
    };
  }

  private txResult(code: "txSUCCESS" | "txFAILED" | "txBAD_SEQ" | "txTOO_LATE" | "txINSUFFICIENT_FEE" | "txBAD_AUTH", fee: string | number = BASE_FEE): xdr.TransactionResult {
    const R = xdr.TransactionResultResult;
    const result =
      code === "txSUCCESS"
        ? R.txSuccess([xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(Buffer.alloc(32))))])
        : code === "txFAILED"
          ? R.txFailed([xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()))])
          : code === "txBAD_SEQ"
            ? R.txBadSeq()
            : code === "txTOO_LATE"
              ? R.txTooLate()
              : code === "txINSUFFICIENT_FEE"
                ? R.txInsufficientFee()
                : R.txBadAuth();
    return new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString(String(fee)), result, ext: new xdr.TransactionResultExt(0) });
  }

  private rejected(hash: string, code: Parameters<FakeSorobanRpc["txResult"]>[0]) {
    return {
      status: "ERROR",
      hash,
      errorResultXdr: this.txResult(code, 0).toXDR("base64"),
      latestLedger: this.clock.sequence,
      latestLedgerCloseTime: String(this.clock.closeTime),
    };
  }

  private send(envelope: string, faults: Fault[]) {
    const parsed = this.parse(envelope);
    const tx = parsed.tx;
    const outer = parsed.feeBump ?? tx;
    const hash = outer.hash().toString("hex");
    const innerHash = tx.hash().toString("hex");
    const meta = { hash, latestLedger: this.clock.sequence, latestLedgerCloseTime: String(this.clock.closeTime) };
    if (this.txs.has(hash) || (!parsed.feeBump && this.queued.has(innerHash)) || faults.some((f) => f.kind === "duplicate")) {
      return { status: "DUPLICATE", ...meta };
    }
    if (faults.some((f) => f.kind === "try-again-later")) return { status: "TRY_AGAIN_LATER", ...meta };
    const injected = faults.find((f) => f.kind === "tx-error");
    if (injected?.kind === "tx-error") return this.rejected(hash, injected.code);

    const outerSig = outer.signatures[0];
    const outerSource = parsed.feeBump ? parsed.feeBump.feeSource : tx.source;
    if (!outerSig || !Keypair.fromPublicKey(outerSource).verify(outer.hash(), outerSig.signature())) {
      return this.rejected(hash, "txBAD_AUTH");
    }
    const innerSig = tx.signatures[0];
    if (!innerSig || !Keypair.fromPublicKey(tx.source).verify(tx.hash(), innerSig.signature())) {
      return this.rejected(hash, "txBAD_AUTH");
    }
    if (parsed.feeBump && this.txs.has(innerHash)) {
      const existing = this.txs.get(innerHash)!;
      this.txs.set(hash, { ...existing, envelopeXdr: envelope, feeBump: true });
      this.queued.delete(innerHash);
      return { status: "PENDING", ...meta };
    }

    const current = this.sequences.get(tx.source);
    if (current === undefined || BigInt(tx.sequence) !== current + 1n) return this.rejected(hash, "txBAD_SEQ");
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const closeTime = this.clock.closeTime + this.clock.secsPerLedger;
    if (maxTime !== 0 && closeTime > maxTime) return this.rejected(hash, "txTOO_LATE");

    const rate = this.inclusionRate(envelope, parsed);
    if (this.surgeActive() && rate < this.surge!.minInclusion) {
      if (!parsed.feeBump) this.queued.set(innerHash, parsed);
      return { status: "PENDING", ...meta };
    }

    this.sequences.set(tx.source, current + 1n);
    this.queued.delete(innerHash);
    this.advance();
    const { artifact, contractId, fn, args } = this.callOf(tx);
    const divergence = faults.find((f) => f.kind === "apply-failure");
    const work = structuredClone(this.state);
    const outcome = divergence?.kind === "apply-failure"
      ? ({ ok: false, error: divergence.error } as const)
      : this.run(work, artifact, fn, args, this.clock.closeTime);
    const submission: Submission = {
      hash: innerHash,
      contract: artifact.name,
      fn,
      args,
      status: outcome.ok ? "SUCCESS" : "FAILED",
      ledger: this.clock.sequence,
      ...(!outcome.ok && { error: outcome.error }),
    };
    let returnValue: xdr.ScVal | undefined;
    if (outcome.ok) {
      Object.assign(this.state, work);
      returnValue = this.returnScVal(artifact, fn, outcome.value);
      outcome.events.forEach((e, i) => this.recordEvent(e, contractId, innerHash, i));
    }
    this.submissions.push(submission);
    const notFound = faults.find((f) => f.kind === "not-found");
    const feeCharged = this.feeCharged(parsed).toString();
    const record: TxRecord = {
      submission,
      envelopeXdr: tx.toXDR(),
      resultXdr: this.txResult(outcome.ok ? "txSUCCESS" : "txFAILED", feeCharged).toXDR("base64"),
      resultMetaXdr: this.meta(returnValue ?? xdr.ScVal.scvVoid()).toXDR("base64"),
      closeTime: this.clock.closeTime,
      hiddenPolls: notFound?.kind === "not-found" ? notFound.polls : 0,
      feeCharged,
      feeBump: parsed.feeBump !== undefined,
    };
    this.txs.set(innerHash, record);
    if (hash !== innerHash) this.txs.set(hash, { ...record, envelopeXdr: envelope });
    return { status: "PENDING", ...meta };
  }

  private meta(returnValue: xdr.ScVal): xdr.TransactionMeta {
    return new xdr.TransactionMeta(
      3,
      new xdr.TransactionMetaV3({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [new xdr.OperationMeta({ changes: [] })],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMeta({ ext: new xdr.SorobanTransactionMetaExt(0), events: [], returnValue, diagnosticEvents: [] }),
      }),
    );
  }

  private getTransaction(hash: string) {
    const window = {
      latestLedger: this.clock.sequence,
      latestLedgerCloseTime: String(this.clock.closeTime),
      oldestLedger: 1,
      oldestLedgerCloseTime: String(this.clock.closeTime - this.clock.sequence * this.clock.secsPerLedger),
    };
    const tx = this.txs.get(hash);
    if (!tx || tx.hiddenPolls > 0) {
      if (tx) tx.hiddenPolls--;
      return { status: "NOT_FOUND", ...window };
    }
    return {
      status: tx.submission.status,
      ...window,
      ledger: tx.submission.ledger,
      createdAt: String(tx.closeTime),
      applicationOrder: 1,
      feeBump: tx.feeBump,
      feeCharged: tx.feeCharged,
      envelopeXdr: tx.envelopeXdr,
      resultXdr: tx.resultXdr,
      resultMetaXdr: tx.resultMetaXdr,
    };
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  private recordEvent(e: ModelEvent, contractId: string, txHash: string, index: number): void {
    const body = new xdr.ContractEventV0({
      topics: [xdr.ScVal.scvSymbol(e.topic)],
      data: xdr.ScVal.scvMap(
        Object.entries(e.data).map(
          ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: typeof v === "bigint" ? xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString(v.toString()) })) : xdr.ScVal.scvString(String(v)) }),
        ),
      ),
    });
    const event = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: new Address(contractId).toScAddress().contractId(),
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, body),
    });
    this.events.push({ ledger: this.clock.sequence, closeTime: this.clock.closeTime, txHash, index, contractId, event });
  }

  private getEvents(p: Record<string, unknown>) {
    const start = Number(p.startLedger ?? 1);
    const filters = (p.filters as { contractIds?: string[] }[] | undefined) ?? [];
    const ids = filters.flatMap((f) => f.contractIds ?? []);
    const limit = Number((p.pagination as { limit?: number } | undefined)?.limit ?? 100);
    const matched = this.events.filter((e) => e.ledger >= start && (ids.length === 0 || ids.includes(e.contractId))).slice(0, limit);
    return {
      latestLedger: this.clock.sequence,
      oldestLedger: 1,
      cursor: matched.length ? `${matched.at(-1)!.ledger}-${matched.at(-1)!.index}` : "",
      events: matched.map((e) => {
        const v0 = e.event.body().v0();
        return {
          type: "contract",
          ledger: e.ledger,
          ledgerClosedAt: new Date(e.closeTime * 1000).toISOString(),
          contractId: e.contractId,
          id: `${String(e.ledger).padStart(19, "0")}-${String(e.index).padStart(10, "0")}`,
          operationIndex: 0,
          transactionIndex: 0,
          txHash: e.txHash,
          inSuccessfulContractCall: true,
          topic: v0.topics().map((t) => t.toXDR("base64")),
          value: v0.data().toXDR("base64"),
        };
      }),
    };
  }
}

/** Decodes a model value from an event, for test assertions. */
export function eventValue(b64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(b64, "base64"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
