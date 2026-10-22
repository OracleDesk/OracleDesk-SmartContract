import "dotenv/config";
import { rpc } from "@stellar/stellar-sdk";
import { MemoryPaymentLedger, SqlitePaymentLedger } from "./payment-ledger.js";
import {
  createTraceApi,
  MapTraceRepository,
  type TraceRecord,
  type TraceRepository,
} from "./trace-api.js";
import { createRegistryTraceRepository } from "./registry-trace-repository.js";

interface BuiltRepository {
  repository: TraceRepository;
  listRepository?: TraceListRepository;
}

async function buildRepository(): Promise<BuiltRepository> {
  const contractId = process.env.REASONING_REGISTRY_CONTRACT_ID;
  if (contractId) {
    console.log(
      `OracleDesk x402: reading traces from reasoning-registry ${contractId}`,
    );
    return createRegistryTraceRepository({
      contractId,
      rpcUrl:
        process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase:
        process.env.STELLAR_NETWORK_PASSPHRASE ??
        "Test SDF Network ; September 2015",
    });
    return { repository, listRepository: repository };
  }
  console.log(
    "OracleDesk x402: REASONING_REGISTRY_CONTRACT_ID not set — falling back to TRACE_RECORDS_JSON",
  );
  const records = JSON.parse(
    process.env.TRACE_RECORDS_JSON ?? "[]",
  ) as TraceRecord[];
  return new MapTraceRepository(
    new Map(records.map((record) => [record.traceId, record])),
  );
}

async function main() {
  const mode = process.env.X402_LEDGER ?? "sqlite";
  if (!["memory", "sqlite"].includes(mode))
    throw new Error("X402_LEDGER must be memory or sqlite");
  const ledgerPath = process.env.X402_LEDGER_PATH ?? "./.x402-ledger.sqlite";
  const ledger =
    mode === "memory"
      ? new MemoryPaymentLedger()
      : new SqlitePaymentLedger(ledgerPath);
  await ledger.reconcileStuck(0);
  const app = createTraceApi({
    ledger,
    ledgerSequence: async (network) => {
      const url =
        network === "stellar:testnet"
          ? (process.env.STELLAR_TESTNET_RPC_URL ??
            "https://soroban-testnet.stellar.org")
          : (process.env.STELLAR_MAINNET_RPC_URL ??
            "https://soroban.stellar.org");
      return (await new rpc.Server(url, { timeout: 5 }).getLatestLedger())
        .sequence;
    },
    adminToken: process.env.X402_ADMIN_TOKEN,
    requireAllNetworks: process.env.X402_REQUIRE_ALL_NETWORKS !== "false",
    traceLoadTimeoutMs: Number(process.env.X402_TRACE_LOAD_TIMEOUT_MS ?? 10000),
    maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_SECONDS ?? 60),
    facilitatorTimeoutMs: Number(
      process.env.X402_FACILITATOR_TIMEOUT_MS ?? 5000,
    ),
    repository: await buildRepository(),
    ipfsGateway: process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io/ipfs",
    price: process.env.TRACE_PRICE_USDC ?? "0.01",
    paymentsDisabled: process.env.PAYMENTS_DISABLED === "1",
    networks: [
      ...(process.env.TESTNET_SERVER_STELLAR_ADDRESS &&
      process.env.TESTNET_FACILITATOR_URL
        ? [
            {
              network: "stellar:testnet" as const,
              payTo: process.env.TESTNET_SERVER_STELLAR_ADDRESS,
              facilitatorUrl: process.env.TESTNET_FACILITATOR_URL,
              facilitatorApiKey: process.env.TESTNET_FACILITATOR_API_KEY,
            },
          ]
        : []),
      ...(process.env.MAINNET_SERVER_STELLAR_ADDRESS &&
      process.env.MAINNET_FACILITATOR_URL
        ? [
            {
              network: "stellar:pubnet" as const,
              payTo: process.env.MAINNET_SERVER_STELLAR_ADDRESS,
              facilitatorUrl: process.env.MAINNET_FACILITATOR_URL,
              facilitatorApiKey: process.env.MAINNET_FACILITATOR_API_KEY,
            },
          ]
        : []),
    ],
  });

  try {
    await app.locals.ready;
  } catch (error) {
    ledger.close();
    throw error;
  }
  console.log("OracleDesk x402 networks:", app.locals.networks);
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    console.log(`OracleDesk x402 trace API listening on port ${port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.close(() => {
        ledger.close();
      });
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
