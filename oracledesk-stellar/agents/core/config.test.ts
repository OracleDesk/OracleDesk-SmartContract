import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  AgentConfigError,
  describeConfig,
  redactConfig,
  TESTNET_PASSPHRASE,
  loadAgentConfig,
  MAINNET_OPT_IN,
  NETWORKS,
  parseTunables,
  type ContractsReport,
  type LoadAgentConfigOptions,
  type NetworkProbe,
} from "./config.js";

// Real StrKeys, derived from fixed seeds so every run is identical.
const keypair = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const AGENT = keypair(1);
const MAKER = keypair(2);
const OTHER = keypair(3);

const CONTRACTS = {
  usdc: contract(10),
  market_core: contract(11),
  resolver: contract(12),
  treasury: contract(13),
  reasoning_registry: contract(14),
};

function deployment(overrides: Record<string, unknown> = {}) {
  return { deployer: keypair(9).publicKey(), agent: AGENT.publicKey(), contracts: { ...CONTRACTS }, ...overrides };
}

class FakeProbe implements NetworkProbe {
  calls = 0;
  constructor(
    private readonly served: string = NETWORKS.testnet.passphrase,
    private readonly report: ContractsReport = { missing: [], archived: [] },
  ) {}
  async passphrase(): Promise<string> {
    this.calls++;
    return this.served;
  }
  async contractsExist(): Promise<ContractsReport> {
    this.calls++;
    return this.report;
  }
}

interface Setup extends Partial<LoadAgentConfigOptions> {
  record?: unknown;
}

function load(env: NodeJS.ProcessEnv, s: Setup = {}) {
  const files: Record<string, string> = {};
  const logs: string[] = [];
  return {
    logs,
    files,
    run: () =>
      loadAgentConfig({
        role: "trader",
        argv: [],
        probe: new FakeProbe(),
        readFile: (path) => {
          files[path] = "read";
          return JSON.stringify(s.record ?? deployment());
        },
        log: (m) => logs.push(m),
        ...s,
        env,
      }),
  };
}

async function issuesOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AgentConfigError, `expected AgentConfigError, got ${String(err)}`);
    return err.issues;
  }
  assert.fail("expected the config to be rejected");
}

const LIVE = { AGENT_MODE: "live", AGENT_SECRET_KEY: AGENT.secret() };

test("an unset AGENT_MODE defaults to dry-run with documented defaults", async () => {
  const cfg = await load({}).run();
  assert.equal(cfg.mode, "dry-run");
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.networkPassphrase, NETWORKS.testnet.passphrase);
  assert.equal(cfg.rpcUrl, NETWORKS.testnet.rpcUrl);
  assert.equal(cfg.trading.minEdgeBps, 500);
  assert.equal(cfg.trading.tradeSizeStroops, 100_000_000n);
  assert.equal(cfg.maker.defaultSeedStroops, 1_500_000_000n);
  assert.equal(cfg.agentSecret, undefined);
  assert.match(cfg.deploymentsFile, /deployments\/testnet\.json$/);
});

test("unknown and empty agent modes are rejected", async () => {
  for (const AGENT_MODE of ["yolo", "Live", "", " dry-run"]) {
    const issues = await issuesOf(load({ AGENT_MODE }).run());
    assert.ok(issues.some((i) => i.startsWith("AGENT_MODE:")), `${JSON.stringify(AGENT_MODE)}: ${issues}`);
  }
});

test("invalid, non-integer and out-of-range numbers fail, all reported together", async () => {
  const issues = await issuesOf(
    load({
      MIN_EDGE_BPS: "",
      CONFIDENCE_THRESHOLD_BPS: "10001",
      SLIPPAGE_BPS: "12.5",
      DEADLINE_SECS: "NaN",
      FAIR_VALUE_BPS: "-1",
      AGENT_STARTUP_PROBE_TIMEOUT_MS: "0x10",
    }).run(),
  );
  for (const name of ["MIN_EDGE_BPS", "CONFIDENCE_THRESHOLD_BPS", "SLIPPAGE_BPS", "DEADLINE_SECS", "FAIR_VALUE_BPS", "AGENT_STARTUP_PROBE_TIMEOUT_MS"]) {
    assert.ok(issues.some((i) => i.startsWith(`${name}:`)), `${name} missing from ${issues.join(" | ")}`);
  }
});

