import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseManifest, TESTNET_PASSPHRASE, type DeploymentManifest } from "../src/manifest.ts";
import { computePlan } from "../src/plan.ts";
import type { LiveChainState } from "../src/state.ts";
import { verifyDeployment } from "../src/verify.ts";

const DEPLOYER = "GDEPLOYERADDRESS0000000000000000000000000000000000000001";
const AGENT = "GAGENTADDRESS0000000000000000000000000000000000000000002";
const USDC = "CUSDC000000000000000000000000000000000000000000000000001";
const MC = "CMARKETCORE000000000000000000000000000000000000000000002";
const RESOLVER = "CRESOLVER00000000000000000000000000000000000000000000003";
const TREASURY = "CTREASURY00000000000000000000000000000000000000000000004";
const REGISTRY = "CREGISTRY00000000000000000000000000000000000000000000005";

const MANIFEST: DeploymentManifest = parseManifest({
  network: "testnet",
  identities: { deployer: "oracledesk-deployer", agent: "oracledesk-agent" },
  collateral: { kind: "self-issued", code: "USDC" },
  contracts: {
    market_core: {
      wasm: "target/wasm32v1-none/release/market_core.wasm",
      args: { admin: "${identities.deployer}", collateral: "${contracts.usdc}", default_fee_bps: 100 },
    },
    resolver: {
      wasm: "target/wasm32v1-none/release/resolver.wasm",
      args: { admin: "${identities.deployer}", market_core: "${contracts.market_core}" },
    },
    treasury: {
      wasm: "target/wasm32v1-none/release/treasury.wasm",
      args: {
        admin: "${identities.deployer}",
        agent: "${identities.agent}",
        collateral: "${contracts.usdc}",
        market_core: "${contracts.market_core}",
        max_trade: "2000000000",
        max_market: "5000000000",
        max_daily: "10000000000",
      },
    },
    reasoning_registry: {
      wasm: "target/wasm32v1-none/release/reasoning_registry.wasm",
      args: { admin: "${identities.deployer}" },
    },
  },
  wiring: {
    market_core: {
      resolver: "${contracts.resolver}",
      treasury: "${contracts.treasury}",
      default_fee_bps: 100,
      paused: false,
    },
  },
  registry: { agents: ["${identities.agent}"] },
  funding: { treasury_min_balance: "10000000000000" },
});

function healthyState(overrides: Partial<LiveChainState> = {}): LiveChainState {
  return {
    networkPassphrase: TESTNET_PASSPHRASE,
    deployerAddress: DEPLOYER,
    deployerAccountExists: true,
    agentAddress: AGENT,
    usdcId: USDC,
    usdcStatus: "present",
    contracts: {
      market_core: { id: MC, status: "present", wasmHash: "aaaa" },
      resolver: { id: RESOLVER, status: "present", wasmHash: "bbbb" },
      treasury: { id: TREASURY, status: "present", wasmHash: "cccc" },
      reasoning_registry: { id: REGISTRY, status: "present", wasmHash: "dddd" },
    },
    localWasmHashes: {
      market_core: "aaaa",
      resolver: "bbbb",
      treasury: "cccc",
      reasoning_registry: "dddd",
    },
    marketCoreConfig: {
      admin: DEPLOYER,
      collateral: USDC,
      treasury: TREASURY,
      resolver: RESOLVER,
      default_fee_bps: 100,
      paused: false,
    },
    treasuryConfig: {
      agent: AGENT,
      collateral: USDC,
      market_core: MC,
      max_trade: "2000000000",
      max_market: "5000000000",
      max_daily: "10000000000",
    },
    resolverInstance: { admin: DEPLOYER, market_core: MC },
    registeredAgents: { [AGENT]: true },
    treasuryBalance: "10000000000000",
    ...overrides,
  };
}

