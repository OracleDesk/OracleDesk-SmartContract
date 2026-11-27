import express, { type Express, type Response } from "express";
import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
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
  type TraceVerdict,
} from "./trace-verification.js";
import {
  LedgerConflict,
  MemoryPaymentLedger,
  paymentIdentity,
  type PaymentLedger,
  type PaymentEntry,
  type RefundState,
} from "./payment-ledger.js";
import { approveRefund, rejectRefund } from "./refunds.js";
import {
  decodeCursor,
  encodeCursor,
  parseCursorKeys,
  type CursorKeys,
} from "./discovery.js";
import { classifyRegistryError } from "./errors.js";
import {
  loadVerdictPolicy,
  decide,
  type VerdictPolicy,
} from "./verdict-policy.js";
import type { RegistryTraceRepository } from "./registry-trace-repository.js";
import type { Logger } from "pino";
import { createHttpLogger, logger as defaultLogger } from "./logger.js";
import {
  toX402Error,
  X402Error,
  type Stage,
  type X402ErrorKind,
} from "./errors.js";
import { createMetrics, since, type X402Metrics } from "./metrics.js";
import { KEYS_PATH, type ReceiptSigner } from "./receipt-keys.js";
import { decodeReceipt, normalizeHex } from "./receipt.js";
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
  ledger?: number;
  archived?: boolean;
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
  listByAgent(agent: string, cursor?: bigint | string, limit?: number): Promise<TraceListPage>;
  listByMarket(marketId: string, cursor?: bigint | string, limit?: number): Promise<TraceListPage>;
  listByMarketAction(
    marketId: string,
    action: string,
    cursor?: bigint | string,
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
  /**
   * When set, verdict enforcement is applied before every sale and
   * re-checked before settlement (#306). Requires the repository to
   * implement `verdict(traceId, receivedHashHex)`.
   */
  registryRepository?: RegistryTraceRepository;
  /** Verdict policy loaded from X402_VERDICT_POLICY (#306). */
  verdictPolicy?: VerdictPolicy;
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
  cursorKeys?: CursorKeys;
  quote?: (traceId: string) => string;
  listCacheSize?: number;
  paymentsDisabled?: boolean;
  /**
   * Seconds after settlement during which the same payment can re-download
   * the trace, even past the payment's own `expiresAt`
   * (`X402_REDELIVERY_WINDOW_SECS`, default 900). Afterwards an undelivered
   * payment is refunded (refunds.ts).
   */
  redeliveryWindowSecs?: number;
  /** #328: structured logger; defaults to the shared redacting pino logger. */
  logger?: Logger;
  /** #328: Prometheus metrics; a private registry is created when omitted. */
  metrics?: X402Metrics;
  /** #330: when set, every settled payment gets a signed delivery receipt. */
  receiptSigner?: ReceiptSigner;
}

const ACTION_LABELS = new Set([
  "create_market", "propose_market", "buy", "sell", "skip", "redeem",
  "claim_remainder", "resolve",
]);
function queryDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function publicEntry(entry: TraceListEntry, priceQuote: string): Record<string, unknown> {
  return {
    traceId: entry.traceId,
    marketId: entry.marketId,
    agent: entry.agent,
    action: entry.action,
    publishedAt: entry.publishedAt,
    ...(entry.ledger === undefined ? {} : { ledger: entry.ledger }),
    ...(entry.archived ? { archived: true } : {}),
    priceQuote,
  };
}
function parseMarket(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  try {
    const n = BigInt(value);
    return n <= 18446744073709551615n ? n.toString() : undefined;
  } catch { return undefined; }
}
function parseAgent(value: unknown): string | undefined {
  return typeof value === "string" && /^G[A-Z2-7]+$/.test(value) ? value : undefined;
}

