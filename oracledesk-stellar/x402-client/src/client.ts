/**
 * @oracledesk/x402-client — isomorphic x402 buyer client (issue #312).
 *
 * Protocol flow:
 *   1. GET /trace/:id  →  402 + WWW-Authenticate: X402 …
 *   2. Build a Soroban auth XDR payment authorisation via the signer.
 *   3. GET /trace/:id  +  X-PAYMENT: <base64 auth XDR>
 *   4. Server responds 200 with PAYMENT-RESPONSE header containing trace_id.
 *   5. Verify on-chain via registry.get_trace({ trace_id }).
 */

import { PaymentError, PaymentRequired, VerificationFailed } from "./errors.js";
import { verifyTraceOnChain } from "./verify.js";
import type { RegistryClient, VerificationResult } from "./verify.js";

export interface TraceApiSigner {
  /** Signs the payment preimage XDR and returns a base64-encoded auth XDR. */
  signPaymentAuth(preimageXdr: string): Promise<string>;
}

export interface TraceApiClientConfig {
  /** Base URL of the OracleDesk trace API server. */
  apiBaseUrl: string;
  registry: RegistryClient;
  signer: TraceApiSigner;
  /** Milliseconds before aborting individual fetch calls. Default: 10 000. */
  timeoutMs?: number;
}

export interface FetchedTrace {
  content: Uint8Array;
  traceId: bigint;
  verificationResult: VerificationResult;
}

function parsePaymentRequired(response: Response): PaymentRequired {
  const www = response.headers.get("www-authenticate") ?? "";
  const details: Record<string, string> = {};
  for (const match of www.matchAll(/(\w+)="([^"]+)"/g)) {
    details[match[1]] = match[2];
  }
  return new PaymentRequired(www, details);
}

function parsePaymentResponse(response: Response): bigint {
  const header = response.headers.get("payment-response") ?? response.headers.get("PAYMENT-RESPONSE");
  if (!header) {
    throw new VerificationFailed("Server did not return a PAYMENT-RESPONSE header");
  }
  // Expected format: trace_id=<number>[,other=...]
  const match = header.match(/trace_id=(\d+)/);
  if (!match) {
    throw new VerificationFailed(`Could not parse trace_id from PAYMENT-RESPONSE: ${header}`);
  }
  return BigInt(match[1]);
}

/**
 * Pay for and fetch a trace, verifying it on-chain before returning.
 *
 * @param config - Client config.
 * @param traceRef - Trace reference: either a trace hash (hex) or a numeric id string.
 * @param expectedTraceHash - Expected sha256 hex of the trace content.
 */
export async function fetchAndVerifyTrace(
  config: TraceApiClientConfig,
  traceRef: string,
  expectedTraceHash: string,
): Promise<FetchedTrace> {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const traceUrl = `${config.apiBaseUrl.replace(/\/$/, "")}/trace/${encodeURIComponent(traceRef)}`;

  // Step 1: probe — expect 402
  const probeResp = await fetch(traceUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (probeResp.status !== 402) {
    if (probeResp.ok) {
      throw new PaymentError("Expected 402 Payment Required but got 200 — trace may be free or already paid");
    }
    throw new PaymentError(`Unexpected status ${probeResp.status} from trace API`, probeResp.status);
  }

  const paymentRequired = parsePaymentRequired(probeResp);
  const preimageXdr = paymentRequired.paymentDetails["preimage_xdr"] as string | undefined;
  if (!preimageXdr) {
    throw new PaymentError("402 response did not include preimage_xdr in WWW-Authenticate");
  }

  // Step 2: sign the payment authorisation
  const paymentAuthXdr = await config.signer.signPaymentAuth(preimageXdr);

  // Step 3: fetch with X-PAYMENT header
  const paidResp = await fetch(traceUrl, {
    headers: { "X-PAYMENT": paymentAuthXdr },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!paidResp.ok) {
    throw new PaymentError(
      `Paid fetch failed with status ${paidResp.status}: ${await paidResp.text().catch(() => "")}`,
      paidResp.status,
    );
  }

  // Step 4: extract on-chain trace_id from response header
  const traceId = parsePaymentResponse(paidResp);

  // Step 5: read content and verify on-chain
  const content = new Uint8Array(await paidResp.arrayBuffer());
  const verificationResult = await verifyTraceOnChain({
    traceHash: expectedTraceHash,
    traceId,
    registry: config.registry,
  });

  return { content, traceId, verificationResult };
}

export { PaymentRequired, PaymentError, TraceNotFound, VerificationFailed } from "./errors.js";
export { verifyTraceOnChain } from "./verify.js";
export type { RegistryClient, VerificationResult } from "./verify.js";
