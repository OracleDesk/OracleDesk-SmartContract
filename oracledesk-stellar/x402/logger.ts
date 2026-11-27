/**
 * Structured pino logger with request correlation (#87, #328).
 *
 * Secrets never reach the logs:
 * - `redact.paths` censors payment headers, facilitator keys and any
 *   `paymentPayload` / signed `payload.signature` that slips into a log
 *   object.
 * - The `err` serializer drops `config`, `request` and `response.data`,
 *   where HTTP client errors (including `@x402/core`'s) embed the request
 *   body, i.e. the signed payment authorisation.
 * - pino redaction does not apply to strings interpolated into the message,
 *   so log calls pass structured fields and constant messages only.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import pino, { type DestinationStream, type Logger } from "pino";
import { pinoHttp, type HttpLogger } from "pino-http";

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["payment-signature"]',
  'req.headers["x-payment"]',
  'req.headers["x-api-key"]',
  'res.headers["payment-response"]',
  'res.headers["x-oracledesk-receipt"]',
  "facilitatorApiKey",
  "*.facilitatorApiKey",
  "paymentPayload",
  "*.paymentPayload",
  "*.payload.signature",
  "authorization",
  "*.authorization",
  "err.config.headers",
];

/** Fields of an error object that may carry request bodies or headers. */
const UNSAFE_ERROR_FIELDS = ["config", "request", "response", "paymentPayload"];

function safeError(err: unknown): Record<string, unknown> {
  const base = pino.stdSerializers.err(
    err instanceof Error ? err : new Error(String(err)),
  ) as unknown as Record<string, unknown>;
  for (const field of UNSAFE_ERROR_FIELDS) delete base[field];
  const response = (err as { response?: { status?: unknown } } | undefined)
    ?.response;
  if (response && typeof response.status === "number")
    base.responseStatus = response.status;
  return base;
}

export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: "oracledesk-x402" },
      serializers: { err: safeError, error: safeError },
    },
    destination,
  );
}

export const logger: Logger = createLogger();

export function genReqId(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const inbound = req.headers["x-request-id"];
  const id = Array.isArray(inbound) ? inbound[0] : inbound;
  if (id && REQUEST_ID_RE.test(id)) return id;
  return randomUUID();
}

/**
 * pino-http middleware. Each request gets `req.id` / `req.log` (a child
 * carrying `reqId`), and the id is echoed in `X-Request-Id`. Messages are
 * constant strings: no URL, header or payload is interpolated.
 */
export function createHttpLogger(base: Logger = logger): HttpLogger {
  return pinoHttp({
    logger: base,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = genReqId(req);
      res.setHeader("X-Request-Id", id);
      return id;
    },
    customAttributeKeys: { reqId: "reqId" },
    // `req.log` binds only `reqId`, so route logs stay small and correlated.
    quietReqLogger: true,
    customSuccessMessage: () => "request completed",
    customErrorMessage: () => "request failed",
    // The trace route logs failures itself, once, at the right level.
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? "warn" : "info",
    serializers: {
      req: (req: { id?: unknown; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        // Path only: query strings never reach the logs.
        path: typeof req.url === "string" ? req.url.split("?")[0] : undefined,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: safeError,
    },
  });
}
