import { StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import * as contract from "@stellar/stellar-sdk/contract";
import { Client as MarketCoreClient } from "@oracledesk/bindings-market-core";
import { Client as ReasoningRegistryClient } from "@oracledesk/bindings-reasoning-registry";
import { Client as ResolverClient } from "@oracledesk/bindings-resolver";
import { Client as RouterClient } from "@oracledesk/bindings-router";
import { Client as TimelockClient } from "@oracledesk/bindings-timelock";
import { Client as TreasuryClient } from "@oracledesk/bindings-treasury";

export type ContractName =
  | "market-core"
  | "resolver"
  | "treasury"
  | "reasoning-registry"
  | "timelock"
  | "router";

export const CONTRACT_NAMES: readonly ContractName[] = [
  "market-core",
  "resolver",
  "treasury",
  "reasoning-registry",
  "timelock",
  "router",
];

type Options = { contractId: string; networkPassphrase: string; rpcUrl: string };

type SpecClient = new (options: Options) => { spec: contract.Spec };

const CLIENTS: Record<ContractName, SpecClient> = {
  "market-core": MarketCoreClient as unknown as SpecClient,
  resolver: ResolverClient as unknown as SpecClient,
  treasury: TreasuryClient as unknown as SpecClient,
  "reasoning-registry": ReasoningRegistryClient as unknown as SpecClient,
  timelock: TimelockClient as unknown as SpecClient,
  router: RouterClient as unknown as SpecClient,
};

const PLACEHOLDER_ID = StrKey.encodeContract(Buffer.alloc(32));

/** The spec embedded in the generated binding for `name`. */
export function specFor(name: ContractName): contract.Spec {
  const Client = CLIENTS[name];
  if (!Client) throw new Error(`unknown contract '${name}'`);
  return new Client({
    contractId: PLACEHOLDER_ID,
    networkPassphrase: "",
    rpcUrl: "https://unused.invalid",
  }).spec;
}

/** The spec actually deployed at `id`, read from the contract's WASM. */
export async function specFromChain(rpcServer: rpc.Server, id: string): Promise<contract.Spec> {
  const wasm = await rpcServer.getContractWasmByContractId(id);
  return contract.Spec.fromWasm(wasm);
}

function inputSignature(inputs: xdr.ScSpecFunctionInputV0[]): string {
  return inputs.map((i) => `${i.name().toString()}:${i.type().toXDR("base64")}`).join(",");
}

function outputSignature(outputs: xdr.ScSpecType[]): string {
  return outputs.map((o) => o.toXDR("base64")).join(",");
}

/** Bindings drift; refuse to encode a call whose signature differs on-chain. */
export function assertSpecMatches(
  local: contract.Spec,
  onChain: contract.Spec,
  fn: string,
): void {
  let a: xdr.ScSpecFunctionV0;
  let b: xdr.ScSpecFunctionV0;
  try {
    a = local.getFunc(fn);
  } catch {
    throw new Error(`binding spec has no function '${fn}'`);
  }
  try {
    b = onChain.getFunc(fn);
  } catch {
    throw new Error(`on-chain spec has no function '${fn}'; do not encode from a stale binding`);
  }
  const localSig = `${inputSignature(a.inputs())}->${outputSignature(a.outputs())}`;
  const chainSig = `${inputSignature(b.inputs())}->${outputSignature(b.outputs())}`;
  if (localSig !== chainSig) {
    throw new Error(`spec drift for '${fn}': binding ${localSig}, on-chain ${chainSig}`);
  }
}
