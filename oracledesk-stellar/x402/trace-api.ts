import type { RequestHandler } from "express";
import express, { type Express, type Request, type Response } from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ipfsUrl, verifyTraceHash, type TraceRecord } from "./trace-verification.js";

export type { TraceRecord };

export interface TraceRepository {
  get(traceId: string): Promise<TraceRecord | undefined>;
}

export interface TracePaymentNetwork {
  network: "stellar:testnet" | "stellar:pubnet";
  payTo: string;
  facilitatorUrl: string;
  facilitatorApiKey?: string;
}

export interface TraceApiOptions {
  repository: TraceRepository;
  ipfsGateway: string;
  price: string;
  networks: TracePaymentNetwork[];
  fetchImpl?: typeof fetch;
}

export class MapTraceRepository implements TraceRepository {
  public constructor(private readonly records: ReadonlyMap<string, TraceRecord>) {}

  public async get(traceId: string): Promise<TraceRecord | undefined> {
    return this.records.get(traceId);
  }
}

async function loadVerifiedTrace(
  repository: TraceRepository,
  gateway: string,
  traceId: string,
  fetchImpl: typeof fetch,
): Promise<{ record: TraceRecord; content: unknown } | undefined> {
  const record = await repository.get(traceId);
  if (!record) return undefined;

  const response = await fetchImpl(ipfsUrl(gateway, record.ipfsCid));
  if (!response.ok) {
    throw new Error(`IPFS gateway returned HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!verifyTraceHash(bytes, record.traceHash)) {
    throw new Error(`Trace ${traceId} failed on-chain hash verification`);
  }

  try {
    return { record, content: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    throw new Error(`Trace ${traceId} is not valid JSON`);
  }
}

function createPaymentHandler(config: TracePaymentNetwork, options: TraceApiOptions): RequestHandler {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: config.facilitatorApiKey
      ? async () => {
          const headers = { Authorization: `Bearer ${config.facilitatorApiKey}` };
          return { verify: headers, settle: headers, supported: headers };
        }
      : undefined,
  });
  const x402Server = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactStellarScheme(),
  );

  return paymentMiddleware(
    {
      "GET /traces/:traceId": {
        accepts: [{
          scheme: "exact",
          price: options.price,
          network: config.network,
          payTo: config.payTo,
        }],
        description: "Paid access to an OracleDesk reasoning trace",
      },
    },
    x402Server,
  );
}

export function createTraceApi(options: TraceApiOptions): Express {
  if (options.networks.length === 0) {
    throw new Error("At least one x402 Stellar payment network is required");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const app = express();

  for (const network of options.networks) {
    app.use(createPaymentHandler(network, options));
  }

  app.get("/traces/:traceId", async (req: Request, res: Response) => {
    try {
      const traceId = Array.isArray(req.params.traceId)
        ? req.params.traceId[0]
        : req.params.traceId;
      const result = await loadVerifiedTrace(
        options.repository,
        options.ipfsGateway,
        traceId,
        fetchImpl,
      );
      if (!result) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }
      res.json({
        traceId: result.record.traceId,
        traceHash: result.record.traceHash,
        content: result.content,
      });
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "Trace retrieval failed",
      });
    }
  });

  return app;
}
