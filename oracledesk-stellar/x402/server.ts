import "dotenv/config";
import { rpc } from "@stellar/stellar-sdk";
import { MemoryPaymentLedger, SqlitePaymentLedger } from "./payment-ledger.js";
import {
  createTraceApi,
  MapTraceRepository,
  type TraceListRepository,
  type TraceRecord,
  type TraceRepository,
} from "./trace-api.js";
import { createRegistryTraceRepository } from "./registry-trace-repository.js";
import {
  RefundExecutor,
  refundPolicyFromEnv,
  sweepRefunds,
} from "./refunds.js";

/** Soroban RPC for a payment network; always chosen from the entry's network. */
function rpcUrlFor(network: string): string {
  return network === "stellar:testnet"
    ? (process.env.STELLAR_TESTNET_RPC_URL ??
        "https://soroban-testnet.stellar.org")
    : (process.env.STELLAR_MAINNET_RPC_URL ?? "https://soroban.stellar.org");
}

interface BuiltRepository {
  repository: TraceRepository;
  listRepository?: TraceListRepository;
}

async function buildRepository(): Promise<BuiltRepository> {
  const contractId = process.env.REASONING_REGISTRY_CONTRACT_ID;
  if (contractId) {
    logger.info(
      { event: "x402_repository", source: "reasoning-registry", contractId },
      "reading traces from reasoning-registry",
    );
    const repository = await createRegistryTraceRepository({
      contractId,
      rpcUrl:
        process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase:
        process.env.STELLAR_NETWORK_PASSPHRASE ??
        "Test SDF Network ; September 2015",
    });
    return { repository, listRepository: repository };
  }
  logger.warn(
    { event: "x402_repository", source: "TRACE_RECORDS_JSON" },
    "REASONING_REGISTRY_CONTRACT_ID not set; falling back to TRACE_RECORDS_JSON",
  );
  const records = JSON.parse(
    process.env.TRACE_RECORDS_JSON ?? "[]",
  ) as TraceRecord[];
  return {
    repository: new MapTraceRepository(
      new Map(records.map((record) => [record.traceId, record])),
    ),
  };
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
  // Refunds (#279): settled-but-undelivered payments past the redelivery
  // window are refunded from a dedicated account. Fail fast on a missing key.
  const refundPolicy = refundPolicyFromEnv(process.env);
  const refundsEnabled = process.env.X402_REFUNDS_ENABLED === "1";
  if (refundsEnabled && !process.env.X402_REFUND_SECRET) {
    ledger.close();
    throw new Error("X402_REFUNDS_ENABLED=1 requires X402_REFUND_SECRET");
  }
  const refundExecutor = refundsEnabled
    ? new RefundExecutor({
        ledger,
        policy: refundPolicy,
        secret: process.env.X402_REFUND_SECRET!,
        rpcFor: (network) => new rpc.Server(rpcUrlFor(network), { timeout: 10 }),
      })
    : undefined;
  // #300: no longer clobber in-flight payments at startup. Reconciliation
  // is age-based and only touches entries older than the settlement bound.
  const reconcileMs = Number(process.env.X402_RECONCILE_MS ?? 30_000);
  const reconcileBatch = Number(process.env.X402_RECONCILE_BATCH ?? 50);
  const settleBound = Number(
    (process.env.X402_MAX_TIMEOUT_SECONDS ?? 60) as number,
  ) * 1000 + Number(process.env.X402_FACILITATOR_TIMEOUT_MS ?? 5000);
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  // Select settling entries older than the bound and mark them indeterminate
  // (the reconciler then decides their fate from chain state). Live requests
  // owned by another replica are never touched.
  const reconcile = () =>
    ledger.reconcileStuck(settleBound).then((n) => {
      if (n > 0)
        logger.warn(
          { event: "x402_reconciled", count: n },
          "reconciled stuck payments",
        );
    }).catch((err) =>
      logger.error({ event: "x402_reconcile_failed", err }, "reconciliation error"),
    );
  reconcileTimer = setInterval(reconcile, reconcileMs);
  // #330: fails startup when receipts are configured (or required) but the
  // key set is missing or invalid; payments are never settled unreceipted.
  let receiptSigner;
  try {
    receiptSigner = await receiptSignerFromEnv();
  } catch (error) {
    if (reconcileTimer) clearInterval(reconcileTimer);
    ledger.close();
    throw error;
  }
  const built = await buildRepository();
  const networks = [
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
  ];
  const metrics = createMetrics({
    networks: networks.map((n) => n.network),
    countByState: () => ledger.countByState(),
    defaultMetrics: true,
  });
  const app = createTraceApi({
    logger,
    metrics,
    receiptSigner,
    ledger,
    redeliveryWindowSecs: refundPolicy.redeliveryWindowMs / 1000,
    ledgerSequence: async (network) => {
      return (
        await new rpc.Server(rpcUrlFor(network), { timeout: 5 }).getLatestLedger()
      ).sequence;
    },
    adminToken: process.env.X402_ADMIN_TOKEN,
    requireAllNetworks: process.env.X402_REQUIRE_ALL_NETWORKS !== "false",
    traceLoadTimeoutMs: Number(process.env.X402_TRACE_LOAD_TIMEOUT_MS ?? 10000),
    maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_SECONDS ?? 60),
    facilitatorTimeoutMs: Number(
      process.env.X402_FACILITATOR_TIMEOUT_MS ?? 5000,
    ),
    ...built,
    ipfsGateway: process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io/ipfs",
    price: process.env.TRACE_PRICE_USDC ?? "0.01",
    networks,
  });

  try {
    await app.locals.ready;
  } catch (error) {
    ledger.close();
    throw error;
  }
  logger.info(
    {
      event: "x402_networks",
      networks: app.locals.networks,
      receipts: receiptSigner ? receiptSigner.kid : null,
    },
    "x402 networks ready",
  );
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    logger.info({ event: "x402_listening", port }, "x402 trace API listening");
  });
  let sweeping = false;
  const sweeper = refundExecutor
    ? setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        sweepRefunds(ledger, refundExecutor, refundPolicy, {
          batch: Number(process.env.X402_REFUND_BATCH ?? 10),
        })
          .catch((error) =>
            console.error(JSON.stringify({ event: "x402_refund_sweep_failed", error: String(error) })),
          )
          .finally(() => {
            sweeping = false;
          });
      }, Number(process.env.X402_REFUND_SWEEP_MS ?? 60_000))
    : undefined;
  // Separate listener: /metrics is never exposed on the public API port.
  const metricsPort = process.env.METRICS_PORT
    ? Number(process.env.METRICS_PORT)
    : undefined;
  const metricsServer =
    metricsPort !== undefined ? startMetricsServer(metricsPort, metrics) : undefined;
  if (metricsServer)
    logger.info({ event: "x402_metrics_listening", port: metricsPort }, "metrics listening");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      // Stop the sweeper before the ledger it writes to is closed.
      if (sweeper) clearInterval(sweeper);
      if (reconcileTimer) clearInterval(reconcileTimer);
      metricsServer?.close();
      server.close(() => {
        ledger.close();
      });
    });
}

main().catch((err) => {
  logger.fatal({ err }, "x402 startup failed");
  process.exit(1);
});