test("invalid stroop amounts fail", async () => {
  const cases: Record<string, string>[] = [
    { TRADE_SIZE_STROOPS: "0" },
    { TRADE_SIZE_STROOPS: "-5" },
    { TRADE_SIZE_STROOPS: "1.5" },
    { TRADE_SIZE_STROOPS: "1e9" },
    { TRADE_SIZE_STROOPS: (1n << 127n).toString() },
    { DEFAULT_SEED_STROOPS: "999999999" },
    { DEFAULT_SEED_STROOPS: "" },
  ];
  for (const env of cases) {
    const [name] = Object.keys(env);
    const issues = await issuesOf(load(env).run());
    assert.ok(issues.some((i) => i.startsWith(`${name}:`)), `${JSON.stringify(env)}: ${issues}`);
  }
  const ok = await load({ TRADE_SIZE_STROOPS: ((1n << 127n) - 1n).toString(), DEFAULT_SEED_STROOPS: "1000000000" }).run();
  assert.equal(ok.maker.defaultSeedStroops, 1_000_000_000n);
});

test("live mode requires a secret", async () => {
  const issues = await issuesOf(load({ AGENT_MODE: "live" }).run());
  assert.ok(issues.some((i) => /TRADER_SECRET_KEY or AGENT_SECRET_KEY/.test(i)), issues.join(" | "));
});

test("a malformed secret is rejected even in dry-run", async () => {
  const issues = await issuesOf(load({ AGENT_SECRET_KEY: "SNOTAKEY" }).run());
  assert.ok(issues.some((i) => i.startsWith("AGENT_SECRET_KEY:")));
});

test("live mode requires the secret to match deployments.agent", async () => {
  const issues = await issuesOf(load({ AGENT_MODE: "live", AGENT_SECRET_KEY: OTHER.secret() }).run());
  assert.ok(issues.some((i) => i.includes(OTHER.publicKey()) && i.includes(AGENT.publicKey())), issues.join(" | "));

  const cfg = await load(LIVE).run();
  assert.equal(cfg.agentAddress, AGENT.publicKey());
  assert.equal(cfg.agentSecret, AGENT.secret());
});

test("a role key must match that role's registered agent", async () => {
  const record = deployment({ agents: { maker: MAKER.publicKey(), trader: OTHER.publicKey() } });
  const cfg = await load({ AGENT_MODE: "live", MAKER_SECRET_KEY: MAKER.secret() }, { role: "maker", record }).run();
  assert.equal(cfg.agentAddress, MAKER.publicKey());

  const issues = await issuesOf(load({ AGENT_MODE: "live", AGENT_SECRET_KEY: AGENT.secret() }, { role: "trader", record }).run());
  assert.ok(issues.some((i) => i.includes("agents.trader")), issues.join(" | "));
});

test("dry-run never carries the secret, even when one is configured", async () => {
  const cfg = await load({ AGENT_SECRET_KEY: AGENT.secret() }).run();
  assert.equal(cfg.agentSecret, undefined);
});

test("an RPC that serves another network's passphrase prevents live startup", async () => {
  const probe = new FakeProbe(NETWORKS.futurenet.passphrase);
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes(NETWORKS.futurenet.passphrase)), issues.join(" | "));
});

test("in dry-run a failing probe is a warning, not an error", async () => {
  const probe: NetworkProbe = {
    passphrase: async () => Promise.reject(new Error("connect ECONNREFUSED")),
    contractsExist: async () => ({ missing: [], archived: [] }),
  };
  const { run, logs } = load({}, { probe });
  const cfg = await run();
  assert.equal(cfg.mode, "dry-run");
  assert.ok(logs.some((l) => l.includes("ECONNREFUSED")));
});

