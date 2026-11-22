import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import * as contract from "@stellar/stellar-sdk/contract";
import { assertUnitReturn, encodeCall, type CallIntent } from "./encode.js";
import { hashOperation, setOperationHashHook } from "./hash.js";
import { batchOrder, newDraftId, type ProposalRecord } from "./records.js";
import { assertSpecMatches } from "./spec.js";

const voidType = xdr.ScSpecTypeDef.scSpecTypeVoid();
const resultVoid = {
  switch: () => xdr.ScSpecType.scSpecTypeResult(),
  result: () => ({ okType: () => voidType }),
} as unknown as xdr.ScSpecTypeDef;
const i128Type = xdr.ScSpecTypeDef.scSpecTypeI128();

function fn(outputs: xdr.ScSpecType[]): xdr.ScSpecFunctionV0 {
  return { name: () => "probe", outputs: () => outputs } as unknown as xdr.ScSpecFunctionV0;
}

test("unit and Result<(), E> returns are accepted; i128 is rejected", () => {
  assert.doesNotThrow(() => assertUnitReturn(fn([])));
  assert.doesNotThrow(() => assertUnitReturn(fn([voidType])));
  assert.doesNotThrow(() => assertUnitReturn(fn([resultVoid])));
  assert.throws(() => assertUnitReturn(fn([i128Type])), /unit return/);
});

function input(name: string, type: xdr.ScSpecTypeDef): xdr.ScSpecFunctionInputV0 {
  return { name: () => name, type: () => type } as unknown as xdr.ScSpecFunctionInputV0;
}

function specWith(funcs: Record<string, xdr.ScSpecFunctionV0>): contract.Spec {
  return {
    getFunc: (name: string) => {
      const found = funcs[name];
      if (!found) throw new Error(`no such entry: ${name}`);
      return found;
    },
    funcArgsToScVals: (_name: string, _args: object) => [xdr.ScVal.scvU64(xdr.Uint64.fromString("1"))],
    scValToNative: () => 1n,
  } as unknown as contract.Spec;
}

function intent(fnName: string, args: Record<string, unknown>, target = "CBTC"): CallIntent {
  return {
    network: "testnet",
    timelock: "CTIME",
    target,
    contract: "timelock",
    fn: fnName,
    args,
    title: "test",
    rationale: "test",
  };
}

const delayFn = {
  name: () => "set_default_delay",
  inputs: () => [input("delay", xdr.ScSpecTypeDef.scSpecTypeU64())],
  outputs: () => [voidType],
} as unknown as xdr.ScSpecFunctionV0;
const timelockSpec = specWith({ set_default_delay: delayFn, set_roles: delayFn });

test("wide integers must be decimal strings, not JS numbers", () => {
  assert.throws(() => encodeCall(intent("set_default_delay", { delay: 86400 }), timelockSpec), /decimal string/);
  const encoded = encodeCall(intent("set_default_delay", { delay: "86400" }), timelockSpec);
  assert.equal(encoded.argsXdr.length, 1);
  assert.equal(typeof encoded.echo, "object");
});

test("unknown functions and unsupported self-calls are rejected", () => {
  assert.throws(() => encodeCall(intent("collect_market_fees", {}), timelockSpec), /not exported/);
  assert.throws(
    () => encodeCall(intent("set_default_delay", { delay: "1" }, "CTIME"), timelockSpec),
    /unsupported self-call/,
  );
});

test("spec drift is refused for the same function", () => {
  const a = specWith({ f: { name: () => "f", inputs: () => [input("delay", xdr.ScSpecTypeDef.scSpecTypeU64())], outputs: () => [] } as unknown as xdr.ScSpecFunctionV0 });
  const b = specWith({ f: { name: () => "f", inputs: () => [input("delay", i128Type)], outputs: () => [] } as unknown as xdr.ScSpecFunctionV0 });
  assert.doesNotThrow(() => assertSpecMatches(a, a, "f"));
  assert.throws(() => assertSpecMatches(a, b, "f"), /spec drift/);
});

test("operation hash is deterministic and the hook replaces the preview", () => {
  const input = { target: "CBTC", fn: "f", argsXdr: ["AAA="] };
  assert.equal(hashOperation(input), hashOperation(input));
  setOperationHashHook(() => "on-chain-hash");
  assert.equal(hashOperation(input), "on-chain-hash");
  setOperationHashHook(undefined);
  assert.notEqual(hashOperation(input), "on-chain-hash");
  assert.match(newDraftId(), /^draft-/);
});

test("batch execution follows predecessors", () => {
  const rec = (batchIndex: number, predecessors: number[]): ProposalRecord => ({
    ...({} as ProposalRecord),
    id: String(batchIndex),
    batchIndex,
    predecessors,
  });
  const order = batchOrder([rec(2, [1]), rec(0, []), rec(1, [0])]);
  assert.deepEqual(order.map((r) => r.id), ["0", "1", "2"]);
});
