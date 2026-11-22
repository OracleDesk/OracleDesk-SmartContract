import { assertTestnetPassphrase, type DeploymentManifest } from "./manifest.ts";
import type { ContractName, LiveChainState } from "./state.ts";

export type StepKind = "fund-identity" | "restore" | "deploy" | "invoke" | "register" | "mint" | "manual" | "blocked";

export interface PlanStep {
  id: string;
  kind: StepKind;
  target: string;
  reason: string;
  dependsOn: string[];
  details?: Record<string, unknown>;
}

export interface PlanOptions {
  allowRedeploy?: string[];
}

export interface DeploymentPlan {
  steps: PlanStep[];
  blocked: boolean;
  /** Exit code convention: 0 = no changes, 2 = pending changes, 1 = blocked */
  exitCode: 0 | 1 | 2;
}

export function resolveRef(
  ref: string,
  ctx: {
    deployer: string;
    agent: string;
    usdc?: string;
    contracts: Partial<Record<ContractName, string>>;
  }
): string {
  switch (ref) {
    case "${identities.deployer}":
      return ctx.deployer;
    case "${identities.agent}":
      return ctx.agent;
    case "${contracts.usdc}":
      return ctx.usdc ?? ref;
    case "${contracts.market_core}":
      return ctx.contracts.market_core ?? ref;
    case "${contracts.resolver}":
      return ctx.contracts.resolver ?? ref;
    case "${contracts.treasury}":
      return ctx.contracts.treasury ?? ref;
    case "${contracts.reasoning_registry}":
      return ctx.contracts.reasoning_registry ?? ref;
    default:
      return ref;
  }
}

/**
 * Computes an ordered, deterministic deployment plan from the declarative
 * manifest and live chain state. Refuses non-testnet network passphrases.
 */
