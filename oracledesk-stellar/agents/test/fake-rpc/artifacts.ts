/**
 * Contract artifacts for the fake RPC (#106).
 *
 * The fake serves real compiled WASM over `getLedgerEntries`, so the SDK's
 * `Client.from` (the path StellarAdapter uses) downloads it and builds its
 * client from the WASM's own contract spec, exactly as against a network.
 * Arguments and return values are encoded and decoded with that same spec.
 *
 * Sources, in order of preference:
 *   1. "compiled": target/wasm32v1-none/release/<name>.wasm, a fresh
 *      `stellar contract build` (CI's Node job downloads it from the Rust job);
 *   2. "vendored": contracts/integration-tests/wasm/<name>.wasm, checked in.
 * The first source whose spec encodes every call the agents make (`probes`)
 * wins. If none does, the best available one is still served with `fits:
 * false` and the reasons, so a test can tell an interface drift (e.g. the
 * vendored reasoning_registry predates `publish_trace(action: TraceAction)`)
 * from an agent bug, and mark itself TODO instead of passing vacuously.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contract, StrKey, xdr } from "@stellar/stellar-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const STELLAR_ROOT = join(HERE, "..", "..", "..");

export const ARTIFACT_DIRS = {
  compiled: join(STELLAR_ROOT, "target", "wasm32v1-none", "release"),
  vendored: join(STELLAR_ROOT, "contracts", "integration-tests", "wasm"),
} as const;
export type ArtifactSource = keyof typeof ARTIFACT_DIRS;

export type ContractName = "market_core" | "treasury" | "reasoning_registry";
export const CONTRACT_NAMES: ContractName[] = ["market_core", "treasury", "reasoning_registry"];

export interface ContractArtifact {
  name: ContractName;
  source: ArtifactSource;
  path: string;
  wasm: Buffer;
  /** sha256 of the WASM, the contract-code entry's ledger key. */
  hash: Buffer;
  spec: contract.Spec;
  /** The contract's `Error` enum, name to code, read from the spec. */
  errors: Map<string, number>;
  /** True when every probe call encodes against `spec`. */
  fits: boolean;
  /** Sources that were missing or did not fit, and why. */
  rejected: string[];
}

/** A call the agents make, used to check that a spec fits the adapter. */
export interface ProbeCall {
  fn: string;
  args: Record<string, unknown>;
}

/** A deterministic contract id per contract name. */
export function contractIdFor(name: ContractName): string {
  return StrKey.encodeContract(createHash("sha256").update(`oracledesk-fake:${name}`).digest());
}

function errorsOf(spec: contract.Spec): Map<string, number> {
  const errors = new Map<string, number>();
  for (const entry of spec.entries) {
    if (entry.switch() !== xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0()) continue;
    const e = entry.udtErrorEnumV0();
    if (e.name().toString() !== "Error") continue;
    for (const c of e.cases()) errors.set(c.name().toString(), c.value());
  }
  return errors;
}

/** Why `spec` cannot encode `probes`, or undefined when it can. */
function misfit(spec: contract.Spec, probes: ProbeCall[]): string | undefined {
  for (const p of probes) {
    try {
      spec.funcArgsToScVals(p.fn, p.args);
    } catch (err) {
      return `${p.fn}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

/** The first source whose WASM fits `probes`, else the first one found (fits: false). */
export async function loadArtifact(name: ContractName, probes: ProbeCall[]): Promise<ContractArtifact> {
  const rejected: string[] = [];
  let fallback: ContractArtifact | undefined;
  for (const source of Object.keys(ARTIFACT_DIRS) as ArtifactSource[]) {
    const path = join(ARTIFACT_DIRS[source], `${name}.wasm`);
    if (!existsSync(path)) {
      rejected.push(`${source}: ${path} not found`);
      continue;
    }
    const wasm = readFileSync(path);
    const spec = await contract.Spec.fromWasm(wasm);
    const artifact: ContractArtifact = {
      name, source, path, wasm, hash: createHash("sha256").update(wasm).digest(), spec, errors: errorsOf(spec), fits: true, rejected,
    };
    const why = misfit(spec, probes);
    if (!why) return artifact;
    rejected.push(`${source}: spec does not fit the adapter (${why})`);
    fallback ??= { ...artifact, fits: false };
  }
  if (!fallback) throw new Error(`no WASM for ${name}: ${rejected.join("; ")}`);
  return fallback;
}