test("live mode fails when the RPC cannot be reached", async () => {
  const probe: NetworkProbe = {
    passphrase: async () => Promise.reject(new Error("getNetwork timed out after 5000 ms")),
    contractsExist: async () => ({ missing: [], archived: [] }),
  };
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes("timed out")));
});

test("an explicit passphrase that disagrees with STELLAR_NETWORK is rejected", async () => {
  const issues = await issuesOf(load({ STELLAR_NETWORK_PASSPHRASE: NETWORKS.mainnet.passphrase }).run());
  assert.ok(issues.some((i) => i.startsWith("STELLAR_NETWORK_PASSPHRASE")));
});

test("contracts missing on chain produce an actionable stale-deployment error", async () => {
  const probe = new FakeProbe(undefined, { missing: [CONTRACTS.treasury], archived: [CONTRACTS.resolver] });
  const issues = await issuesOf(load(LIVE, { probe }).run());
  const missing = issues.find((i) => i.includes(CONTRACTS.treasury));
  assert.ok(missing && /contracts\.treasury/.test(missing) && /stale/.test(missing) && /deploy-testnet\.sh|DEPLOYMENTS_FILE/.test(missing), missing);
  const archived = issues.find((i) => i.includes(CONTRACTS.resolver));
  assert.ok(archived && /archived/.test(archived) && /restore/.test(archived), archived);
});

test("a deployment record without a required contract is stale", async () => {
  const { treasury: _drop, ...partial } = CONTRACTS;
  const issues = await issuesOf(load({}, { record: deployment({ contracts: partial }) }).run());
  assert.ok(issues.some((i) => /stale/.test(i) && i.includes("contracts.treasury")), issues.join(" | "));
});

test("deployment StrKeys are validated", async () => {
  const issues = await issuesOf(load({}, { record: deployment({ agent: "GNOTAKEY", contracts: { ...CONTRACTS, usdc: "CBAD" } }) }).run());
  assert.ok(issues.some((i) => i.includes("agent:")));
  assert.ok(issues.some((i) => i.includes("contracts.usdc:")));
});

test("a record with no network field is treated as testnet", async () => {
  const issues = await issuesOf(load({ STELLAR_NETWORK: "futurenet", DEPLOYMENTS_FILE: "deployments/futurenet.json" }).run());
  assert.ok(issues.some((i) => i.includes("assumed testnet")), issues.join(" | "));
  const ok = await load({ STELLAR_NETWORK: "futurenet" }, { record: deployment({ network: "futurenet" }) }).run();
  assert.equal(ok.rpcUrl, NETWORKS.futurenet.rpcUrl);
});

test("DEPLOYMENTS_FILE selects the record, and must agree with DEPLOYMENTS_PATH", async () => {
  const { run, files } = load({ DEPLOYMENTS_FILE: "/tmp/custom.json" });
  assert.equal((await run()).deploymentsFile, "/tmp/custom.json");
  assert.ok(files["/tmp/custom.json"]);
  const issues = await issuesOf(load({ DEPLOYMENTS_FILE: "a.json", DEPLOYMENTS_PATH: "b.json" }).run());
  assert.ok(issues.some((i) => i.includes("disagree")));
});

const MAINNET_OK = {
  STELLAR_NETWORK: "mainnet",
  STELLAR_NETWORK_PASSPHRASE: NETWORKS.mainnet.passphrase,
  STELLAR_RPC_URL: "https://rpc.example.org",
  DEPLOYMENTS_FILE: "deployments/mainnet.json",
  AGENT_ALLOW_MAINNET: MAINNET_OPT_IN,
};

test("mainnet starts only when every condition holds", async () => {
  const cfg = await load(MAINNET_OK, {
    record: deployment({ network: "mainnet" }),
    probe: new FakeProbe(NETWORKS.mainnet.passphrase),
  }).run();
  assert.equal(cfg.network, "mainnet");
});

