import { assertTestnetPassphrase, type DeploymentManifest } from "./manifest.ts";
import { resolveRef } from "./plan.ts";
import type { LiveChainState } from "./state.ts";

export interface VerificationMismatch {
  invariant: string;
  expected: string;
  actual: string;
}

export interface VerificationResult {
  ok: boolean;
  mismatches: VerificationMismatch[];
}

/**
 * Verifies post-deployment invariants against live chain state:
 * - market_core Config matches manifest (resolver, treasury, collateral, fee, paused)
 * - treasury RiskConfig.market_core == market_core and collateral == usdc
 * - resolver instance MarketCore == market_core
 * - reasoning_registry reports every manifest agent as registered
 * - treasury balance >= funding.treasury_min_balance
 */
export function verifyDeployment(
  manifest: DeploymentManifest,
  state: LiveChainState
): VerificationResult {
  assertTestnetPassphrase(state.networkPassphrase);
  const mismatches: VerificationMismatch[] = [];

  const mcId = state.contracts.market_core.id ?? "";
  const resolverId = state.contracts.resolver.id ?? "";
  const treasuryId = state.contracts.treasury.id ?? "";
  const usdcId = state.usdcId ?? "";

  const refCtx = {
    deployer: state.deployerAddress,
    agent: state.agentAddress,
    usdc: usdcId,
    contracts: {
      market_core: mcId,
      resolver: resolverId,
      treasury: treasuryId,
      reasoning_registry: state.contracts.reasoning_registry.id,
    },
  };

  for (const name of ["market_core", "resolver", "treasury", "reasoning_registry"] as const) {
    if (state.contracts[name].status !== "present") {
      mismatches.push({
        invariant: `contracts.${name}.status`,
        expected: "present",
        actual: state.contracts[name].status,
      });
    }
  }

  if (!state.marketCoreConfig) {
    mismatches.push({
      invariant: "market_core.get_config()",
      expected: "readable Config",
      actual: "missing",
    });
  } else {
    const expectedResolver = resolveRef(manifest.wiring.market_core.resolver, refCtx);
    const expectedTreasury = resolveRef(manifest.wiring.market_core.treasury, refCtx);
    if (state.marketCoreConfig.resolver !== expectedResolver) {
      mismatches.push({
        invariant: "market_core.Config.resolver",
        expected: expectedResolver,
        actual: state.marketCoreConfig.resolver,
      });
    }
    if (state.marketCoreConfig.treasury !== expectedTreasury) {
      mismatches.push({
        invariant: "market_core.Config.treasury",
        expected: expectedTreasury,
        actual: state.marketCoreConfig.treasury,
      });
    }
    if (state.marketCoreConfig.collateral !== usdcId) {
      mismatches.push({
        invariant: "market_core.Config.collateral",
        expected: usdcId,
        actual: state.marketCoreConfig.collateral,
      });
    }
    if (state.marketCoreConfig.default_fee_bps !== manifest.wiring.market_core.default_fee_bps) {
      mismatches.push({
        invariant: "market_core.Config.default_fee_bps",
        expected: String(manifest.wiring.market_core.default_fee_bps),
        actual: String(state.marketCoreConfig.default_fee_bps),
      });
    }
    if (state.marketCoreConfig.paused !== manifest.wiring.market_core.paused) {
      mismatches.push({
        invariant: "market_core.Config.paused",
        expected: String(manifest.wiring.market_core.paused),
        actual: String(state.marketCoreConfig.paused),
      });
    }
  }

  if (!state.treasuryConfig) {
    mismatches.push({
      invariant: "treasury.get_config()",
      expected: "readable RiskConfig",
      actual: "missing",
    });
  } else {
    if (state.treasuryConfig.market_core !== mcId) {
      mismatches.push({
        invariant: "treasury.RiskConfig.market_core",
        expected: mcId,
        actual: state.treasuryConfig.market_core,
      });
    }
    if (state.treasuryConfig.collateral !== usdcId) {
      mismatches.push({
        invariant: "treasury.RiskConfig.collateral",
        expected: usdcId,
        actual: state.treasuryConfig.collateral,
      });
    }
    if (state.marketCoreConfig && state.treasuryConfig.collateral !== state.marketCoreConfig.collateral) {
      mismatches.push({
        invariant: "treasury.collateral == market_core.collateral",
        expected: state.marketCoreConfig.collateral,
        actual: state.treasuryConfig.collateral,
      });
    }
  }

  if (!state.resolverInstance) {
    mismatches.push({
      invariant: "resolver.instance.MarketCore",
      expected: mcId,
      actual: "unreadable",
    });
  } else if (state.resolverInstance.market_core !== mcId) {
    mismatches.push({
      invariant: "resolver.instance.MarketCore",
      expected: mcId,
      actual: state.resolverInstance.market_core,
    });
  }

  for (const agentRef of manifest.registry.agents) {
    const agentAddr = resolveRef(agentRef, refCtx);
    if (!state.registeredAgents[agentAddr]) {
      mismatches.push({
        invariant: `reasoning_registry.is_registered(${agentAddr})`,
        expected: "true",
        actual: "false",
      });
    }
  }

  const minBalance = BigInt(manifest.funding.treasury_min_balance);
  const actualBalance = BigInt(state.treasuryBalance ?? "0");
  if (actualBalance < minBalance) {
    mismatches.push({
      invariant: "treasury.balance >= funding.treasury_min_balance",
      expected: `>= ${minBalance}`,
      actual: actualBalance.toString(),
    });
  }

  return { ok: mismatches.length === 0, mismatches };
}

export function formatVerificationReport(result: VerificationResult): string {
  if (result.ok) {
    return "Verification passed: all deployment invariants hold.";
  }
  const lines = ["Verification failed — mismatches:", "| Invariant | Expected | Actual |", "| --- | --- | --- |"];
  for (const m of result.mismatches) {
    lines.push(`| ${m.invariant} | ${m.expected} | ${m.actual} |`);
  }
  return lines.join("\n");
}