describe("deployer planner", () => {
  it("empty_chain_plans_full_deploy", () => {
    const state = healthyState({
      deployerAccountExists: false,
      usdcId: undefined,
      usdcStatus: "absent",
      contracts: {
        market_core: { status: "absent" },
        resolver: { status: "absent" },
        treasury: { status: "absent" },
        reasoning_registry: { status: "absent" },
      },
      marketCoreConfig: undefined,
      treasuryConfig: undefined,
      resolverInstance: undefined,
      registeredAgents: {},
      treasuryBalance: "0",
    });

    const plan = computePlan(MANIFEST, state);
    assert.equal(plan.exitCode, 2);
    assert.equal(plan.blocked, false);
    const ids = plan.steps.map((s) => s.id);
    assert.ok(ids.includes("fund-deployer"));
    assert.ok(ids.includes("deploy-usdc"));
    assert.ok(ids.includes("deploy-market_core"));
    assert.ok(ids.includes("deploy-resolver"));
    assert.ok(ids.includes("deploy-treasury"));
    assert.ok(ids.includes("deploy-reasoning_registry"));
    assert.ok(ids.includes("set-resolver"));
    assert.ok(ids.includes("set-treasury"));
    assert.ok(ids.includes("fund-treasury"));
  });

  it("matching_state_plans_nothing", () => {
    const state = healthyState();
    const plan = computePlan(MANIFEST, state);
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.steps.length, 0);
    assert.equal(verifyDeployment(MANIFEST, state).ok, true);
  });

  it("resolver_drift_plans_set_resolver", () => {
    const state = healthyState({
      marketCoreConfig: {
        admin: DEPLOYER,
        collateral: USDC,
        treasury: TREASURY,
        resolver: "CRANDOMDRIFT00000000000000000000000000000000000000000009",
        default_fee_bps: 100,
        paused: false,
      },
    });
    const plan = computePlan(MANIFEST, state);
    assert.equal(plan.exitCode, 2);
    assert.deepEqual(
      plan.steps.map((s) => s.id),
      ["set-resolver"]
    );
    const verification = verifyDeployment(MANIFEST, state);
    assert.equal(verification.ok, false);
    assert.ok(verification.mismatches.some((m) => m.invariant === "market_core.Config.resolver"));
  });

  it("reset_detected_when_instance_missing", () => {
    const state = healthyState({
      usdcStatus: "absent",
      contracts: {
        market_core: { id: MC, status: "absent" },
        resolver: { id: RESOLVER, status: "absent" },
        treasury: { id: TREASURY, status: "absent" },
        reasoning_registry: { id: REGISTRY, status: "absent" },
      },
      marketCoreConfig: undefined,
      treasuryConfig: undefined,
      resolverInstance: undefined,
      registeredAgents: {},
      treasuryBalance: "0",
    });
    const plan = computePlan(MANIFEST, state);
    assert.equal(plan.exitCode, 2);
    assert.ok(plan.steps.some((s) => s.id === "deploy-market_core"));
    assert.ok(plan.steps.some((s) => s.id === "deploy-treasury"));
  });

  it("cap_mismatch_is_blocked_without_flag", () => {
    const state = healthyState({
      treasuryConfig: {
        agent: AGENT,
        collateral: USDC,
        market_core: MC,
        max_trade: "1000000000",
        max_market: "5000000000",
        max_daily: "10000000000",
      },
    });
    const blockedPlan = computePlan(MANIFEST, state);
    assert.equal(blockedPlan.blocked, true);
    assert.equal(blockedPlan.exitCode, 1);
    assert.ok(blockedPlan.steps.some((s) => s.kind === "blocked" && s.target === "treasury"));

    const allowedPlan = computePlan(MANIFEST, state, { allowRedeploy: ["treasury"] });
    assert.equal(allowedPlan.blocked, false);
    assert.equal(allowedPlan.exitCode, 2);
    assert.ok(allowedPlan.steps.some((s) => s.id === "deploy-treasury"));
    assert.ok(allowedPlan.steps.some((s) => s.id === "set-treasury"));
  });

  it("underfunded_treasury_plans_mint", () => {
    const state = healthyState({ treasuryBalance: "4000000000000" });
    const plan = computePlan(MANIFEST, state);
    assert.equal(plan.exitCode, 2);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]!.kind, "mint");
    assert.equal(plan.steps[0]!.details?.["amount"], "6000000000000");
  });

  it("non_testnet_passphrase_refused", () => {
    const mainnetState = healthyState({
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    });
    assert.throws(() => computePlan(MANIFEST, mainnetState), /Refusing non-testnet/);
    assert.throws(() => verifyDeployment(MANIFEST, mainnetState), /Refusing non-testnet/);
  });

  it("archived_instance_plans_restore_not_redeploy", () => {
    const state = healthyState({
      contracts: {
        market_core: { id: MC, status: "archived" },
        resolver: { id: RESOLVER, status: "present", wasmHash: "bbbb" },
        treasury: { id: TREASURY, status: "present", wasmHash: "cccc" },
        reasoning_registry: { id: REGISTRY, status: "present", wasmHash: "dddd" },
      },
    });
    const plan = computePlan(MANIFEST, state);
    assert.ok(plan.steps.some((s) => s.kind === "restore" && s.id === "restore-market_core"));
    assert.ok(!plan.steps.some((s) => s.id === "deploy-market_core"));
  });
});
