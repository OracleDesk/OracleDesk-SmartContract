import { readFileSync } from "node:fs";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export type CollateralSpec =
  | { kind: "self-issued"; code: "USDC" }
  | { kind: "existing"; id: string };

export interface ContractSpec {
  wasm: string;
  args: Record<string, string | number | boolean>;
}

export interface DeploymentManifest {
  network: "testnet";
  identities: {
    deployer: string;
    agent: string;
  };
  collateral: CollateralSpec;
  contracts: {
    market_core: ContractSpec;
    resolver: ContractSpec;
    treasury: ContractSpec;
    reasoning_registry: ContractSpec;
  };
  wiring: {
    market_core: {
      resolver: string;
      treasury: string;
      default_fee_bps: number;
      paused: boolean;
    };
  };
  registry: {
    agents: string[];
  };
  funding: {
    treasury_min_balance: string;
  };
}

export function assertTestnetPassphrase(passphrase: string): void {
  if (passphrase !== TESTNET_PASSPHRASE) {
    throw new Error(
      `Refusing non-testnet network passphrase: expected "${TESTNET_PASSPHRASE}", got "${passphrase}".`
    );
  }
}

function parseBigIntField(name: string, raw: unknown): bigint {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`Manifest field ${name} must be an integer string`);
  }
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`Manifest field ${name} must be a non-negative integer (got "${str}")`);
  }
  return BigInt(str);
}

/**
 * Validates the declarative testnet deployment manifest, including treasury
 * risk-cap ordering (`max_trade > 0`, `max_market >= max_trade`,
 * `max_daily >= max_market`) mirroring `treasury::__constructor`.
 */
export function parseManifest(raw: unknown): DeploymentManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Deployment manifest must be a JSON object");
  }
  const m = raw as Partial<DeploymentManifest>;
  if (m.network !== "testnet") {
    throw new Error(`Manifest network must be "testnet" (got "${String(m.network)}")`);
  }
  if (!m.identities?.deployer || !m.identities?.agent) {
    throw new Error("Manifest identities.deployer and identities.agent are required");
  }
  if (!m.collateral || (m.collateral.kind !== "self-issued" && m.collateral.kind !== "existing")) {
    throw new Error("Manifest collateral.kind must be 'self-issued' or 'existing'");
  }
  if (m.collateral.kind === "self-issued" && m.collateral.code !== "USDC") {
    throw new Error("Self-issued collateral code must be 'USDC'");
  }
  if (m.collateral.kind === "existing" && !m.collateral.id) {
    throw new Error("Existing collateral requires collateral.id");
  }
  for (const name of ["market_core", "resolver", "treasury", "reasoning_registry"] as const) {
    if (!m.contracts?.[name]?.wasm) {
      throw new Error(`Manifest contracts.${name}.wasm is required`);
    }
  }
  if (!m.wiring?.market_core) {
    throw new Error("Manifest wiring.market_core is required");
  }
  if (!m.registry || !Array.isArray(m.registry.agents)) {
    throw new Error("Manifest registry.agents must be an array");
  }
  parseBigIntField("funding.treasury_min_balance", m.funding?.treasury_min_balance);

  const tArgs = m.contracts!.treasury.args;
  const maxTrade = parseBigIntField("contracts.treasury.args.max_trade", tArgs["max_trade"]);
  const maxMarket = parseBigIntField("contracts.treasury.args.max_market", tArgs["max_market"]);
  const maxDaily = parseBigIntField("contracts.treasury.args.max_daily", tArgs["max_daily"]);

  if (maxTrade <= 0n || maxMarket < maxTrade || maxDaily < maxMarket) {
    throw new Error(
      `Invalid treasury caps in manifest: require 0 < max_trade (${maxTrade}) <= max_market (${maxMarket}) <= max_daily (${maxDaily})`
    );
  }

  return m as DeploymentManifest;
}

export function loadManifest(path: string): DeploymentManifest {
  return parseManifest(JSON.parse(readFileSync(path, "utf8")));
}