const REFUNDED_STATES = new Set(["refund_pending", "refunding", "refunded"]);
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
    private readonly metrics?: X402Metrics,
  ) {}
  async getSupported() {
    const s = await this.client.getSupported();
    return { ...s, kinds: s.kinds.filter((k) => k.network === this.network) };
  }
  verify(p: PaymentPayload, r: PaymentRequirements) {
    this.assertNetwork(r);
    return this.timed("facilitator_verify", this.client.verify(p, r));
  }
  settle(p: PaymentPayload, r: PaymentRequirements) {
    this.assertNetwork(r);
    return this.timed("facilitator_settle", this.client.settle(p, r));
  }
  /** #328: latency histogram, including timeouts (`outcome="timeout"`). */
  private timed<T>(
    upstream: "facilitator_verify" | "facilitator_settle",
    call: Promise<T>,
  ): Promise<T> {
    const m = this.metrics;
    if (!m) return call;
    const start = performance.now();
    return call.then(
      (value) => {
        m.observeUpstream(upstream, "ok", since(start));
        return value;
      },
      (error: unknown) => {
        m.observeUpstream(
          upstream,
          error instanceof FacilitatorTimeoutError ? "timeout" : "error",
          since(start),
        );
        throw error;
      },
    );
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
  metrics?: X402Metrics,
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
    metrics,
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
async function timedUpstream<T>(
  metrics: X402Metrics,
  upstream: "registry" | "ipfs",
  call: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const value = await call();
    metrics.observeUpstream(upstream, "ok", since(start));
    return value;
  } catch (error) {
    metrics.observeUpstream(
      upstream,
      (error as { name?: unknown })?.name === "AbortError" ? "timeout" : "error",
      since(start),
    );
    throw error;
  }
}
async function loadVerifiedTrace(
  options: TraceApiOptions,
  metrics: X402Metrics,
  traceId: string,
  signal: AbortSignal,
) {
  const record = await timedUpstream(metrics, "registry", () =>
    options.repository.get(traceId),
  );
  if (!record) return undefined;
  let response: globalThis.Response;
  try {
    response = await timedUpstream(metrics, "ipfs", () =>
      (options.fetchImpl ?? fetch)(ipfsUrl(options.ipfsGateway, record.ipfsCid), {
        signal,
      }),
    );
  } catch (e) {
    throw new X402Error("gateway_unavailable", undefined, e);
  }
  if (!response.ok)
    throw new X402Error(
      "gateway_unavailable",
      undefined,
      undefined,
      `IPFS gateway returned HTTP ${response.status}`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!verifyTraceHash(bytes, record.traceHash))
    throw new X402Error("trace_hash_mismatch");
  let content: unknown;
  try {
    content = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new X402Error("trace_invalid_json");
  }
  return { record, bytes, content };
}

/** #328: counts every durable ledger transition, with no extra awaits. */
function instrumentLedger(inner: PaymentLedger, metrics: X402Metrics): PaymentLedger {
  return {
    claim: (e) => inner.claim(e),
    get: (id) => inner.get(id),
    reconcileStuck: (ms) => inner.reconcileStuck(ms),
    countByState: () => inner.countByState(),
    close: () => inner.close(),
    transition: (id, from, to, patch) =>
      inner.transition(id, from, to, patch).then((entry) => {
        metrics.observeTransition(from, to);
        return entry;
      }),
  };
}

