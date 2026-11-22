import { xdr } from "@stellar/stellar-sdk";
import * as contract from "@stellar/stellar-sdk/contract";
import type { ContractName } from "./spec.js";

export interface CallIntent {
  network: "local" | "testnet";
  timelock: string;
  target: string;
  contract: ContractName;
  fn: string;
  args: Record<string, unknown>;
  title: string;
  rationale: string;
}

export interface EncodedCall {
  argsScVal: xdr.ScVal[];
  argsXdr: string[];
  argsVecXdr: string;
  echo: unknown;
  byteLength: number;
}

const T = xdr.ScSpecType;

function wide(type: xdr.ScSpecTypeDef): boolean {
  const v = type.switch().value;
  return (
    v === T.scSpecTypeU64().value ||
    v === T.scSpecTypeI64().value ||
    v === T.scSpecTypeU128().value ||
    v === T.scSpecTypeI128().value ||
    v === T.scSpecTypeU256().value ||
    v === T.scSpecTypeI256().value ||
    v === T.scSpecTypeTimepoint().value ||
    v === T.scSpecTypeDuration().value
  );
}

/** 64/128-bit values must be decimal strings, never JS numbers. */
function checkValue(value: unknown, type: xdr.ScSpecTypeDef, path: string, spec: contract.Spec, seen: Set<string>): void {
  const v = type.switch().value;
  if (v === T.scSpecTypeOption().value) {
    if (value === undefined) throw new Error(`${path}: optional field is missing; pass null explicitly`);
    if (value !== null) checkValue(value, type.option().valueType(), path, spec, seen);
    return;
  }
  if (value === undefined) return;
  if (wide(type)) {
    if (typeof value === "number" || typeof value === "bigint") {
      throw new Error(`${path}: use a decimal string for 64/128-bit values, not a JS ${typeof value}`);
    }
    return;
  }
  if (v === T.scSpecTypeVec().value) {
    if (Array.isArray(value)) {
      value.forEach((item, i) => checkValue(item, type.vec().elementType(), `${path}[${i}]`, spec, seen));
    }
    return;
  }
  if (v === T.scSpecTypeTuple().value) {
    if (Array.isArray(value)) {
      type.tuple().valueTypes().forEach((t, i) => checkValue(value[i], t, `${path}[${i}]`, spec, seen));
    }
    return;
  }
  if (v === T.scSpecTypeMap().value) {
    const pairs: unknown[] = value instanceof Map ? [...value.entries()] : Array.isArray(value) ? value : [];
    pairs.forEach((pair, i) => {
      const [k, val] = pair as [unknown, unknown];
      checkValue(k, type.map().keyType(), `${path}[${i}].key`, spec, seen);
      checkValue(val, type.map().valueType(), `${path}[${i}].value`, spec, seen);
    });
    return;
  }
  if (v === T.scSpecTypeResult().value) {
    checkValue(value, type.result().okType(), path, spec, seen);
    return;
  }
  if (v === T.scSpecTypeUdt().value) {
    const name = type.udt().name().toString();
    if (seen.has(name)) return;
    seen.add(name);
    const entry = spec.findEntry(name);
    if (entry.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtStructV0().value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const obj = value as Record<string, unknown>;
      for (const field of entry.udtStructV0().fields()) {
        checkValue(obj[field.name().toString()], field.type(), `${path}.${field.name().toString()}`, spec, seen);
      }
    } else if (entry.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtUnionV0().value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const tag = (value as { tag?: unknown }).tag;
      for (const c of entry.udtUnionV0().cases()) {
        if (c.switch().value !== xdr.ScSpecUdtUnionCaseV0Kind.scSpecUdtUnionCaseTupleV0().value) continue;
        const tuple = c.tupleCase();
        if (tuple.name().toString() !== tag) continue;
        const values = (value as { values?: unknown[] }).values ?? [];
        tuple.type().forEach((t, i) => checkValue(values[i], t, `${path}.${tag}[${i}]`, spec, seen));
      }
    }
  }
}

function typeName(type: xdr.ScSpecType): string {
  return String((type as unknown as { name?: string }).name ?? type.value);
}

/** `execute` invokes the target as `()` internally: only unit returns can be scheduled. */
export function assertUnitReturn(fn: xdr.ScSpecFunctionV0): void {
  const outputs = fn.outputs();
  if (outputs.length === 0) return;
  if (outputs.length === 1) {
    const out = outputs[0];
    if (out.switch().value === T.scSpecTypeVoid().value) return;
    if (out.switch().value === T.scSpecTypeResult().value && out.result().okType().switch().value === T.scSpecTypeVoid().value) return;
  }
  throw new Error(
    `refusing to schedule '${fn.name().toString()}': timelock requires a unit return, got ${outputs.map((o) => typeName(o.switch())).join(", ") || "none"}`,
  );
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function encodeCall(
  intent: CallIntent,
  spec: contract.Spec,
  maxArgsBytes = Number(process.env.GOVERNANCE_MAX_ARGS_BYTES ?? 16_384),
): EncodedCall {
  let fn: xdr.ScSpecFunctionV0;
  try {
    fn = spec.getFunc(intent.fn);
  } catch {
    throw new Error(`'${intent.fn}' is not exported by the ${intent.contract} spec`);
  }
  assertUnitReturn(fn);
  if (intent.target === intent.timelock && intent.fn !== "set_default_delay") {
    throw new Error("unsupported self-call: a timelock can only execute set_default_delay on itself");
  }

  for (const input of fn.inputs()) {
    const name = input.name().toString();
    if (!(name in intent.args)) {
      if (input.type().switch().value === T.scSpecTypeOption().value) {
        throw new Error(`${intent.fn}: optional field '${name}' is missing; pass null explicitly`);
      }
      throw new Error(`${intent.fn}: missing argument '${name}'`);
    }
    checkValue(intent.args[name], input.type(), name, spec, new Set());
  }

  const argsScVal = spec.funcArgsToScVals(intent.fn, intent.args);
  const argsXdr = argsScVal.map((v) => v.toXDR("base64"));
  const argsVec = xdr.ScVal.scvVec(argsScVal);
  const echo = Object.fromEntries(
    fn.inputs().map((input, i) => {
      const name = input.name().toString();
      return [name, canonical(spec.scValToNative(argsScVal[i], input.type()))];
    }),
  );
  const byteLength = argsVec.toXDR().length;
  if (byteLength > maxArgsBytes) {
    throw new Error(`encoded args are ${byteLength} bytes, above the ${maxArgsBytes}-byte limit (persistent storage write fee)`);
  }
  return { argsScVal, argsXdr, argsVecXdr: argsVec.toXDR("base64"), echo, byteLength };
}
