import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  Account,
  Address,
  authorizeEntry,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { CallIntent } from "./encode.js";
import { encodeCall } from "./encode.js";
import { hashOperation } from "./hash.js";
import {
  batchOrder,
  finalizeDraft,
  listRecords,
  loadRecord,
  newDraftId,
  saveRecord,
  type ProposalRecord,
} from "./records.js";
import { specFor, specFromChain, assertSpecMatches, type ContractName } from "./spec.js";
import {
  previewSchedule,
  simulateCall,
  simulateInnerCall,
  summarizeSimulation,
  type DecodedEvent,
} from "./simulate.js";
import * as contract from "@stellar/stellar-sdk/contract";

const EXECUTION_GRACE = 7 * 86_400;
type Flags = Record<string, string | true>;

interface Ctx {
  network: "local" | "testnet";
  timelock: string;
  rpcUrl: string;
  passphrase: string;
  source: string;
  server: rpc.Server;
  timelockSpec: contract.Spec;
}

interface Submitted {
  hash: string;
  events: DecodedEvent[];
}

function parseArgs(argv: string[]): { cmd: string; flags: Flags; positional: string[] } {
  const cmd = argv[0] ?? "help";
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { cmd, flags, positional };
}

function str(flags: Flags, name: string, env?: string): string | undefined {
  const value = flags[name];
  if (typeof value === "string") return value;
  return process.env[env ?? ""];
}

function must(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name} (flag or environment variable)`);
  return value;
}

function jsonInput(value: string): unknown {
  return JSON.parse(value.startsWith("@") ? readFileSync(resolve(value.slice(1)), "utf8") : value);
}

function readIntent(flags: Flags, timelock: string, network: "local" | "testnet"): CallIntent {
  if (typeof flags.intent === "string") {
    return JSON.parse(readFileSync(resolve(flags.intent), "utf8")) as CallIntent;
  }
  const args = jsonInput(must(typeof flags.args === "string" ? flags.args : undefined, "--args"));
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("--args must be a JSON object");
  return {
    network,
    timelock,
    target: must(str(flags, "target"), "--target"),
    contract: must(str(flags, "contract"), "--contract") as ContractName,
    fn: must(str(flags, "fn"), "--fn"),
    args: args as Record<string, unknown>,
    title: str(flags, "title") ?? "untitled governance action",
    rationale: str(flags, "rationale") ?? "",
  };
}

async function context(flags: Flags): Promise<Ctx> {
  const network = (str(flags, "network", "GOVERNANCE_NETWORK") ?? "testnet") as "local" | "testnet";
  if (network !== "local" && network !== "testnet") throw new Error("network must be local or testnet");
  const timelock = must(str(flags, "timelock", "TIMELOCK"), "--timelock / TIMELOCK");
  const rpcUrl =
    str(flags, "rpc", "GOVERNANCE_RPC") ??
    (network === "testnet" ? "https://soroban-testnet.stellar.org" : "http://localhost:8000/soroban/rpc");
  const passphrase =
    str(flags, "passphrase", "GOVERNANCE_PASSPHRASE") ??
    (network === "testnet" ? Networks.TESTNET : "Standalone Network ; February 2017");
  const source = str(flags, "source", "GOVERNANCE_SOURCE") ?? "";
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const timelockSpec = flags.offline === true ? specFor("timelock") : await specFromChain(server, timelock);
  return { network, timelock, rpcUrl, passphrase, source, server, timelockSpec };
}

async function targetSpecs(ctx: Ctx, intent: CallIntent, offline: boolean): Promise<contract.Spec> {
  const local = specFor(intent.contract);
  if (offline) return local;
  const onChain = await specFromChain(ctx.server, intent.target);
  assertSpecMatches(local, onChain, intent.fn);
  if (intent.target === ctx.timelock) {
    assertSpecMatches(specFor("timelock"), ctx.timelockSpec, intent.fn);
  }
  return local;
}

function account(source: string): Account {
  return new Account(source, "0");
}

function contractEvents(events: xdr.ContractEvent[][], spec: contract.Spec): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const group of events) {
    for (const event of group) {
      const body = event.body();
      if (body.switch().value !== 0) continue;
      try {
        const parsed = spec.parseEvent(body.contract().topics(), body.contract().data());
        out.push({ name: parsed?.name ?? "unknown", data: parsed?.data as Record<string, unknown> });
      } catch {
        out.push({ name: "unknown", data: {} });
      }
    }
  }
  return out;
}

async function submitInvocation(
  ctx: Ctx,
  fn: string,
  args: xdr.ScVal[],
  envSecret: string,
  flags: Flags,
): Promise<Submitted> {
  const secret = str(flags, "secret", envSecret);
  const xdrOut = str(flags, "xdr-out");
  if (!secret && !xdrOut) throw new Error(`provide --secret or --xdr-out for ${fn}`);
  const signer = secret ? Keypair.fromSecret(secret) : undefined;
  const source = signer?.publicKey() ?? must(ctx.source, "--source / GOVERNANCE_SOURCE");
  const result = await simulateCall(ctx.server, account(source), ctx.passphrase, ctx.timelock, fn, args, ctx.timelockSpec);
  const builder = rpc.assembleTransaction(result.tx, result.sim) as unknown as {
    operations: Array<{ auth: xdr.SorobanAuthorizationEntry[] }>;
    build(): Transaction;
  };
  if (signer) {
    const ledger = await ctx.server.getLatestLedger();
    const op = builder.operations[0];
    op.auth = await Promise.all(
      op.auth.map((entry) => authorizeEntry(entry, signer, ledger.sequence + 100, ctx.passphrase)),
    );
  }
  const tx = builder.build();
  if (signer) tx.sign(signer);
  if (xdrOut) {
    writeFileSync(resolve(xdrOut), `${tx.toXDR()}\n`);
    console.log(`wrote unsigned/signed XDR to ${xdrOut}`);
    return { hash: "", events: [] };
  }
  const sent = await ctx.server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${fn} was rejected: ${sent.status}`);
  const confirmed = await ctx.server.pollTransaction(sent.hash, { attempts: 10 });
  if (confirmed.status !== "SUCCESS") throw new Error(`${fn} did not succeed: ${confirmed.status}`);
  return { hash: sent.hash, events: contractEvents(confirmed.events.contractEventsXdr, ctx.timelockSpec) };
}

