import express, { type Express, type Response } from "express";
import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual } from "node:crypto";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  FacilitatorTimeoutError,
  type FacilitatorClient,
  type HTTPResponseInstructions,
  type RoutesConfig,
  type HTTPProcessResult,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExpressAdapter } from "@x402/express";
import { validateStellarDestinationAddress } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import {
  ipfsUrl,
  verifyTraceHash,
  type TraceRecord,
} from "./trace-verification.js";
import {
  MemoryPaymentLedger,
  paymentIdentity,
  type PaymentLedger,
  type PaymentEntry,
} from "./payment-ledger.js";
export type { TraceRecord };
export interface TraceRepository {
  get(traceId: string): Promise<TraceRecord | undefined>;
  getFull?(traceId: string): Promise<(TraceRecord & { marketId?: bigint; agent?: string }) | undefined>;
  market_trace_count?(args: { market_id: bigint }): Promise<bigint>;
  market_trace_at?(args: { market_id: bigint; index: bigint }): Promise<bigint | null>;
  trace_count?(): Promise<bigint>;
}

/**
 * A trace row as returned by the reasoning-registry's paginated secondary
 * indexes (#57). Unlike {@link TraceRecord} it is metadata only: the IPFS
 * body is fetched and hash-verified only by the *paid* `GET /traces/:traceId`.
 *
 * Deliberately carries **no `ipfsCid`**: the listing routes are unpaid, and
 * returning the CID would let a caller fetch the content straight from the
 * gateway and bypass the paywall.
 */
export interface TraceListEntry {
  traceId: string;
  traceHash: string;
  marketId: string;
  agent: string;
  action: string;
  publishedAt: string;
}

export interface TraceListPage {
  items: TraceListEntry[];
  /** Index of the first entry the next page would return. */
  next: string;
  total: string;
}

/**
 * Optional listing surface backed by the reasoning-registry's #57 indexes:
 * "everything agent X published" and "every Buy decision on market 7".
 */
