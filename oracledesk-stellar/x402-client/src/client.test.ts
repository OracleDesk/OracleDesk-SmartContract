/**
 * E2E-style tests for @oracledesk/x402-client using an in-process fake facilitator.
 * Covers issue #312: x402 client round-trip + on-chain trace verification.
 */

import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { test, before, after } from "node:test";
import { fetchAndVerifyTrace } from "./client.js";
import type { RegistryClient } from "./verify.js";
import type { TraceApiSigner } from "./client.js";
import { PaymentError, TraceNotFound, VerificationFailed } from "./errors.js";

// ---------------------------------------------------------------------------
// Fake facilitator server
// ---------------------------------------------------------------------------

const FAKE_TRACE_CONTENT = new TextEncoder().encode("oracle trace payload v1");
const FAKE_TRACE_HASH = "aabbcc001122334455667788aabbcc001122334455667788aabbcc001122334455";
const FAKE_TRACE_ID = 42n;
const FAKE_PREIMAGE_XDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function createFakeFacilitator(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/trace/")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const hasPayment = Boolean(req.headers["x-payment"]);

    if (!hasPayment) {
      // Step 1: return 402 with preimage_xdr
      res.writeHead(402, {
        "WWW-Authenticate": `X402 realm="OracleDesk" preimage_xdr="${FAKE_PREIMAGE_XDR}"`,
      });
      res.end();
      return;
    }

    // Step 3: payment header present — return trace + PAYMENT-RESPONSE
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "PAYMENT-RESPONSE": `trace_id=${FAKE_TRACE_ID}`,
    });
    res.end(Buffer.from(FAKE_TRACE_CONTENT));
  });
}

// ---------------------------------------------------------------------------
// Fake registry client
// ---------------------------------------------------------------------------

function createFakeRegistry(overrides?: Partial<{
  result: null;
  trace_hash: string;
}>): RegistryClient {
  return {
    async get_trace({ trace_id }) {
      if (overrides?.result === null) {
        return { result: null };
      }
      return {
        result: {
          trace_hash: overrides?.trace_hash ?? FAKE_TRACE_HASH,
          agent: "agent-1",
          market_id: 7n,
          action: "PREDICT",
          ipfs_cid: "QmFakeCid",
          published_at: 1700000000n,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake signer
// ---------------------------------------------------------------------------

const fakeSigner: TraceApiSigner = {
  async signPaymentAuth(preimageXdr: string) {
    // In real usage this would sign with a Stellar keypair.
    return Buffer.from(`signed:${preimageXdr}`).toString("base64");
  },
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function startServer(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let facilitator: Server;
let baseUrl: string;

before(async () => {
  facilitator = createFakeFacilitator();
  const port = await startServer(facilitator);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopServer(facilitator);
});

test("fetchAndVerifyTrace: full happy path returns verified trace", async () => {
  const result = await fetchAndVerifyTrace(
    { apiBaseUrl: baseUrl, registry: createFakeRegistry(), signer: fakeSigner },
    "trace-abc",
    FAKE_TRACE_HASH,
  );

  assert.equal(result.traceId, FAKE_TRACE_ID);
  assert.deepEqual(result.content, FAKE_TRACE_CONTENT);
  assert.equal(result.verificationResult.verified, true);
  assert.equal(result.verificationResult.agent, "agent-1");
  assert.equal(result.verificationResult.marketId, 7n);
});

test("fetchAndVerifyTrace: throws VerificationFailed when hash mismatches", async () => {
  await assert.rejects(
    () =>
      fetchAndVerifyTrace(
        {
          apiBaseUrl: baseUrl,
          registry: createFakeRegistry({ trace_hash: "deadbeef" }),
          signer: fakeSigner,
        },
        "trace-abc",
        FAKE_TRACE_HASH,
      ),
    (err: unknown) => {
      assert.ok(err instanceof VerificationFailed, `Expected VerificationFailed, got ${err}`);
      return true;
    },
  );
});

test("fetchAndVerifyTrace: throws TraceNotFound when registry returns null", async () => {
  await assert.rejects(
    () =>
      fetchAndVerifyTrace(
        {
          apiBaseUrl: baseUrl,
          registry: createFakeRegistry({ result: null }),
          signer: fakeSigner,
        },
        "trace-abc",
        FAKE_TRACE_HASH,
      ),
    (err: unknown) => {
      assert.ok(err instanceof TraceNotFound, `Expected TraceNotFound, got ${err}`);
      return true;
    },
  );
});

test("fetchAndVerifyTrace: throws PaymentError for non-402/non-200 probe response", async () => {
  // Start a server that returns 500 on probe
  const badServer = createServer((_req, res) => {
    res.writeHead(500);
    res.end("internal error");
  });
  const port = await startServer(badServer);
  try {
    await assert.rejects(
      () =>
        fetchAndVerifyTrace(
          {
            apiBaseUrl: `http://127.0.0.1:${port}`,
            registry: createFakeRegistry(),
            signer: fakeSigner,
          },
          "any",
          FAKE_TRACE_HASH,
        ),
      (err: unknown) => {
        assert.ok(err instanceof PaymentError, `Expected PaymentError, got ${err}`);
        assert.equal((err as PaymentError).statusCode, 500);
        return true;
      },
    );
  } finally {
    await stopServer(badServer);
  }
});