interface OnChainOperation {
  args: xdr.ScVal[];
  eta: bigint;
  expires: bigint;
  fnName: string;
  proposer: string;
  target: string;
}

function scvField(value: xdr.ScVal | undefined, name: string, index?: number): xdr.ScVal | undefined {
  if (!value) return undefined;
  if (value.switch().value === xdr.ScValType.scvMap().value) {
    return value.map()?.find((e) => e.key().sym()?.toString() === name)?.val();
  }
  if (index !== undefined && value.switch().value === xdr.ScValType.scvVec().value) {
    return value.vec()?.[index];
  }
  return undefined;
}

async function readOperation(ctx: Ctx, id: string): Promise<OnChainOperation | undefined> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(ctx.timelock).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Op"), xdr.ScVal.scvU64(xdr.Uint64.fromString(id))]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const { entries } = await ctx.server.getLedgerEntries(key);
  if (entries.length === 0) return undefined;
  const stored = entries[0].val.contractData().val();
  const args = scvField(stored, "args", 0)?.vec() ?? [];
  const eta = scvField(stored, "eta", 1);
  const expires = scvField(stored, "expires", 2);
  if (!eta || !expires) throw new Error(`operation ${id} has an unreadable eta/expires`);
  return {
    args,
    eta: BigInt(scValToNative(eta) as bigint),
    expires: BigInt(scValToNative(expires) as bigint),
    fnName: String(scValToNative(scvField(stored, "fn_name", 3)!)),
    proposer: String(scValToNative(scvField(stored, "proposer", 4)!)),
    target: String(scValToNative(scvField(stored, "target", 5)!)),
  };
}

function decodeArgs(record: ProposalRecord): xdr.ScVal[] {
  return record.argsXdr.map((v) => xdr.ScVal.fromXDR(v, "base64"));
}