/** `tag[:reason]` for the receipt's verdict field (#330, #306). */
function verdictField(v: TraceVerdict | undefined): string {
  if (!v) return "unchecked";
  const value = (v as { values?: unknown[] }).values?.[0];
  return value === undefined || value === "" ? v.tag : `${v.tag}:${String(value)}`;
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
  const redeliveryWindowMs = (options.redeliveryWindowSecs ?? 900) * 1000;
  if (!Number.isFinite(redeliveryWindowMs) || redeliveryWindowMs < 0)
    throw new Error("redeliveryWindowSecs must be a non-negative number");
  const baseLedger = options.ledger ?? new MemoryPaymentLedger();
  const log = options.logger ?? defaultLogger;
  const metrics =
    options.metrics ??
    createMetrics({
      networks: options.networks.map((n) => n.network),
      countByState: () => baseLedger.countByState(),
    });
  const ledger = instrumentLedger(baseLedger, metrics);
  const signer = options.receiptSigner;
  const app = express();
  const cursorKeys = options.cursorKeys ?? parseCursorKeys() ?? {
    current: { kid: "default", secret: "x402-development-cursor-key" },
  };
  const pageCache = new Map<string, TraceListPage>();
  const cacheGet = async (key: string, load: () => Promise<TraceListPage>) => {
    const cached = pageCache.get(key);
    if (cached) return cached;
    const value = await load();
    pageCache.set(key, value);
    while (pageCache.size > (options.listCacheSize ?? 1000))
      pageCache.delete(pageCache.keys().next().value!);
    return value;
  };
  app.locals.metrics = metrics;
  // Request-scoped logger first: every later line carries `reqId`.
  app.use(createHttpLogger(log));
  async function initialize() {
    const pairs = await Promise.all(
      options.networks.map(async (n) => {
        const client = facilitatorFor(n, options.facilitatorTimeoutMs, metrics);
        try {
          if (!(await client.getSupported()).kinds.length)
            throw new Error("No supported kinds");
          return { n, client };
        } catch (error) {
          if (options.requireAllNetworks !== false) throw error;
          log.warn(
            { event: "x402_network_unavailable", network: n.network, err: error },
            "x402 network unavailable",
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
      const entry = await ledger.get(id);
      const state = entry?.state;
      if (state === "settling") {
        if (error instanceof FacilitatorTimeoutError) {
          await ledger.transition(id, ["settling"], "indeterminate", {
            error: String(error),
          });
        } else {
          // #300: persist facilitator tx hash on failure, use failed_unconfirmed
          // so the reconciler can check on-chain whether it actually settled.
          await ledger.transition(id, ["settling"], "failed_unconfirmed", {
            error: String(error),
            facilitatorTx: (paymentPayload as { transaction?: string }).transaction,
          });
        }
      }
      if (error instanceof FacilitatorTimeoutError)
        log.error(
          {
            event: "x402_settlement_indeterminate",
            paymentId: id,
            network: metrics.networkLabel(paymentPayload.accepted.network),
          },
          "x402 settlement indeterminate",
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
  app.get("/traces", async (req, res) => {
    if (!options.listRepository) {
      res.status(404).json({ error: "Discovery not configured" });
      return;
    }
    const market = req.query.market;
    const agent = req.query.agent;
    const action = req.query.action;
    if ((market === undefined) === (agent === undefined) || (action !== undefined && market === undefined)) {
      res.status(400).json({ error: "Exactly one of market or agent is required; action requires market" });
      return;
    }
    const marketId = market === undefined ? undefined : parseMarket(market);
    const agentId = agent === undefined ? undefined : parseAgent(agent);
    if ((market !== undefined && marketId === undefined) || (agent !== undefined && agentId === undefined)) {
      res.status(400).json({ error: "Invalid market or agent" });
      return;
    }
    if (action !== undefined && (typeof action !== "string" || (!ACTION_LABELS.has(action) && !action.startsWith("other:")))) {
      res.status(400).json({ error: "Invalid action" });
      return;
    }
    const order = req.query.order === undefined ? "desc" : req.query.order;
    if (order !== "asc" && order !== "desc") {
      res.status(400).json({ error: "order must be asc or desc" });
      return;
    }
    const rawLimit = req.query.limit === undefined ? 25 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1) {
      res.status(400).json({ error: "limit must be between 1 and 25" });
      return;
    }
    const limit = Math.min(rawLimit, 25);
    const canonical = JSON.stringify({ market: marketId, agent: agentId, action: action ?? null, order, limit });
    const digest = queryDigest(canonical);
    const supplied = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    let cursor = supplied ? decodeCursor(supplied, cursorKeys, digest) : undefined;
    if (supplied && !cursor) {
      res.status(400).json({ error: "Invalid or expired cursor" });
      return;
    }
    let start = cursor ? BigInt(cursor.next) : 0n;
    let anchorTotal = cursor ? BigInt(cursor.anchorTotal) : undefined;
    try {
      const ledgerNumber = options.ledgerSequence
        ? await options.ledgerSequence(options.networks[0].network)
        : 0;
      const loadPage = (at: bigint) => {
        if (marketId !== undefined && action !== undefined)
          return options.listRepository!.listByMarketAction(marketId, action, at, limit);
        if (marketId !== undefined) return options.listRepository!.listByMarket(marketId, at, limit);
        return options.listRepository!.listByAgent(agentId!, at, limit);
      };
      if (order === "desc" && !cursor) {
        const first = await cacheGet(`${ledgerNumber}:${canonical}:0`, () => loadPage(0n));
        anchorTotal = BigInt(first.total);
        start = anchorTotal > BigInt(limit) ? anchorTotal - BigInt(limit) : 0n;
      }
      const load = async () => {
        let page: TraceListPage;
        page = await cacheGet(`${ledgerNumber}:${canonical}:${start}`, () => loadPage(start));
        if (anchorTotal === undefined) anchorTotal = BigInt(page.total);
        page = { ...page, total: anchorTotal.toString() };
        if (order === "desc") {
          page = { ...page, items: [...page.items].reverse() };
          const next = start > BigInt(limit) ? start - BigInt(limit) : 0n;
          page = { ...page, next: next.toString(), total: anchorTotal.toString() };
        }
        return page;
      };
      const page = await load();
      const next = BigInt(page.next);
      const hasNext = order === "desc" ? next > 0n : next < BigInt(page.total);
      const nextCursor = hasNext
        ? encodeCursor({ q: digest, order, next: next.toString(), anchorTotal: (anchorTotal ?? BigInt(page.total)).toString(), exp: Math.floor(Date.now() / 1000) + 86400 }, cursorKeys)
        : null;
      const items = page.items.map((entry) => publicEntry({ ...entry, ledger: ledgerNumber }, options.quote?.(entry.traceId) ?? options.price));
      res.set("Cache-Control", "public, max-age=5").json({ items, nextCursor, total: page.total });
    } catch (error) {
      const classified = classifyRegistryError(error);
      if (classified.kind === "upstream") {
        res.set("Retry-After", "2").status(503).json({ error: "Registry unavailable", retryAfter: 2 });
      } else if (classified.kind === "contract" && classified.code === 3001) {
        res.status(400).json({ error: "Page too large" });
      } else {
        res.status(503).json({ error: "Registry unavailable" });
      }
    }
  });

  /** Sends `{ error: kind, message, ...extra }` and counts the kind. */
  function fail(
    res: Response,
    kind: X402ErrorKind,
    extra: Record<string, unknown> = {},
    status?: number,
  ) {
    const e = new X402Error(kind, status);
    metrics.observeError(kind);
    res.status(e.status).json({ ...e.toJSON(), ...extra });
  }

  /** Issues the receipt for a settled payment (#330). Never throws. */
  async function issueReceipt(
    entry: Pick<
      PaymentEntry,
      "network" | "paymentId" | "traceId" | "traceHash" | "amount" | "asset" | "payTo"
    >,
    settlementTx: string | undefined,
    payer: string | undefined,
    settledAt: number,
    verdict: TraceVerdict | undefined,
    plog: Logger,
  ): Promise<string | undefined> {
    if (!signer) return undefined;
    try {
      return await signer.sign({
        network: entry.network,
        paymentId: entry.paymentId,
        settlementTx: normalizeHex(settlementTx ?? ""),
        traceId: entry.traceId,
        traceHash: normalizeHex(entry.traceHash),
        verdict: verdictField(verdict),
        amount: entry.amount,
        asset: entry.asset,
        payTo: entry.payTo,
        payer: payer ?? "",
        settledAt: String(settledAt),
      });
    } catch (err) {
      metrics.observeError("internal");
      plog.error({ event: "x402_receipt_failed", err }, "x402 receipt issuance failed");
      return undefined;
    }
  }

  app.get(KEYS_PATH, (_req, res) => {
    if (!signer) {
      res.status(404).json({ error: "not_found", message: "Receipts not enabled" });
      return;
    }
    res
      .set("Cache-Control", "public, max-age=300")
      .json(signer.publicKeySet());
  });

  app.get("/receipts/:paymentId", async (req, res) => {
    // Same 404 for unknown, unsettled and header-mismatch cases, so this
    // route is not an oracle for whether a payment exists.
    const notFound = () =>
      res.status(404).json({ error: "not_found", message: "Receipt not found" });
    const header = req.get("payment-signature") ?? req.get("x-payment");
    if (!header) return notFound();
    let paymentId: string;
    try {
      const payload = JSON.parse(
        Buffer.from(header, "base64").toString(),
      ) as PaymentPayload;
      paymentId = paymentIdentity(payload).paymentId;
    } catch {
      return notFound();
    }
    if (paymentId !== String(req.params.paymentId)) return notFound();
    try {
      const entry = await ledger.get(paymentId);
      if (
        !entry?.receipt ||
        (entry.state !== "settled" && entry.state !== "delivered")
      )
        return notFound();
      res
        .set("Cache-Control", "private, no-store")
        .json({ receipt: entry.receipt, keysUrl: KEYS_PATH });
    } catch (err) {
      req.log.error({ err }, "x402 receipt lookup failed");
      fail(res, "ledger_unavailable");
    }
  });

  app.get("/traces/:traceId", async (req, res) => {
    let paymentId: string | undefined;
    let ownsClaim = false;
    let stage: Stage = "prepare";
    let network: string | undefined;
    let plog: Logger = req.log;
    let verified:
      | Extract<HTTPProcessResult, { type: "payment-verified" }>
      | undefined;
    const traceId = String(req.params.traceId);
    function deliver(entry: PaymentEntry, replay: boolean) {
      res.on("finish", () => {
        void ledger
          .transition(entry.paymentId, ["settled", "delivered"], "delivered")
          .catch((err) =>
            plog.error({ err }, "x402 payment delivery record failed"),
          );
      });
      metrics.observeStage("deliver", replay ? "replay" : "ok", entry.network);
      // The stored body was verified before settlement; the receipt is added
      // at send time, so replays return the same receipt bytes.
      const body = entry.receipt
        ? JSON.stringify({ ...JSON.parse(entry.responseBody!), receipt: entry.receipt })
        : entry.responseBody;
      if (entry.receipt) res.set("X-OracleDesk-Receipt", entry.receipt);
      res
        .set("PAYMENT-RESPONSE", entry.paymentResponseHeader!)
        .set("Cache-Control", "private, no-store")
        .status(200)
        .type("application/json")
        .send(body);
    }
    try {
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
          fail(res, "invalid_envelope");
          return;
        }
        network = payload.accepted.network;
        // Never log the payload: only its derived identity.
        plog = req.log.child({
          paymentId,
          traceId,
          network: metrics.networkLabel(network),
        });
        const identity = paymentIdentity(payload);
        if (identity.maxLedger !== undefined) {
          if (
            !options.ledgerSequence ||
            (await options.ledgerSequence(payload.accepted.network)) >=
              identity.maxLedger
          ) {
            fail(res, "payment_expired", {
              message: "Payment ledger bounds expired or unavailable",
            });
            return;
          }
        }
        existing = await ledger.get(paymentId);
        if (existing && !samePurchase(existing, payload, traceId)) {
          fail(res, "payment_conflict", {
            message: "Payment already bound to another purchase",
          });
          return;
        }
        if (
          (existing?.expiresAt ?? paymentIdentity(payload).expiresAt) <=
          Date.now()
        ) {
          fail(res, "payment_expired");
          return;
        }
        if (existing) {
          if (REFUNDED_STATES.has(existing.state)) {
            // Refunded (or being refunded): the trace is never served again.
            res.status(410).json({
              error: "Payment refunded",
              ...(existing.refundTx ? { refundTx: existing.refundTx } : {}),
            });
            return;
          }
          if (
            (existing.state === "settled" || existing.state === "delivered") &&
            existing.responseBody &&
            existing.paymentResponseHeader
          ) {
            // Redelivery is bounded by the settlement time, not by the
            // payment's (short) authorization expiry.
            const settledAt = existing.settledAt ?? existing.updatedAt;
            if (Date.now() > settledAt + redeliveryWindowMs) {
              res.status(410).json({
                error: "Redelivery window closed",
                ...(existing.state === "settled"
                  ? { refund: "pending" }
                  : {}),
              });
              return;
            }
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
            // Claim the delivery *before* sending: a concurrent refund sweep
            // and this re-download race on the same CAS, so exactly one wins
            // (delivered, or refund_pending and this replay answers 410).
            let claimed: PaymentEntry;
            try {
              claimed = await ledger.transition(
                existing.paymentId,
                ["settled", "delivered"],
                "delivered",
              );
            } catch (error) {
              if (!(error instanceof LedgerConflict)) throw error;
              const now = await ledger.get(existing.paymentId);
              res.status(410).json({
                error: "Payment refunded",
                ...(now?.refundTx ? { refundTx: now.refundTx } : {}),
              });
              return;
            }
            send(claimed);
            stage = "deliver";
            if (signer && !existing.receipt) {
              // #330: settled before receipts existed. Backfill once, from the
              // stored settlement; the flag is not part of the signed fields.
              const settledAt =
                existing.settledAt ?? Math.floor(existing.updatedAt / 1000);
              const receipt = await issueReceipt(
                existing,
                existing.settlementTx,
                existing.payer,
                settledAt,
                undefined,
                plog,
              );
              if (receipt) {
                existing = await ledger.transition(
                  existing.paymentId,
                  [existing.state],
                  existing.state,
                  { receipt, settledAt, receiptBackfilled: true },
                );
                plog.info({ event: "x402_receipt_backfilled" }, "x402 receipt backfilled");
              }
            }
            deliver(existing, true);
            return;
          }
          res.set("Retry-After", "2");
          fail(res, "payment_conflict", {
            message: `Payment ${existing.state}; do not repay without reconciliation`,
            retryAfter: 2,
          });
          return;
        }
        // Only a new payment is subject to its authorization expiry and
        // ledger bounds; a settled one is replayed by `settledAt` above.
        if (identity.expiresAt <= Date.now()) {
          res.status(402).json({ error: "Payment expired" });
          return;
        }
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
      }
      const prepareStart = performance.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new X402Error("gateway_unavailable", undefined, undefined, "Trace loading timed out"),
          );
        }, loadTimeout);
      });
      let prepared: Awaited<ReturnType<typeof loadVerifiedTrace>>;
      try {
        prepared = await Promise.race([
          loadVerifiedTrace(options, metrics, traceId, controller.signal),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!prepared) {
        metrics.observeStage("prepare", "error", network, since(prepareStart));
        fail(res, "trace_not_found");
        return;
      }

      // ── #306 Verdict enforcement ────────────────────────────────────────
      // Call trace_verdict with the SHA-256 of the *fetched* bytes so
      // HashMismatch is reachable. Must happen before any ledger claim.
      let verdictAtSale: TraceVerdict | undefined;
      if (options.registryRepository) {
        const policy = options.verdictPolicy ?? loadVerdictPolicy(process.env);
        const receivedHashHex = createHash("sha256")
          .update(prepared.bytes)
          .digest("hex");
        const rawVerdict = await options.registryRepository
          .verdict(traceId, receivedHashHex)
          .catch(() => "unavailable" as const);
        const action = decide(rawVerdict === "unavailable" ? "unavailable" : rawVerdict, policy);
        if (action.kind === "refuse") {
          metrics.observeError("verdict_refused");
          res.status(action.status).json({
            error: "Trace verdict refused",
            verdict:
              rawVerdict === "unavailable"
                ? "unavailable"
                : rawVerdict.tag,
          });
          return;
        }
        verdictAtSale =
          rawVerdict !== "unavailable" ? rawVerdict : undefined;
      }
      // ── End verdict enforcement ─────────────────────────────────────────

      // #299: refuse to serve traces whose verdict is anything other than Valid,
      // before any payment is verified or settled.
      if (prepared.record.verdict && prepared.record.verdict.tag !== "Valid") {
        metrics.observeError("verdict_refused");
        res
          .status(410)
          .json({ error: "trace_not_valid", verdict: prepared.record.verdict });
        return;
      }
      const body = JSON.stringify({
        traceId: prepared.record.traceId,
        traceHash: prepared.record.traceHash,
        verdict: verdictAtSale ?? null,
        content: prepared.content,
      });
      metrics.observeStage("prepare", "ok", network, since(prepareStart));
      if (payload && paymentId) {
        // Match before claiming, so a tampered unsigned requirement cannot
        // poison the identity of an otherwise valid signed transaction.
        const r = payload.accepted;
        if (
          !resource.findMatchingRequirements(allowed, payload) ||
          r.extra?.paymentFlow !== "authorization"
        ) {
          fail(res, "unsupported_requirements");
          return;
        }
        const identity = paymentIdentity(payload);
        const claim = await ledger.claim({
          paymentId,
          traceId,
          traceHash: prepared.record.traceHash,
          network: r.network,
          payTo: r.payTo,
          amount: r.amount,
          asset: r.asset,
          expiresAt: identity.expiresAt,
          maxLedger: identity.maxLedger,
          innerTxHash: identity.innerTxHash,
          auths: identity.auths,
          responseBody: body,
          traceBytes: Buffer.from(prepared.bytes).toString("base64"),
          requirementsKey: requirementsKey(payload),
        });
        if (!claim.created) {
          res.set("Retry-After", "2");
          fail(res, "payment_conflict", {
            message: "Payment in progress",
            retryAfter: 2,
          });
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
      stage = "verify";
      const verifyStart = performance.now();
      const result = await http.processHTTPRequest(ctx);
      const verifyMs = performance.now() - verifyStart;
      if (result.type === "payment-error") {
        if (paymentId) {
          await ledger.transition(paymentId, ["verifying"], "failed", {
            error: "Payment verification rejected",
          });
          metrics.observeStage("verify", "error", network, verifyMs / 1000);
          metrics.observeError("verify_rejected");
          plog.info({ stage: "verify", outcome: "rejected" }, "x402 payment verification rejected");
        }
        // Protocol-defined 402 challenge / rejection body from the SDK.
        writeInstructions(res, result.response);
        return;
      }
      if (result.type !== "payment-verified" || !paymentId)
        throw new Error("Unexpected payment state");
      verified = result;
      metrics.observeStage("verify", "ok", network, verifyMs / 1000);
      if (result.beforeHandlerSettlement)
        throw new Error("Upfront flow must be disabled");
      // SDK 2.26.0 logs thrown before-settle hook errors and continues.
      // Keep this durable CAS outside hooks: storage failure MUST prevent /settle.
      // ── #306 Pre-settlement verdict re-check ────────────────────────────
      // Re-run verdict() before transitioning to settling. If the verdict
      // changed to refuse since the initial check, abort and cancel.
      if (options.registryRepository && prepared) {
        const policy = options.verdictPolicy ?? loadVerdictPolicy(process.env);
        const receivedHashHex = createHash("sha256")
          .update(prepared.bytes)
          .digest("hex");
        const rawVerdict = await options.registryRepository
          .verdict(traceId, receivedHashHex)
          .catch(() => "unavailable" as const);
        const action = decide(rawVerdict === "unavailable" ? "unavailable" : rawVerdict, policy);
        if (action.kind === "refuse") {
          if (paymentId)
            await ledger.transition(paymentId, ["verifying"], "failed", {
              error: "verdict changed before settlement",
            }).catch(() => {});
          if (verified)
            await verified.cancellationDispatcher
              .cancel({ reason: "handler_threw", error: new Error("verdict changed") })
              .catch(() => {});
          metrics.observeError("verdict_refused");
          res.status(action.status).json({
            error: "Trace verdict changed before settlement",
            verdict: rawVerdict === "unavailable" ? "unavailable" : (rawVerdict as TraceVerdict).tag,
          });
          return;
        }
      }
      // ── End pre-settlement re-check ──────────────────────────────────────
      stage = "settle";
      // Timing uses performance.now() only: no await is added between the
      // durable verifying → settling CAS and the facilitator settle call.
      const settleStart = performance.now();
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
      const settleMs = performance.now() - settleStart;
      if (!s.success) {
        const e = await ledger.get(paymentId);
        if (e?.state === "settling")
          await ledger.transition(paymentId, ["settling"], "failed_unconfirmed", {
            error: s.errorReason,
            facilitatorTx: s.transaction,
          });
        if ((await ledger.get(paymentId))?.state === "indeterminate") {
          metrics.observeStage("settle", "timeout", network, settleMs / 1000);
          plog.error(
            { event: "x402_settlement_indeterminate", stage: "settle", settleMs },
            "x402 settlement indeterminate",
          );
          fail(res, "settle_indeterminate", {
            paymentId,
            transaction: s.transaction,
          });
          return;
        }
        metrics.observeStage("settle", "error", network, settleMs / 1000);
        // #300: if failed_unconfirmed, tell the buyer to wait for reconciliation
        if ((await ledger.get(paymentId))?.state === "failed_unconfirmed") {
          plog.warn(
            { stage: "settle", outcome: "failed_unconfirmed", settleMs },
            "x402 settlement being reconciled",
          );
          fail(
            res,
            "settle_failed",
            { message: "Settlement being reconciled", retryAfter: 30 },
            409,
          );
          return;
        }
        metrics.observeError("settle_failed");
        writeInstructions(res, s.response);
        return;
      }
      const responseHeader = Object.entries(s.headers).find(
        ([k]) => k.toLowerCase() === "payment-response",
      )?.[1];
      if (!responseHeader) throw new Error("Missing settlement receipt");
      metrics.observeStage("settle", "ok", network, settleMs / 1000);
      // #330: the receipt is computed before, and persisted by, the single
      // settling → settled CAS. A replica that loses the CAS discards it.
      const settledAt = Math.floor(Date.now() / 1000);
      const claimed = await ledger.get(paymentId);
      const receipt = claimed
        ? await issueReceipt(
            claimed,
            s.transaction,
            s.payer,
            settledAt,
            verdictAtSale,
            plog,
          )
        : undefined;
      const entry = await ledger.transition(
        paymentId,
        ["settling"],
        "settled",
        {
          settlementTx: s.transaction,
          payer: s.payer,
          paymentResponseHeader: responseHeader,
          settledAt: Date.now(),
          receipt,
        },
      );
      stage = "deliver";
      // Set X-Trace-Verdict header when a verdict was recorded at sale (#306).
      if (verdictAtSale) {
        const tag = verdictAtSale.tag;
        const reason =
          tag === "Flagged" && verdictAtSale.values?.[0]
            ? `;reason=${verdictAtSale.values[0]}`
            : tag === "AgentRevokedAfter" && verdictAtSale.values?.[0]
              ? `;effective_from=${verdictAtSale.values[0]}`
              : "";
        res.set("X-Trace-Verdict", `${tag}${reason}`);
      }
      deliver(entry);
      /** First delivery: recorded only once the response actually finished,
       * so a client abort leaves the entry `settled` (redeliverable, then
       * refundable). */
      function deliver(entry: PaymentEntry) {
        res.on("finish", () => {
          void ledger
            .transition(entry.paymentId, ["settled", "delivered"], "delivered")
            .catch((error) =>
              console.error("Payment delivery record failed", error),
            );
        });
        send(entry);
      }
      function send(entry: PaymentEntry) {
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
      const typed = toX402Error(error, stage);
      metrics.observeStage(stage, "error", network);
      metrics.observeError(typed.kind);
      // Logged once, here: 5xx is an operator problem, the rest client-side.
      (typed.status >= 500 ? plog.error : plog.warn).call(
        plog,
        { err: typed.cause ?? error, kind: typed.kind, stage },
        "x402 request failed",
      );
      if (!res.headersSent) {
        if (typed.kind === "registry_restore_required" || typed.kind === "registry_unavailable")
          res.set("Retry-After", "30");
        res.status(typed.status).json({
          ...typed.toJSON(),
          ...(paymentId ? { paymentId } : {}),
        });
      }
    }
  });
  /** Bearer check shared by the admin routes (the signed-admin item replaces it). */
  function adminAuthorized(req: express.Request, res: Response): boolean {
    const actual = Buffer.from(req.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.adminToken ?? ""}`);
    if (
      !options.adminToken ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }
  app.get("/admin/payments/:paymentId", async (req, res) => {
    if (!adminAuthorized(req, res)) return;
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
      let receiptFields: unknown;
      if (e.receipt) {
        try {
          receiptFields = decodeReceipt(e.receipt).fields;
        } catch {
          receiptFields = null;
        }
      }
      // #300: surface reconciliation state in admin API
      const adminEntry = {
        ...redacted,
        needsOperator: e.state === "needs_operator",
        ...(e.receipt ? { receiptFields } : {}),
      };
      res.set("Cache-Control", "no-store").json(adminEntry);
    } catch (err) {
      req.log.error({ err }, "x402 admin ledger read failed");
      fail(res, "ledger_unavailable");
    }
  });
  const REFUND_STATES: RefundState[] = [
    "review",
    "pending",
    "submitted",
    "succeeded",
    "failed",
    "rejected",
  ];
  app.get("/admin/refunds", async (req, res) => {
    if (!adminAuthorized(req, res)) return;
    const state = req.query.state ? String(req.query.state) : undefined;
    if (state && !REFUND_STATES.includes(state as RefundState)) {
      res.status(400).json({ error: "Unknown refund state" });
      return;
    }
    const cursor = Number(req.query.cursor ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
    try {
      const page = await ledger.refunds.list(
        state as RefundState | undefined,
        cursor,
        50,
      );
      res.set("Cache-Control", "no-store").json({
        items: page.items.map(({ txXdr: _xdr, ...r }) => r),
        ...(page.next !== undefined ? { next: page.next } : {}),
      });
    } catch {
      res.status(503).json({ error: "Ledger unavailable" });
    }
  });
  for (const action of ["approve", "reject"] as const)
    app.post(`/admin/refunds/:paymentId/${action}`, async (req, res) => {
      if (!adminAuthorized(req, res)) return;
      const id = String(req.params.paymentId);
      try {
        const e =
          action === "approve"
            ? await approveRefund(ledger, id)
            : await rejectRefund(ledger, id);
        res.set("Cache-Control", "no-store").json({ paymentId: id, state: e.state });
      } catch (error) {
        if (error instanceof LedgerConflict) {
          res.status(409).json({ error: "Refund is not awaiting review" });
          return;
        }
        res.status(503).json({ error: "Ledger unavailable" });
      }
    });
  return app;
}