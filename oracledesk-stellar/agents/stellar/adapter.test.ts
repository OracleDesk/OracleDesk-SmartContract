import assert from "node:assert/strict";
import test from "node:test";
import { StellarAdapter, type Deployments } from "./adapter.js";

const deployments: Deployments = {
  deployer: "GDEPLOYER",
  agent: "GAGENT",
  contracts: {
    usdc: "CUSDC",
    market_core: "CMARKETCORE",
    resolver: "CRESOLVER",
    treasury: "CTREASURY",
    reasoning_registry: "CREGISTRY",
  },
};

test("dry-run mode never requires an agent secret", () => {
  assert.doesNotThrow(() => {
    new StellarAdapter({
      mode: "dry-run",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      deployments,
    });
  });
});

test("live mode without an agent secret throws immediately", () => {
  assert.throws(() => {
    new StellarAdapter({
      mode: "live",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      deployments,
    });
  }, /agentSecret/);
});

test("dry-run agentBuy describes the call without touching the network", async () => {
  const adapter = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  });
  const result = await adapter.agentBuy({
    market_id: 0n,
    outcome: { tag: "Yes", values: undefined },
    collateral_in: 10_000_000n,
    min_shares_out: 0n,
  });
  assert.equal(result.dryRun, true);
  if (result.dryRun) {
    assert.equal(result.contractId, "CTREASURY");
    assert.equal(result.method, "agent_buy");
  }
});