async function proposeOne(
  ctx: Ctx,
  intent: CallIntent,
  flags: Flags,
  batch?: { id: string; index: number; predecessors: number[] },
): Promise<ProposalRecord> {
  const offline = flags.offline === true;
  const spec = await targetSpecs(ctx, intent, offline);
  const encoded = encodeCall(intent, spec);
  const inner = await simulateInnerCall(ctx.server, account(must(ctx.source, "--source / GOVERNANCE_SOURCE")), ctx.passphrase, ctx.timelock, intent.target, intent.fn, encoded.argsScVal, spec);
  const preview = offline ? undefined : await previewSchedule(ctx.server, account(ctx.source), ctx.passphrase, ctx.timelock, intent.target, intent.fn, encoded.argsScVal, ctx.timelockSpec);
  const predecessors = batch?.predecessors.map(String);
  const opHash = hashOperation({ target: intent.target, fn: intent.fn, argsXdr: encoded.argsXdr, predecessor: predecessors?.join(",") });
  const draft: ProposalRecord = {
    schema: 1,
    id: newDraftId(),
    network: ctx.network,
    timelock: ctx.timelock,
    title: intent.title,
    intent,
    argsXdr: encoded.argsXdr,
    argsVecXdr: encoded.argsVecXdr,
    argsEcho: encoded.echo,
    simulation: inner.summary,
    status: "draft",
    opHash,
    opHashSource: "local-preview",
    batchId: batch?.id,
    batchIndex: batch?.index,
    predecessors: batch?.predecessors,
  };
  const path = saveRecord(draft);
  console.log(`draft ${path} (${encoded.byteLength} bytes of args)`);
  console.log(JSON.stringify({ echo: encoded.echo, simulation: inner.summary, opHash, eta: preview?.eta }, null, 2));

  if (flags.submit !== true) return draft;
  const scheduleArgs = [
    new Address(intent.target).toScVal(),
    xdr.ScVal.scvSymbol(intent.fn),
    xdr.ScVal.scvVec(encoded.argsScVal),
  ];
  const sent = await submitInvocation(ctx, "schedule", scheduleArgs, "GOVERNANCE_PROPOSER_SECRET", flags);
  if (!sent.hash) return draft;
  const scheduled = sent.events.find((e) => e.name === "OperationScheduled");
  if (!scheduled) throw new Error("no OperationScheduled event found in the schedule transaction");
  const id = String(scheduled.data?.id);
  const onChain = await readOperation(ctx, id);
  if (!onChain) throw new Error(`operation ${id} is not readable after scheduling`);
  const storedXdr = onChain.args.map((v) => v.toXDR("base64"));
  if (JSON.stringify(storedXdr) !== JSON.stringify(encoded.argsXdr)) {
    throw new Error(`scheduled args for ${id} differ from the encoded args; refusing to record the proposal`);
  }
  const record = finalizeDraft(ctx.network, draft.id, id, {
    status: "scheduled",
    eta: onChain.eta.toString(),
    expires: onChain.expires.toString(),
    scheduleTx: sent.hash,
  });
  console.log(`scheduled ${id}: eta=${record.eta} expires=${record.expires}`);
  return record;
}

async function executeOne(ctx: Ctx, id: string, flags: Flags): Promise<void> {
  const record = loadRecord(ctx.network, id);
  const op = await readOperation(ctx, id);
  if (!op) throw new Error(`operation ${id} is no longer pending (expired, executed or cancelled)`);
  if (record.timelock !== ctx.timelock || op.target !== record.intent.target || op.fnName !== record.intent.fn) {
    throw new Error(`operation ${id} does not match its proposal record; refusing to execute`);
  }
  if (JSON.stringify(op.args.map((v) => v.toXDR("base64"))) !== JSON.stringify(record.argsXdr)) {
    throw new Error(`operation ${id} args changed since scheduling; refusing to execute`);
  }
  const now = BigInt((await ctx.server.getLatestLedger()).closeTime ?? Math.floor(Date.now() / 1000));
  if (now < op.eta) throw new Error(`operation ${id} is not due: eta=${op.eta} now=${now}`);
  if (now > op.expires) throw new Error(`operation ${id} expired at ${op.expires}`);
  const spec = await targetSpecs(ctx, record.intent, flags.offline === true);
  const args = decodeArgs(record);
  const fresh = await simulateInnerCall(ctx.server, account(must(ctx.source, "--source / GOVERNANCE_SOURCE")), ctx.passphrase, ctx.timelock, op.target, op.fnName, args, spec);
  if (summarizeSimulation(fresh.summary) !== summarizeSimulation(record.simulation)) {
    console.log("state drift since scheduling:");
    console.log(`  recorded: ${summarizeSimulation(record.simulation)}`);
    console.log(`  current:  ${summarizeSimulation(fresh.summary)}`);
  }
  const check = await simulateCall(ctx.server, account(ctx.source), ctx.passphrase, ctx.timelock, "execute", [xdr.ScVal.scvU64(xdr.Uint64.fromString(id))], ctx.timelockSpec);
  console.log(`execute simulation: ${check.summary.returnValue}`);
  const sent = await submitInvocation(ctx, "execute", [xdr.ScVal.scvU64(xdr.Uint64.fromString(id))], "GOVERNANCE_EXECUTOR_SECRET", flags);
  if (!sent.hash) return;
  finalizeDraft(ctx.network, id, id, { status: "executed", executeTx: sent.hash });
  console.log(`executed ${id}: ${sent.hash}`);
}