export function computePlan(
  manifest: DeploymentManifest,
  state: LiveChainState,
  options: PlanOptions = {}
): DeploymentPlan {
  assertTestnetPassphrase(state.networkPassphrase);

  const allowRedeploy = new Set(options.allowRedeploy ?? []);
  const steps: PlanStep[] = [];
  const redeployed = new Set<ContractName | "usdc">();

  // 1. After a testnet reset, the deployer account itself may no longer exist.
  if (!state.deployerAccountExists) {
    steps.push({
      id: "fund-deployer",
      kind: "fund-identity",
      target: manifest.identities.deployer,
      reason: "Deployer account is absent on testnet (e.g., fresh identity or testnet reset); fund via friendbot",
      dependsOn: [],
    });
  }

  const fundDeps = state.deployerAccountExists ? [] : ["fund-deployer"];

  // 2. Collateral SAC (self-issued USDC or existing asset ID)
  if (manifest.collateral.kind === "self-issued") {
    if (state.usdcStatus === "archived") {
      steps.push({
        id: "restore-usdc",
        kind: "restore",
        target: state.usdcId ?? "usdc",
        reason: "Collateral USDC contract instance is archived on ledger and must be restored",
        dependsOn: [...fundDeps],
      });
    } else if (state.usdcStatus === "absent") {
      redeployed.add("usdc");
      steps.push({
        id: "deploy-usdc",
        kind: "deploy",
        target: "usdc",
        reason: "Self-issued USDC SAC is absent on chain",
        dependsOn: [...fundDeps],
        details: { code: manifest.collateral.code, issuer: state.deployerAddress },
      });
    }
  } else if (state.usdcStatus === "absent") {
    steps.push({
      id: "blocked-usdc",
      kind: "blocked",
      target: manifest.collateral.id,
      reason: `Configured existing collateral contract ${manifest.collateral.id} is absent on chain`,
      dependsOn: [],
    });
  }

  const usdcDeps = [
    ...fundDeps,
    ...(redeployed.has("usdc") ? ["deploy-usdc"] : []),
    ...(state.usdcStatus === "archived" ? ["restore-usdc"] : []),
  ];

  // 3. Core contracts: market_core, resolver, treasury, reasoning_registry.
  // Note on circular dependency: resolver and treasury constructors reference
  // market_core's ID while market_core stores resolver and treasury. Deterministic
  // salts allow predicting addresses up front, and wiring is immediately executed
  // and verified in step 4.
  const deployOrder: ContractName[] = ["market_core", "resolver", "treasury", "reasoning_registry"];
  for (const name of deployOrder) {
    const live = state.contracts[name];
    const localHash = state.localWasmHashes[name];
    const extraDeps: string[] = [...usdcDeps];
    if (name === "resolver" || name === "treasury") {
      if (redeployed.has("market_core")) extraDeps.push("deploy-market_core");
    }

    if (live.status === "archived") {
      steps.push({
        id: `restore-${name}`,
        kind: "restore",
        target: live.id ?? name,
        reason: `${name} instance entry is archived on ledger; restore before continuing`,
        dependsOn: extraDeps,
      });
      continue;
    }

    if (live.status === "absent") {
      redeployed.add(name);
      steps.push({
        id: `deploy-${name}`,
        kind: "deploy",
        target: name,
        reason: `${name} instance is absent on chain (fresh deploy or testnet reset)`,
        dependsOn: extraDeps,
        details: { wasm: manifest.contracts[name].wasm },
      });
      continue;
    }

    // Present on chain: check wasm hash drift
    if (localHash && live.wasmHash && localHash !== live.wasmHash) {
      redeployed.add(name);
      steps.push({
        id: `deploy-${name}`,
        kind: "deploy",
        target: name,
        reason: `${name} wasm hash changed (${live.wasmHash.slice(0, 12)} -> ${localHash.slice(0, 12)}); contracts have no in-place upgrade`,
        dependsOn: extraDeps,
        details: { previousHash: live.wasmHash, nextHash: localHash },
      });
      continue;
    }

    // Check immutable treasury risk caps on an existing treasury
    if (name === "treasury" && state.treasuryConfig) {
      const desiredMaxTrade = String(manifest.contracts.treasury.args["max_trade"]);
      const desiredMaxMarket = String(manifest.contracts.treasury.args["max_market"]);
      const desiredMaxDaily = String(manifest.contracts.treasury.args["max_daily"]);

      const capMismatches: string[] = [];
      if (state.treasuryConfig.max_trade !== desiredMaxTrade) {
        capMismatches.push(`max_trade (${state.treasuryConfig.max_trade} != ${desiredMaxTrade})`);
      }
      if (state.treasuryConfig.max_market !== desiredMaxMarket) {
        capMismatches.push(`max_market (${state.treasuryConfig.max_market} != ${desiredMaxMarket})`);
      }
      if (state.treasuryConfig.max_daily !== desiredMaxDaily) {
        capMismatches.push(`max_daily (${state.treasuryConfig.max_daily} != ${desiredMaxDaily})`);
      }

      if (capMismatches.length > 0) {
        if (allowRedeploy.has("treasury")) {
          redeployed.add("treasury");
          steps.push({
            id: "deploy-treasury",
            kind: "deploy",
            target: "treasury",
            reason: `Redeploying treasury (--allow-redeploy treasury) due to cap mismatch: ${capMismatches.join(", ")}`,
            dependsOn: extraDeps,
          });
        } else {
          steps.push({
            id: "blocked-treasury-caps",
            kind: "blocked",
            target: "treasury",
            reason: `Treasury risk caps differ (${capMismatches.join(", ")}) and cannot be updated in place; re-run with --allow-redeploy treasury`,
            dependsOn: [],
          });
        }
      }
    }
  }

  // If market_core or usdc was redeployed, dependent contracts referencing them must also be redeployed
  if (redeployed.has("usdc") || redeployed.has("market_core")) {
    for (const dep of ["resolver", "treasury"] as const) {
      if (!redeployed.has(dep) && state.contracts[dep].status === "present") {
        redeployed.add(dep);
        steps.push({
          id: `deploy-${dep}`,
          kind: "deploy",
          target: dep,
          reason: `Upstream dependency redeployed (${redeployed.has("usdc") ? "usdc" : "market_core"}); redeploying ${dep} to point at new contract IDs`,
          dependsOn: [
            ...(redeployed.has("usdc") ? ["deploy-usdc"] : []),
            ...(redeployed.has("market_core") ? ["deploy-market_core"] : []),
          ],
        });
      }
    }
  }

  const refCtx = {
    deployer: state.deployerAddress,
    agent: state.agentAddress,
    usdc: state.usdcId,
    contracts: {
      market_core: state.contracts.market_core.id,
      resolver: state.contracts.resolver.id,
      treasury: state.contracts.treasury.id,
      reasoning_registry: state.contracts.reasoning_registry.id,
    },
  };

  // 4. Wiring checks: market_core -> resolver and market_core -> treasury
  const desiredResolver = resolveRef(manifest.wiring.market_core.resolver, refCtx);
  const desiredTreasury = resolveRef(manifest.wiring.market_core.treasury, refCtx);
  const mcAdminDrifted =
    !redeployed.has("market_core") &&
    state.marketCoreConfig !== undefined &&
    state.marketCoreConfig.admin !== state.deployerAddress;

  const resolverNeedsWiring =
    redeployed.has("market_core") ||
    redeployed.has("resolver") ||
    (state.marketCoreConfig !== undefined && state.marketCoreConfig.resolver !== desiredResolver);

  if (resolverNeedsWiring) {
    if (mcAdminDrifted) {
      steps.push({
        id: "blocked-set-resolver-admin",
        kind: "blocked",
        target: "market_core",
        reason: `market_core resolver drift detected, but on-chain admin (${state.marketCoreConfig!.admin}) is not deployer (${state.deployerAddress})`,
        dependsOn: [],
      });
    } else {
      steps.push({
        id: "set-resolver",
        kind: "invoke",
        target: "market_core",
        reason: redeployed.has("market_core") || redeployed.has("resolver")
          ? "Wire newly deployed market_core <-> resolver"
          : `market_core.resolver drifted (${state.marketCoreConfig?.resolver ?? "unset"} -> ${desiredResolver})`,
        dependsOn: [
          ...(redeployed.has("market_core") ? ["deploy-market_core"] : []),
          ...(redeployed.has("resolver") ? ["deploy-resolver"] : []),
        ],
        details: { method: "set_resolver", targetAddress: desiredResolver },
      });
    }
  }

  const treasuryNeedsWiring =
    redeployed.has("market_core") ||
    redeployed.has("treasury") ||
    (state.marketCoreConfig !== undefined && state.marketCoreConfig.treasury !== desiredTreasury);

  if (treasuryNeedsWiring) {
    if (mcAdminDrifted) {
      steps.push({
        id: "blocked-set-treasury-admin",
        kind: "blocked",
        target: "market_core",
        reason: `market_core treasury drift detected, but on-chain admin (${state.marketCoreConfig!.admin}) is not deployer (${state.deployerAddress})`,
        dependsOn: [],
      });
    } else {
      steps.push({
        id: "set-treasury",
        kind: "invoke",
        target: "market_core",
        reason: redeployed.has("market_core") || redeployed.has("treasury")
          ? "Wire newly deployed market_core <-> treasury"
          : `market_core.treasury drifted (${state.marketCoreConfig?.treasury ?? "unset"} -> ${desiredTreasury})`,
        dependsOn: [
          ...(redeployed.has("market_core") ? ["deploy-market_core"] : []),
          ...(redeployed.has("treasury") ? ["deploy-treasury"] : []),
        ],
        details: { method: "set_treasury", targetAddress: desiredTreasury },
      });
    }
  }

  // 5. Agent registrations in reasoning_registry
  for (const agentRef of manifest.registry.agents) {
    const agentAddr = resolveRef(agentRef, refCtx);
    const isRegistered =
      !redeployed.has("reasoning_registry") && Boolean(state.registeredAgents[agentAddr]);
    if (!isRegistered) {
      steps.push({
        id: `register-agent-${agentAddr.slice(0, 8) || "primary"}`,
        kind: "register",
        target: "reasoning_registry",
        reason: `Agent ${agentAddr || agentRef} is not registered in reasoning_registry`,
        dependsOn: redeployed.has("reasoning_registry") ? ["deploy-reasoning_registry"] : [],
        details: { method: "register_agent", agent: agentAddr },
      });
    }
  }

  // 6. Treasury funding check
  const minBalance = BigInt(manifest.funding.treasury_min_balance);
  const currentBalance = redeployed.has("treasury") || redeployed.has("usdc")
    ? 0n
    : BigInt(state.treasuryBalance ?? "0");

  if (currentBalance < minBalance) {
    const deficit = minBalance - currentBalance;
    if (manifest.collateral.kind === "self-issued") {
      steps.push({
        id: "fund-treasury",
        kind: "mint",
        target: "treasury",
        reason: `Treasury balance (${currentBalance}) is below minimum (${minBalance}); top up by ${deficit} stroops`,
        dependsOn: [
          ...(redeployed.has("usdc") ? ["deploy-usdc"] : []),
          ...(redeployed.has("treasury") ? ["deploy-treasury"] : []),
        ],
        details: { amount: deficit.toString() },
      });
    } else {
      steps.push({
        id: "manual-fund-treasury",
        kind: "manual",
        target: "treasury",
        reason: `Treasury balance (${currentBalance}) is below minimum (${minBalance}); manual funding of ${deficit} stroops required for existing collateral`,
        dependsOn: [],
        details: { amount: deficit.toString() },
      });
    }
  }

  const blocked = steps.some((s) => s.kind === "blocked");
  const exitCode: 0 | 1 | 2 = blocked ? 1 : steps.length === 0 ? 0 : 2;
  return { steps, blocked, exitCode };
}

export function formatPlanDiff(plan: DeploymentPlan): string {
  if (plan.steps.length === 0) {
    return "No changes required. Live testnet state matches manifest.";
  }
  const lines = ["Deployment plan:"];
  for (const step of plan.steps) {
    const prefix =
      step.kind === "blocked"
        ? "!"
        : step.kind === "deploy" || step.kind === "mint" || step.kind === "register"
          ? "+"
          : "~";
    const deps = step.dependsOn.length > 0 ? ` (after: ${step.dependsOn.join(", ")})` : "";
    lines.push(`  ${prefix} [${step.kind}] ${step.id} (${step.target})${deps}: ${step.reason}`);
  }
  return lines.join("\n");
}