export interface TraceListRepository {
  listByAgent(agent: string, cursor?: string, limit?: number): Promise<TraceListPage>;
  listByMarketAction(
    marketId: string,
    action: string,
    cursor?: string,
    limit?: number,
  ): Promise<TraceListPage>;
}
export interface TracePaymentNetwork {
  network: "stellar:testnet" | "stellar:pubnet";
  payTo: string;
  facilitatorUrl: string;
  facilitatorApiKey?: string;
}
export interface TraceApiOptions {
  repository: TraceRepository;
  /** Present only when the deployment has a reasoning-registry configured. */
  listRepository?: TraceListRepository;
  ipfsGateway: string;
  price: string;
  networks: TracePaymentNetwork[];
  fetchImpl?: typeof fetch;
  requireAllNetworks?: boolean;
  traceLoadTimeoutMs?: number;
  maxTimeoutSeconds?: number;
  facilitatorTimeoutMs?: number;
  ledger?: PaymentLedger;
  adminToken?: string;
  ledgerSequence?: (network: string) => Promise<number>;
}
export class MapTraceRepository implements TraceRepository {
  constructor(private readonly records: ReadonlyMap<string, TraceRecord>) {}
  async get(traceId: string) {
    return this.records.get(traceId);
  }
}
export class NetworkScopedFacilitator implements FacilitatorClient {
  constructor(
    readonly network: string,
    private readonly client: FacilitatorClient,
  ) {}
  async getSupported() {
    const s = await this.client.getSupported();
    return { ...s, kinds: s.kinds.filter((k) => k.network === this.network) };
  }
  verify(p: PaymentPayload, r: PaymentRequirements) {
    this.assertNetwork(r);
    return this.client.verify(p, r);
  }
  settle(p: PaymentPayload, r: PaymentRequirements) {
    this.assertNetwork(r);
    return this.client.settle(p, r);
  }
  private assertNetwork(r: PaymentRequirements) {
    if (r.network !== this.network)
      throw new Error("Facilitator network mismatch");
  }
}
function authorizationScheme() {
  const scheme = new ExactStellarScheme();
  return {
    scheme: scheme.scheme,
    defaultAssetTransferMethod: scheme.defaultAssetTransferMethod,
    paymentFlows: {
      default: {
        supported: ["authorization"] as const,
        default: "authorization" as const,
      },
    },
    parsePrice: scheme.parsePrice.bind(scheme),
    getAssetDecimals: scheme.getAssetDecimals.bind(scheme),
    enhancePaymentRequirements: scheme.enhancePaymentRequirements.bind(scheme),
  };
}
export function facilitatorFor(
  n: TracePaymentNetwork,
  timeoutMs = 5000,
): FacilitatorClient {
  return new NetworkScopedFacilitator(
    n.network,
    new HTTPFacilitatorClient({
      url: n.facilitatorUrl,
      timeoutMs,
      createAuthHeaders: n.facilitatorApiKey
        ? async () => {
            const h = { Authorization: `Bearer ${n.facilitatorApiKey}` };
            return { verify: h, settle: h, supported: h };
          }
        : undefined,
    }),
  );
}
export function buildRoutes(options: TraceApiOptions): RoutesConfig {
  return {
    "GET /traces/:traceId": {
      accepts: options.networks.map((n) => ({
        scheme: "exact",
        network: n.network,
        payTo: n.payTo,
        price: options.price,
        maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
        extra: { paymentFlow: "authorization" },
      })),
      description: "Paid access to an OracleDesk reasoning trace",
      mimeType: "application/json",
    },
  };
}
export function writeInstructions(
  res: Response,
  instructions: HTTPResponseInstructions,
) {
  res.status(instructions.status).set(instructions.headers);
  if (instructions.isHtml) res.send(instructions.body);
  else res.json(instructions.body);
}
async function loadVerifiedTrace(
  options: TraceApiOptions,
  traceId: string,
  signal: AbortSignal,
) {
  const record = await options.repository.get(traceId);
  if (!record) return undefined;
  const response = await (options.fetchImpl ?? fetch)(
    ipfsUrl(options.ipfsGateway, record.ipfsCid),
    { signal },
  );
  if (!response.ok)
    throw new Error(`IPFS gateway returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!verifyTraceHash(bytes, record.traceHash))
    throw new Error(`Trace ${traceId} failed on-chain hash verification`);
  let content: unknown;
  try {
    content = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`Trace ${traceId} is not valid JSON`);
  }
  return { record, bytes, content };
}
function requirementsKey(p: PaymentPayload): string {
  const r = p.accepted;
  return JSON.stringify([
    p.x402Version,
    r.network,
    r.scheme,
    r.payTo,
    r.amount,
    r.asset,
    r.maxTimeoutSeconds,
    r.extra?.paymentFlow,
  ]);
}
function samePurchase(e: PaymentEntry, p: PaymentPayload, traceId: string) {
  const r = p.accepted;
  return (
    e.traceId === traceId &&
    e.network === r.network &&
    e.payTo === r.payTo &&
    e.amount === r.amount &&
    e.asset === r.asset &&
    e.requirementsKey === requirementsKey(p)
  );
}
/** SDK 2.26.0 contract: ExpressAdapter + processHTTPRequest verifies; processSettlement settles.
 * No stock buffering middleware is installed: the prepared response stays private until settlement succeeds. */
export function createTraceApi(options: TraceApiOptions): Express {
  if (!options.networks.length)
    throw new Error("At least one x402 Stellar payment network is required");
  if (
    new Set(options.networks.map((n) => n.network)).size !==
    options.networks.length
  )
    throw new Error("Duplicate payment network");
  for (const n of options.networks)
    if (!validateStellarDestinationAddress(n.payTo))
      throw new Error(`Invalid payTo for ${n.network}`);
  const maxTimeout = options.maxTimeoutSeconds ?? 60;
  if (!Number.isSafeInteger(maxTimeout) || maxTimeout <= 0)
    throw new Error("maxTimeoutSeconds must be a positive integer");
  const loadTimeout = options.traceLoadTimeoutMs ?? 10_000;
  if (
    !Number.isFinite(loadTimeout) ||
    loadTimeout <= 0 ||
    loadTimeout >= (options.maxTimeoutSeconds ?? 60) * 500
  )
    throw new Error(
      "traceLoadTimeoutMs must be positive and below half maxTimeoutSeconds",
    );
  const ledger = options.ledger ?? new MemoryPaymentLedger();
  const app = express();
  async function initialize() {
    const pairs = await Promise.all(
      options.networks.map(async (n) => {
        const client = facilitatorFor(n, options.facilitatorTimeoutMs);
        try {
          if (!(await client.getSupported()).kinds.length)
            throw new Error("No supported kinds");
          return { n, client };
        } catch (error) {
          if (options.requireAllNetworks !== false) throw error;
          console.warn(
            JSON.stringify({
              event: "x402_network_unavailable",
              network: n.network,
            }),
          );
          return undefined;
        }
      }),
    );
    const active = pairs.filter((p): p is NonNullable<typeof p> => !!p);
    if (!active.length) throw new Error("No reachable x402 networks");
    app.locals.networks = active.map((p) => p.n.network);
    const resource = new x402ResourceServer(active.map((p) => p.client));
    for (const { n } of active) {
      const scheme = authorizationScheme();
      resource.register(n.network, scheme);
    }
    resource.onSettleFailure(async ({ paymentPayload, error }) => {
      const id = paymentIdentity({
        accepted: paymentPayload.accepted,
        payload: paymentPayload.payload,
      }).paymentId;
      const state = (await ledger.get(id))?.state;
      if (state === "settling")
        await ledger.transition(
          id,
          ["settling"],
          error instanceof FacilitatorTimeoutError ? "indeterminate" : "failed",
          { error: String(error) },
        );
      if (error instanceof FacilitatorTimeoutError)
        console.error(
          JSON.stringify({
            event: "x402_settlement_indeterminate",
            paymentId: id,
          }),
        );
    });
    const http = new x402HTTPResourceServer(
      resource,
      buildRoutes({ ...options, networks: active.map((p) => p.n) }),
    );
    await http.initialize();
    const allowed = (
      await Promise.all(
        active.map(({ n }) =>
          resource.buildPaymentRequirements({
            scheme: "exact",
            network: n.network,
            payTo: n.payTo,
            price: options.price,
            maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
            extra: { paymentFlow: "authorization" },
          }),
        ),
      )
    ).flat();
    return { http, resource, allowed };
  }
  const ready = initialize();
  // Attach a rejection handler immediately, while preserving rejection for the startup caller.
  void ready.catch(() => {});
  app.locals.ready = ready;
  app.get("/traces/:traceId", async (req, res) => {
    let paymentId: string | undefined;
    let ownsClaim = false;
    let verified:
      | Extract<HTTPProcessResult, { type: "payment-verified" }>
      | undefined;
    try {
      const traceId = String(req.params.traceId);
      const { http, resource, allowed } = await ready;
      const header = req.get("payment-signature") ?? req.get("x-payment");
      let payload: PaymentPayload | undefined;
      let existing: PaymentEntry | undefined;
      if (header) {
        try {
          payload = JSON.parse(
            Buffer.from(header, "base64").toString(),
          ) as PaymentPayload;
          paymentId = paymentIdentity(payload).paymentId;
        } catch {
          res.status(402).json({ error: "Invalid payment envelope" });
          return;
        }
        const identity = paymentIdentity(payload);
        if (identity.maxLedger !== undefined) {
          if (
            !options.ledgerSequence ||
            (await options.ledgerSequence(payload.accepted.network)) >=
              identity.maxLedger
          ) {
            res
              .status(402)
              .json({ error: "Payment ledger bounds expired or unavailable" });
            return;
          }
        }
        existing = await ledger.get(paymentId);
        if (existing && !samePurchase(existing, payload, traceId)) {
          res
            .status(409)
            .json({ error: "Payment already bound to another purchase" });
          return;
        }
        if (
          (existing?.expiresAt ?? paymentIdentity(payload).expiresAt) <=
          Date.now()
        ) {
          res.status(402).json({ error: "Payment expired" });
          return;
        }
        if (existing) {
          if (
            (existing.state === "settled" || existing.state === "delivered") &&
            existing.responseBody &&
            existing.paymentResponseHeader
          ) {
            const body = JSON.parse(existing.responseBody) as {
              traceHash: string;
              content: unknown;
            };
            // The exact stored response was verified before settlement; replay never
            // consults a mutable registry or gateway, and never calls a facilitator.
            if (
              !existing.traceBytes ||
              !verifyTraceHash(
                Buffer.from(existing.traceBytes, "base64"),
                existing.traceHash,
              ) ||
              !isDeepStrictEqual(
                body.content,
                JSON.parse(
                  Buffer.from(existing.traceBytes, "base64").toString(),
                ),
              ) ||
              body.traceHash !== existing.traceHash
            )
              throw new Error("Corrupt replay record");
            deliver(existing);
            return;
          }
          res
            .set("Retry-After", "2")
            .status(409)
            .json({
              error: `Payment ${existing.state}; do not repay without reconciliation`,
              retryAfter: 2,
            });
          return;
        }
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Trace loading timed out"));
        }, loadTimeout);
      });
      let prepared: Awaited<ReturnType<typeof loadVerifiedTrace>>;
      try {
        prepared = await Promise.race([
          loadVerifiedTrace(options, traceId, controller.signal),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!prepared) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }
      const body = JSON.stringify({
        traceId: prepared.record.traceId,
        traceHash: prepared.record.traceHash,
        content: prepared.content,
      });
      if (payload && paymentId) {
        // Match before claiming, so a tampered unsigned requirement cannot
        // poison the identity of an otherwise valid signed transaction.
        const r = payload.accepted;
        if (
          !resource.findMatchingRequirements(allowed, payload) ||
          r.extra?.paymentFlow !== "authorization"
        ) {
          res.status(402).json({ error: "Unsupported payment requirements" });
          return;
        }
        const claim = await ledger.claim({
          paymentId,
          traceId,
          traceHash: prepared.record.traceHash,
          network: r.network,
          payTo: r.payTo,
          amount: r.amount,
          asset: r.asset,
          expiresAt: paymentIdentity(payload).expiresAt,
          responseBody: body,
          traceBytes: Buffer.from(prepared.bytes).toString("base64"),
          requirementsKey: requirementsKey(payload),
        });
        if (!claim.created) {
          res
            .set("Retry-After", "2")
            .status(409)
            .json({ error: "Payment in progress", retryAfter: 2 });
          return;
        }
        ownsClaim = true;
      }
      const ctx = {
        adapter: new ExpressAdapter(req),
        path: req.path,
        method: req.method,
        paymentHeader: header,
      };
      const result = await http.processHTTPRequest(ctx);
      if (result.type === "payment-error") {
        if (paymentId)
          await ledger.transition(paymentId, ["verifying"], "failed", {
            error: "Payment verification rejected",
          });
        writeInstructions(res, result.response);
        return;
      }
      if (result.type !== "payment-verified" || !paymentId)
        throw new Error("Unexpected payment state");
      verified = result;
      if (result.beforeHandlerSettlement)
        throw new Error("Upfront flow must be disabled");
      // SDK 2.26.0 logs thrown before-settle hook errors and continues.
      // Keep this durable CAS outside hooks: storage failure MUST prevent /settle.
      await ledger.transition(paymentId, ["verifying"], "settling");
      const s = await http.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        {
          request: ctx,
          responseBody: Buffer.from(body),
          responseHeaders: { "Content-Type": "application/json" },
        },
      );
      if (!s.success) {
        const e = await ledger.get(paymentId);
        if (e?.state === "settling")
          await ledger.transition(paymentId, ["settling"], "failed", {
            error: s.errorReason,
          });
        if ((await ledger.get(paymentId))?.state === "indeterminate") {
          res.status(502).json({
            error: "Settlement outcome indeterminate",
            paymentId,
            transaction: s.transaction,
          });
          return;
        }
        writeInstructions(res, s.response);
        return;
      }
      const responseHeader = Object.entries(s.headers).find(
        ([k]) => k.toLowerCase() === "payment-response",
      )?.[1];
      if (!responseHeader) throw new Error("Missing settlement receipt");
      const entry = await ledger.transition(
        paymentId,
        ["settling"],
        "settled",
        {
          settlementTx: s.transaction,
          payer: s.payer,
          paymentResponseHeader: responseHeader,
        },
      );
      deliver(entry);
      function deliver(entry: PaymentEntry) {
        res.on("finish", () => {
          void ledger
            .transition(entry.paymentId, ["settled", "delivered"], "delivered")
            .catch((error) =>
              console.error("Payment delivery record failed", error),
            );
        });
        res
          .set("PAYMENT-RESPONSE", entry.paymentResponseHeader!)
          .set("Cache-Control", "private, no-store")
          .status(200)
          .type("application/json")
          .send(entry.responseBody);
      }
    } catch (error) {
      if (verified)
        await verified.cancellationDispatcher
          .cancel({
            reason: "handler_threw",
            error: error instanceof Error ? error : new Error(String(error)),
          })
          .catch(() => {});
      if (paymentId && ownsClaim) {
        const e = await ledger.get(paymentId).catch(() => undefined);
        if (e?.state === "settling")
          await ledger
            .transition(paymentId, ["settling"], "indeterminate", {
              error: "Settlement interrupted; operator reconciliation required",
            })
            .catch(() => {});
        else if (e?.state === "verifying")
          await ledger
            .transition(paymentId, ["verifying"], "failed", {
              error: "Payment processing interrupted",
            })
            .catch(() => {});
      }
      console.error("x402 request failed", error);
      if (!res.headersSent)
        res.status(502).json({
          error: "Trace or payment processing failed",
          ...(paymentId ? { paymentId } : {}),
        });
    }
  });
  app.get("/admin/payments/:paymentId", async (req, res) => {
    const actual = Buffer.from(req.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.adminToken ?? ""}`);
    if (
      !options.adminToken ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const e = await ledger.get(String(req.params.paymentId));
      if (!e) {
        res.status(404).json({ error: "Payment not found" });
        return;
      }
      const {
        responseBody: _,
        traceBytes: _bytes,
        requirementsKey: _requirements,
        ...redacted
      } = e;
      res.set("Cache-Control", "no-store").json(redacted);
    } catch {
      res.status(503).json({ error: "Ledger unavailable" });
    }
  });
  return app;
}