test("mainnet is refused when any condition is missing, and every miss is reported", async () => {
  const record = deployment({ network: "mainnet" });
  const cases: [Record<string, string | undefined>, unknown, RegExp][] = [
    [{ AGENT_ALLOW_MAINNET: undefined }, record, /AGENT_ALLOW_MAINNET/],
    [{ AGENT_ALLOW_MAINNET: "yes" }, record, /AGENT_ALLOW_MAINNET/],
    [{ DEPLOYMENTS_FILE: "deployments/testnet.json" }, record, /testnet\.json/],
    [{}, deployment(), /declare "network": "mainnet"/],
    [{ STELLAR_RPC_URL: undefined }, record, /STELLAR_RPC_URL/],
  ];
  for (const [change, rec, expected] of cases) {
    const issues = await issuesOf(load({ ...MAINNET_OK, ...change }, { record: rec }).run());
    assert.ok(issues.some((i) => i.startsWith("mainnet refused") && expected.test(i)), `${JSON.stringify(change)}: ${issues.join(" | ")}`);
  }
  // Nothing opted in: every condition is listed at once.
  const all = await issuesOf(load({ STELLAR_NETWORK: "mainnet", DEPLOYMENTS_FILE: "deployments/testnet.json" }).run());
  assert.equal(all.filter((i) => i.startsWith("mainnet refused")).length, 4, all.join(" | "));
});

test("documented contract id overrides replace the record's ids and are logged", async () => {
  const replacement = contract(42);
  const { run, logs } = load({ TREASURY_CONTRACT_ID: replacement, USDC_CONTRACT_ID: "" });
  const cfg = await run();
  assert.equal(cfg.deployments.contracts.treasury, replacement);
  assert.equal(cfg.deployments.contracts.usdc, CONTRACTS.usdc);
  assert.deepEqual(cfg.contractOverrides, [{ variable: "TREASURY_CONTRACT_ID", contract: "treasury", from: CONTRACTS.treasury, to: replacement }]);
  assert.ok(logs.some((l) => l.includes("TREASURY_CONTRACT_ID") && l.includes(replacement)));

  const issues = await issuesOf(load({ RESOLVER_CONTRACT_ID: "CNOTACONTRACT" }).run());
  assert.ok(issues.some((i) => i.startsWith("RESOLVER_CONTRACT_ID:")));
});

test("redacted output never contains the secret", async () => {
  const cfg = await load({ ...LIVE, MAKER_SECRET_KEY: MAKER.secret() }).run();
  const printed = JSON.stringify(describeConfig(cfg));
  assert.ok(!printed.includes(AGENT.secret()));
  assert.ok(!printed.includes(MAKER.secret()));
  assert.deepEqual(describeConfig(cfg).agentSecret, { publicKey: AGENT.publicKey(), redacted: true });
});

test("offline dry-run and --print-config never call the network probe", async () => {
  const probe = new FakeProbe();
  await load({}, { probe, argv: ["--offline"] }).run();
  await load(LIVE, { probe, argv: ["--print-config"] }).run();
  assert.equal(probe.calls, 0);

  const issues = await issuesOf(load(LIVE, { argv: ["--offline"] }).run());
  assert.ok(issues.some((i) => i.includes("--offline")));
});

test("live startup runs both probes", async () => {
  const probe = new FakeProbe();
  await load(LIVE, { probe }).run();
  assert.equal(probe.calls, 2);
});

test("parseTunables validates the same fields without a deployment", () => {
  assert.equal(parseTunables({ SLIPPAGE_BPS: "100" }).trading.slippageBps, 100);
  assert.throws(() => parseTunables({ SLIPPAGE_BPS: "1.0" }), AgentConfigError);
});

test("passphrase constants and redactConfig alias never expose secrets", async () => {
  assert.equal(TESTNET_PASSPHRASE, NETWORKS.testnet.passphrase);
  const cfg = await load(LIVE).run();
  const redacted = JSON.stringify(redactConfig(cfg));
  assert.ok(!redacted.includes(AGENT.secret()));
});
