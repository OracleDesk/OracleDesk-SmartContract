import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig, Tunables } from "../core/config.js";
import { parseTunables } from "../core/config.js";
import { IpfsTraceStore } from "../core/ipfs-store.js";
import type { Deployments, StellarAdapter } from "../stellar/adapter.js";
import { makerDeps, sharedTraceStore, traderDeps, watcherDeps } from "./wiring.js";

const DEPLOYMENTS: Deployments = {
  deployer: "GDEPLOYER",
  agent: "GAGENT",
  agents: { maker: "GMAKER", trader: "GTRADER" },
  contracts: {
    usdc: "GUSDC",
    market_core: "GMARKET",
    resolver: "GRESOLVER",
    treasury: "GTREASURY",
    reasoning_registry: "GREGISTRY",
  },
};

/** Live mode plus an IPFS pinning endpoint: the production trace-store path. */
function liveEnv(): NodeJS.ProcessEnv {
  return {
    AGENT_MODE: "live",
    TRACE_STORE: "ipfs",
    IPFS_KUBO_API_URL: "http://127.0.0.1:5001",
    IPFS_GATEWAY_URL: "https://gw.example/ipfs",
  };
}

function tunables(env: NodeJS.ProcessEnv = liveEnv()): Tunables {
  return parseTunables(env);
}

function config(env: NodeJS.ProcessEnv = liveEnv()): AgentConfig {
  return {
    ...tunables(env),
    role: "trader",
    mode: "live",
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    agentAddress: "GAGENT",
    deployments: DEPLOYMENTS,
    deploymentsFile: "",
    contractOverrides: [],
    probeTimeoutMs: 0,
    offline: true,
    printConfig: false,
  };
}

test("sharedTraceStore uses the live IPFS store instead of a local:// store", () => {
  const store = sharedTraceStore(tunables());
  assert.ok(store instanceof IpfsTraceStore);
});

test("wiring hands the same live store to every trace-writing task", () => {
  const t = tunables();
  const cfg = config();
  const store = sharedTraceStore(t);
  const adapter = {} as StellarAdapter;

  const maker = makerDeps(t, adapter, DEPLOYMENTS, store);
  const trader = traderDeps(t, adapter, DEPLOYMENTS, () => 0, undefined, undefined, store);
  const watcher = watcherDeps(cfg, adapter, store);

  assert.strictEqual(maker.traceStore, store);
  assert.strictEqual(trader.traceStore, store);
  assert.strictEqual(watcher.traceStore, store);
});