async function cancelOne(ctx: Ctx, id: string, flags: Flags): Promise<void> {
  loadRecord(ctx.network, id);
  const args = [xdr.ScVal.scvU64(xdr.Uint64.fromString(id))];
  const sim = await simulateCall(ctx.server, account(must(ctx.source, "--source / GOVERNANCE_SOURCE")), ctx.passphrase, ctx.timelock, "cancel", args, ctx.timelockSpec);
  console.log(`cancel simulation: ${sim.summary.returnValue}`);
  const sent = await submitInvocation(ctx, "cancel", args, "GOVERNANCE_CANCELLER_SECRET", flags);
  if (!sent.hash) return;
  finalizeDraft(ctx.network, id, id, { status: "cancelled", cancelTx: sent.hash });
  console.log(`cancelled ${id}: ${sent.hash}`);
}

async function statusOne(ctx: Ctx, id: string): Promise<void> {
  const record = listRecords(ctx.network).find((r) => r.id === id);
  const op = await readOperation(ctx, id);
  const latest = await ctx.server.getLatestLedger();
  const events = await ctx.server.getEvents({
    filters: [{ type: "contract", contractIds: [ctx.timelock] }],
    startLedger: Math.max(1, latest.sequence - 10_000),
    limit: 1_000,
  });
  const relevant = events.events
    .map((e) => {
      try {
        const parsed = ctx.timelockSpec.parseEvent(e.topic, e.value);
        return { name: parsed?.name ?? "unknown", data: parsed?.data as Record<string, unknown> };
      } catch {
        return { name: "unknown", data: {} };
      }
    })
    .filter(
      (e) =>
        ["OperationScheduled", "OperationExecuted", "OperationCancelled", "OperationExpired", "EmergencyExecuted"].includes(e.name) &&
        (String(e.data?.id) === id || (e.name === "EmergencyExecuted" && record?.intent.target === String(e.data?.target))),
    );
  const state = relevant.find((e) => e.name === "OperationExecuted")?.name
    ?? relevant.find((e) => e.name === "OperationCancelled")?.name
    ?? (!op ? "unknown-or-expired" : BigInt(latest.closeTime ?? 0) > op.expires ? "expired" : BigInt(latest.closeTime ?? 0) >= op.eta ? "ready" : "pending");
  console.log(JSON.stringify({
    id,
    state,
    title: record?.title,
    eta: op?.eta.toString() ?? record?.eta,
    expires: op?.expires.toString() ?? record?.expires,
    warning: op && !record ? "on-chain operation has no local record; the canceller must review it" : undefined,
    scheduleTx: record?.scheduleTx,
    executeTx: record?.executeTx,
    cancelTx: record?.cancelTx,
    events: relevant,
  }, null, 2));
}

interface BatchFile {
  ops: CallIntent[];
  predecessors: Record<string, number[]>;
}

