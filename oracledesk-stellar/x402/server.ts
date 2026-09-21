import "dotenv/config";
import { createTraceApi, MapTraceRepository, type TraceRecord, type TraceRepository } from "./trace-api.js";
import { createRegistryTraceRepository } from "./registry-trace-repository.js";

async function buildRepository(): Promise<TraceRepository> {
  const contractId = process.env.REASONING_REGISTRY_CONTRACT_ID;
  if (contractId) {
    console.log(`OracleDesk x402: reading traces from reasoning-registry ${contractId}`);
    return createRegistryTraceRepository({
      contractId,
      rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase:
        process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    });
  }
  console.log(
    "OracleDesk x402: REASONING_REGISTRY_CONTRACT_ID not set — falling back to TRACE_RECORDS_JSON",
  );
  const records = JSON.parse(process.env.TRACE_RECORDS_JSON ?? "[]") as TraceRecord[];
  return new MapTraceRepository(new Map(records.map((record) => [record.traceId, record])));
}

async function main() {
  const app = createTraceApi({
    repository: await buildRepository(),
    ipfsGateway: process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io/ipfs",
    price: process.env.TRACE_PRICE_USDC ?? "0.01",
    networks: [
      ...(process.env.TESTNET_SERVER_STELLAR_ADDRESS && process.env.TESTNET_FACILITATOR_URL
        ? [{
            network: "stellar:testnet" as const,
            payTo: process.env.TESTNET_SERVER_STELLAR_ADDRESS,
            facilitatorUrl: process.env.TESTNET_FACILITATOR_URL,
            facilitatorApiKey: process.env.TESTNET_FACILITATOR_API_KEY,
          }]
        : []),
      ...(process.env.MAINNET_SERVER_STELLAR_ADDRESS && process.env.MAINNET_FACILITATOR_URL
        ? [{
            network: "stellar:pubnet" as const,
            payTo: process.env.MAINNET_SERVER_STELLAR_ADDRESS,
            facilitatorUrl: process.env.MAINNET_FACILITATOR_URL,
            facilitatorApiKey: process.env.MAINNET_FACILITATOR_API_KEY,
          }]
        : []),
    ],
  });

  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => {
    console.log(`OracleDesk x402 trace API listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
