import {
  Account,
  Address,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import * as contract from "@stellar/stellar-sdk/contract";

const EXECUTION_GRACE = 7 * 86_400;

export interface DecodedEvent {
  name: string;
  data: unknown;
}

export interface DecodedStateChange {
  kind: string;
  key: string;
  before: unknown;
  after: unknown;
}

export interface SimulationSummary {
  returnValue: string;
  events: DecodedEvent[];
  stateChanges: DecodedStateChange[];
  authAddresses: string[];
  authEntries: string[];
}

export interface SimulationResult {
  tx: Transaction;
  sim: rpc.Api.SimulateTransactionSuccessResponse;
  summary: SimulationSummary;
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function invokeTransaction(
  source: Account,
  passphrase: string,
  target: string,
  fn: string,
  args: xdr.ScVal[],
): Transaction {
  return new TransactionBuilder(source, { fee: "100" })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(target).toScAddress(),
            functionName: fn,
            args,
          }),
        ),
        auth: [],
      }),
    )
    .setNetworkPassphrase(passphrase)
    .setTimeout(0)
    .build();
}

function decodeEvents(events: xdr.DiagnosticEvent[], spec: contract.Spec): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const diagnostic of events) {
    const body = diagnostic.event().body();
    if (body.switch().value !== 0) continue;
    const v0 = body.contract();
    try {
      const parsed = spec.parseEvent(v0.topics(), v0.data());
      out.push({ name: parsed?.name ?? "unknown", data: canonical(parsed?.data) });
    } catch {
      out.push({ name: "unknown", data: null });
    }
  }
  return out;
}

function decodeLedgerData(entry: xdr.LedgerEntry | null): unknown {
  if (!entry) return null;
  const data = entry.data();
  if (data.switch().value !== xdr.LedgerEntryType.contractData().value) return data.switch().name ?? data.switch().value;
  try {
    return canonical(scValToNative(data.contractData().val()));
  } catch {
    return data.contractData().val().toXDR("base64");
  }
}

function credentialAddress(credentials: xdr.SorobanCredentials): xdr.ScAddress | undefined {
  const C = xdr.SorobanCredentialsType;
  switch (credentials.switch().value) {
    case C.sorobanCredentialsAddress().value:
      return credentials.address().address();
    case C.sorobanCredentialsAddressV2().value:
      return credentials.addressV2().address();
    case C.sorobanCredentialsAddressWithDelegates().value:
      return credentials.addressWithDelegates().addressCredentials().address();
    default:
      return undefined;
  }
}

function decodeAuth(auth: xdr.SorobanAuthorizationEntry[]): string[] {
  const addresses = new Set<string>();
  for (const entry of auth) {
    const address = credentialAddress(entry.credentials());
    if (address) addresses.add(Address.fromScAddress(address).toString());
  }
  return [...addresses];
}

export function assertTimelockOnlyAuth(summary: SimulationSummary, timelock: string): void {
  const foreign = summary.authAddresses.filter((a) => a !== timelock);
  if (foreign.length > 0) {
    throw new Error(
      `execution needs auth from ${foreign.join(", ")}; only ${timelock} may authorize, so this call would revert after scheduling`,
    );
  }
}

export async function simulateCall(
  server: rpc.Server,
  source: Account,
  passphrase: string,
  target: string,
  fn: string,
  args: xdr.ScVal[],
  spec: contract.Spec,
  authMode: rpc.Api.SimulationAuthMode = "record",
): Promise<SimulationResult> {
  const tx = invokeTransaction(source, passphrase, target, fn, args);
  const sim = await server.simulateTransaction(tx, undefined, authMode);
  if ("error" in sim) throw new Error(`simulation of ${target}.${fn} failed: ${sim.error}`);
  if (!sim.result) throw new Error(`simulation of ${target}.${fn} returned no result`);
  const retval = sim.result.retval;
  let returnValue: string;
  try {
    returnValue = JSON.stringify(canonical(scValToNative(retval)));
  } catch {
    returnValue = retval.toXDR("base64");
  }
  const summary: SimulationSummary = {
    returnValue,
    events: decodeEvents(sim.events, spec),
    stateChanges: (sim.stateChanges ?? []).map((change) => {
      const key = change.key;
      return {
        kind: String((key.switch() as unknown as { name?: string }).name ?? key.switch().value),
        key: key.toXDR("base64"),
        before: decodeLedgerData(change.before),
        after: decodeLedgerData(change.after),
      };
    }),
    authAddresses: decodeAuth(sim.result.auth),
    authEntries: sim.result.auth.map((entry) => entry.toXDR("base64")),
  };
  return { tx, sim, summary };
}

export async function simulateInnerCall(
  server: rpc.Server,
  source: Account,
  passphrase: string,
  timelock: string,
  target: string,
  fn: string,
  args: xdr.ScVal[],
  spec: contract.Spec,
): Promise<SimulationResult> {
  const result = await simulateCall(server, source, passphrase, target, fn, args, spec, "record");
  if (result.sim.result?.retval.switch().value !== xdr.ScValType.scvVoid().value) {
    throw new Error(`${target}.${fn} did not return void during simulation`);
  }
  assertTimelockOnlyAuth(result.summary, timelock);
  return result;
}

export interface SchedulePreview {
  id: string;
  count: string;
  eta: string;
  expires: string;
  sim: SimulationResult;
}

/** Simulates schedule as the proposer and reads the delay the chain will apply. */
export async function previewSchedule(
  server: rpc.Server,
  source: Account,
  passphrase: string,
  timelock: string,
  target: string,
  fn: string,
  args: xdr.ScVal[],
  timelockSpec: contract.Spec,
): Promise<SchedulePreview> {
  const scheduleArgs = [
    new Address(target).toScVal(),
    xdr.ScVal.scvSymbol(fn),
    xdr.ScVal.scvVec(args),
  ];
  const sim = await simulateCall(server, source, passphrase, timelock, "schedule", scheduleArgs, timelockSpec);
  const id = String(canonical(scValToNative(sim.sim.result!.retval)));
  const countResult = await simulateCall(server, source, passphrase, timelock, "operation_count", [], timelockSpec);
  const count = String(canonical(scValToNative(countResult.sim.result!.retval)));
  if (id !== count) throw new Error(`schedule would return id ${id} but operation_count is ${count}; do not propose concurrently`);
  const delayResult = await simulateCall(
    server,
    source,
    passphrase,
    timelock,
    "delay_for",
    [new Address(target).toScVal(), xdr.ScVal.scvSymbol(fn)],
    timelockSpec,
  );
  const delay = BigInt(canonical(scValToNative(delayResult.sim.result!.retval)) as string);
  const ledger = await server.getLatestLedger();
  const now = BigInt(ledger.closeTime ?? Math.floor(Date.now() / 1000));
  const eta = now + delay;
  return { id, count, eta: eta.toString(), expires: (eta + BigInt(EXECUTION_GRACE)).toString(), sim };
}

export function summarizeSimulation(s: SimulationSummary): string {
  return JSON.stringify({
    returnValue: s.returnValue,
    events: s.events,
    stateChanges: s.stateChanges,
    authAddresses: s.authAddresses,
    authEntries: s.authEntries,
  });
}
