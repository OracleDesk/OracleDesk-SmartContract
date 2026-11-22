import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import {
  agentCredentials,
  loadDeployments,
  StellarAdapter,
  type Deployments,
  type StellarAdapterOptions,
} from "./adapter.js";

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
  }, /signer or agentSecret/);
});

test("live mode accepts a policy-backed signer with the configured agent identity", () => {
  const keypair = Keypair.random();
  const signer = new KeypairSigner(keypair, "Test SDF Network ; September 2015");
  const adapter = new StellarAdapter({
    mode: "live",
    signer,
    agentAddress: keypair.publicKey(),
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  });
  assert.equal(adapter.agent, keypair.publicKey());
});

test("live mode rejects an injected signer that does not match the configured agent", () => {
  const keypair = Keypair.random();
  assert.throws(() => new StellarAdapter({
    mode: "live",
    signer: new KeypairSigner(keypair, "Test SDF Network ; September 2015"),
    agentAddress: Keypair.random().publicKey(),
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  }), /does not match/);
});

test("adapter rejects unknown mode", () => {
  assert.throws(() => {
    new StellarAdapter({
      mode: "yolo" as unknown as "dry-run",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      deployments,
    });
  }, /unknown mode/);
});

test("an unknown mode is rejected by the constructor without echoing the secret", () => {
  const secret = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();
  assert.throws(
    () =>
      new StellarAdapter({
        mode: "Live",
        agentSecret: secret,
        networkPassphrase: "Test SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org",
        deployments,
      } as unknown as StellarAdapterOptions),
    (err: Error) => /unknown mode "Live"/.test(err.message) && !err.message.includes(secret),
  );
});

test("an unknown mode that reaches run() throws before any network access", async () => {
  const adapter = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  });
  // Simulate the options being corrupted after construction.
  (adapter as unknown as { opts: { mode: string } }).opts.mode = "yolo";
  await assert.rejects(
    adapter.agentBuy({ market_id: 0n, outcome: { tag: "Yes", values: undefined }, collateral_in: 1n, min_shares_out: 0n }),
    /unknown mode "yolo"/,
  );
});

test("dry-run refuses to be handed an agent secret", () => {
  assert.throws(
    () =>
      new StellarAdapter({
        mode: "dry-run",
        agentSecret: Keypair.random().secret(),
        networkPassphrase: "Test SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org",
        deployments,
      } as unknown as StellarAdapterOptions),
    /dry-run mode must not be given a signer or agentSecret/,
  );
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

test("dry-run unwindSell describes caller and market", async () => {
  const adapter = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    agentAddress: "GUNWINDER",
    deployments,
  });
  const result = await adapter.unwindSell({
    market_id: 4n,
    outcome: { tag: "No", values: undefined },
    collateral_out: 25n,
    max_shares_in: 30n,
  });
  assert.equal(result.dryRun, true);
  if (result.dryRun) {
    assert.equal(result.contractId, "CTREASURY");
    assert.equal(result.method, "unwind_sell");
    assert.deepEqual(result.args, {
      caller: "GUNWINDER",
      market_id: 4n,
      outcome: { tag: "No", values: undefined },
      collateral_out: 25n,
      max_shares_in: 30n,
    });
  }
});

test("dry-run agentBuy includes agent address", async () => {
  const adapter = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    agentAddress: "GTRADER",
    deployments,
  });
  const result = await adapter.agentBuy({
    market_id: 0n,
    outcome: { tag: "Yes", values: undefined },
    collateral_in: 10_000_000n,
    min_shares_out: 1n,
  });
  assert.equal(result.dryRun, true);
  if (result.dryRun) {
    assert.equal((result.args as { agent: string }).agent, "GTRADER");
  }
  // Without a configured address, the constructor agent acts.
  const fallback = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  });
  assert.equal(fallback.agent, "GAGENT");
});

test("market-maker uses maker key when configured", () => {
  const withAgents: Deployments = { ...deployments, agents: { maker: "GMAKER", trader: "GTRADER" } };
  assert.deepEqual(
    agentCredentials("maker", { MAKER_SECRET_KEY: "SMAKER", AGENT_SECRET_KEY: "SSHARED" }, withAgents),
    { agentSecret: "SMAKER", agentAddress: "GMAKER" },
  );
  assert.deepEqual(
    agentCredentials("trader", { MAKER_SECRET_KEY: "SMAKER", AGENT_SECRET_KEY: "SSHARED" }, withAgents),
    { agentSecret: "SSHARED", agentAddress: "GTRADER" },
  );
  // Pre-registry deployments fall back to the single shared agent.
  assert.deepEqual(agentCredentials("maker", { AGENT_SECRET_KEY: "SSHARED" }, deployments), {
    agentSecret: "SSHARED",
    agentAddress: "GAGENT",
  });
});

test("dry-run agentBuyV2 describes the bounded call without touching the network", async () => {
  const adapter = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  });
  const result = await adapter.agentBuyV2({
    market_id: 0n,
    outcome: { tag: "Yes", values: undefined },
    collateral_in: 10_000_000n,
    min_shares_out: 9_500_000n,
    limit_price_bps: 6000,
    deadline: 1_000_060n,
  });
  assert.equal(result.dryRun, true);
  if (result.dryRun) {
    assert.equal(result.contractId, "CTREASURY");
    assert.equal(result.method, "agent_buy_v2");
  }
});

test("dry-run agentSellV2 describes the bounded call without touching the network", async () => {
  const adapter = new StellarAdapter({
    mode: "dry-run",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    deployments,
  });
  const result = await adapter.agentSellV2({
    market_id: 0n,
    outcome: { tag: "No", values: undefined },
    collateral_out: 5_000_000n,
    max_shares_in: 6_000_000n,
    limit_price_bps: 4000,
    deadline: 1_000_060n,
  });
  assert.equal(result.dryRun, true);
  if (result.dryRun) {
    assert.equal(result.contractId, "CTREASURY");
    assert.equal(result.method, "agent_sell_v2");
  }
});

test("loadDeployments honours DEPLOYMENTS_PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "oracledesk-deployments-"));
  const path = join(dir, "local.json");
  writeFileSync(path, JSON.stringify({ ...deployments, contracts: { ...deployments.contracts, usdc: "CLOCAL" } }));
  const previous = process.env.DEPLOYMENTS_PATH;
  process.env.DEPLOYMENTS_PATH = path;
  try {
    assert.equal(loadDeployments().contracts.usdc, "CLOCAL");
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENTS_PATH;
    else process.env.DEPLOYMENTS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