async function emergency(ctx: Ctx, flags: Flags): Promise<void> {
  const intent = readIntent(flags, ctx.timelock, ctx.network);
  console.log("warning: the timelock allow-list matches these function names on ANY target contract");
  if (intent.fn === "set_paused" && intent.args.paused !== true) {
    throw new Error("emergency set_paused is only allowed with paused=true");
  }
  if (intent.fn !== "set_paused" && intent.fn !== "cancel_proposal") {
    throw new Error("emergency allows only set_paused(true) and cancel_proposal");
  }
  const spec = await targetSpecs(ctx, intent, false);
  const encoded = encodeCall(intent, spec);
  const inner = await simulateInnerCall(ctx.server, account(must(ctx.source, "--source / GOVERNANCE_SOURCE")), ctx.passphrase, ctx.timelock, intent.target, intent.fn, encoded.argsScVal, spec);
  console.log(JSON.stringify(inner.summary, null, 2));
  const args = [new Address(intent.target).toScVal(), xdr.ScVal.scvSymbol(intent.fn), xdr.ScVal.scvVec(encoded.argsScVal)];
  const sent = await submitInvocation(ctx, "emergency", args, "GOVERNANCE_EMERGENCY_SECRET", flags);
  if (sent.hash) console.log(`emergency executed: ${sent.hash}`);
}

async function main(): Promise<void> {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  if (cmd === "help") {
    console.log("usage: timelock-cli.ts <encode|simulate|propose|status|list|execute|cancel|emergency> [options]");
    console.log("docs/governance-cli.md has worked examples and environment variables");
    return;
  }
  const ctx = await context(flags);
  switch (cmd) {
    case "encode":
    case "simulate": {
      const intent = readIntent(flags, ctx.timelock, ctx.network);
      const spec = await targetSpecs(ctx, intent, flags.offline === true);
      const encoded = encodeCall(intent, spec);
      const inner = flags.offline === true ? undefined : await simulateInnerCall(ctx.server, account(must(ctx.source, "--source / GOVERNANCE_SOURCE")), ctx.passphrase, ctx.timelock, intent.target, intent.fn, encoded.argsScVal, spec);
      console.log(JSON.stringify({ argsXdr: encoded.argsXdr, argsVecXdr: encoded.argsVecXdr, argsEcho: encoded.echo, bytes: encoded.byteLength, simulation: inner?.summary }, null, 2));
      if (inner && flags.submit !== true) {
        const preview = await previewSchedule(ctx.server, account(ctx.source), ctx.passphrase, ctx.timelock, intent.target, intent.fn, encoded.argsScVal, ctx.timelockSpec);
        console.log(JSON.stringify(preview, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
      }
      return;
    }
    case "propose": {
      if (typeof flags.batch === "string") {
        const file = JSON.parse(readFileSync(resolve(flags.batch), "utf8")) as BatchFile;
        const batchId = str(flags, "batch-id") ?? basename(flags.batch, ".json");
        for (const [i, intent] of file.ops.entries()) {
          try {
            await proposeOne(ctx, { ...intent, network: ctx.network, timelock: ctx.timelock }, flags, { id: batchId, index: i, predecessors: file.predecessors[String(i)] ?? [] });
          } catch (err) {
            console.error(`batch ${batchId} stopped at op ${i}: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
            return;
          }
        }
        return;
      }
      await proposeOne(ctx, readIntent(flags, ctx.timelock, ctx.network), flags);
      return;
    }
    case "status": {
      const id = must(positional[0] ?? str(flags, "id"), "proposal id");
      await statusOne(ctx, id);
      return;
    }
    case "list": {
      console.log(JSON.stringify(listRecords(ctx.network), null, 2));
      return;
    }
    case "execute": {
      if (typeof flags.batch === "string") {
        const file = JSON.parse(readFileSync(resolve(flags.batch), "utf8")) as BatchFile;
        const batchId = str(flags, "batch-id") ?? basename(flags.batch, ".json");
        const records = listRecords(ctx.network).filter((r) => r.batchId === batchId);
        for (const record of batchOrder(records)) {
          try {
            await executeOne(ctx, record.id, flags);
          } catch (err) {
            console.error(`batch ${batchId} stopped at ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
            return;
          }
        }
        return;
      }
      await executeOne(ctx, must(positional[0] ?? str(flags, "id"), "proposal id"), flags);
      return;
    }
    case "cancel": {
      await cancelOne(ctx, must(positional[0] ?? str(flags, "id"), "proposal id"), flags);
      return;
    }
    case "emergency": {
      await emergency(ctx, flags);
      return;
    }
    default:
      throw new Error(`unknown subcommand '${cmd}'`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
