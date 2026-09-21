import "dotenv/config";
import { createTraceApi, MapTraceRepository, type TraceRecord } from "./trace-api.js";

const records = JSON.parse(process.env.TRACE_RECORDS_JSON ?? "[]") as TraceRecord[];
const app = createTraceApi({
  repository: new MapTraceRepository(new Map(records.map((record) => [record.traceId, record]))),
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
