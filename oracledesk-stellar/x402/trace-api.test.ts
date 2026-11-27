import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import request from "supertest";
import {
  Account,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  createTraceApi,
  MapTraceRepository,
  type TraceApiOptions,
} from "./trace-api.js";
import { MemoryPaymentLedger, paymentIdentity } from "./payment-ledger.js";
import { fakeFacilitator } from "./test/fake-facilitator.js";
import { createLogger } from "./logger.js";
import { RegistryTraceRepository } from "./registry-trace-repository.js";
import { loadReceiptSigner } from "./receipt-keys.js";
import { verifyReceipt } from "./receipt.js";
import { testKey } from "./receipt-vectors.js";
const bytes = Buffer.from('{"reason":"fixture"}');
const hash = createHash("sha256").update(bytes).digest("hex");
const destination = Keypair.random().publicKey();
function tx(network: string, expired = false) {
  const key = Keypair.random();
  const builder = new TransactionBuilder(new Account(key.publicKey(), "0"), {
    fee: "100",
    networkPassphrase:
      network === "stellar:testnet" ? Networks.TESTNET : Networks.PUBLIC,
  }).addOperation(Operation.manageData({ name: "fixture", value: "1" }));
  return (expired ? builder.setTimebounds(0, 1) : builder.setTimeout(60))
    .build()
    .toXDR();
}
function signature(
  accepted: PaymentRequirements,
  transaction = tx(accepted.network),
) {
  return Buffer.from(
    JSON.stringify({ x402Version: 2, accepted, payload: { transaction } }),
  ).toString("base64");
}
function requirements(r: request.Response): PaymentRequirements[] {
  return JSON.parse(
    Buffer.from(r.headers["payment-required"], "base64").toString(),
  ).accepts;
}
const quietLogger = createLogger();
quietLogger.level = "silent";
async function fixture(overrides: Partial<TraceApiOptions> = {}) {
  // Each advertises BOTH networks: routing must still respect the configured scope/key.
  const a = await fakeFacilitator(["stellar:testnet", "stellar:pubnet"]);
  const b = await fakeFacilitator(["stellar:testnet", "stellar:pubnet"]);
  const ledger = new MemoryPaymentLedger();
  const options: TraceApiOptions = {
    repository: new MapTraceRepository(
      new Map(
        ["1", "2"].map((traceId) => [
          traceId,
          { traceId, traceHash: hash, ipfsCid: "fixture" },
        ]),
      ),
    ),
    ipfsGateway: "https://fixture.invalid/ipfs",
    price: "0.01",
    ledger,
    networks: [
      {
        network: "stellar:testnet",
        payTo: destination,
        facilitatorUrl: a.url,
        facilitatorApiKey: "test-key",
      },
      {
        network: "stellar:pubnet",
        payTo: destination,
        facilitatorUrl: b.url,
        facilitatorApiKey: "main-key",
      },
    ],
    fetchImpl: async () => new Response(bytes),
    logger: quietLogger,
    ...overrides,
  };
  const app = createTraceApi(options);
  await app.locals.ready;
  return {
    app,
    options,
    ledger,
    a,
    b,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}
test("both networks advertised; each payment verifies/settles once with its own key; replay is free", async () => {
  const f = await fixture();
  try {
    const unpaid = await request(f.app).get("/traces/1");
    assert.equal(unpaid.status, 402);
    const accepts = requirements(unpaid);
    assert.equal(accepts.length, 2);
    for (let i = 0; i < 2; i++) {
      const header = signature(accepts[i]);
      const fake = i === 0 ? f.a : f.b;
      const paid = await request(f.app)
        .get("/traces/1")
        .set("PAYMENT-SIGNATURE", header);
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      assert.deepEqual(paid.body.content, { reason: "fixture" });
      assert.ok(paid.headers["payment-response"]);
      assert.equal(fake.calls.filter((c) => c.kind === "verify").length, 1);
      assert.equal(fake.calls.filter((c) => c.kind === "settle").length, 1);
      assert.ok(
        fake.calls.every(
          (c) => c.auth === `Bearer ${i === 0 ? "test-key" : "main-key"}`,
        ),
      );
      const replay = await request(f.app)
        .get("/traces/1")
        .set("PAYMENT-SIGNATURE", header);
      assert.equal(replay.status, 200);
      assert.equal(replay.text, paid.text);
      assert.equal(
        replay.headers["payment-response"],
        paid.headers["payment-response"],
      );
      assert.equal(fake.calls.filter((c) => c.kind === "settle").length, 1);
      const other = await request(f.app)
        .get("/traces/2")
        .set("PAYMENT-SIGNATURE", header);
      assert.equal(other.status, 409);
    }
  } finally {
    await f.close();
  }
});
for (const failure of ["missing", "gateway", "hash", "json", "timeout"])
  test(`${failure}: no verify or settlement`, async () => {
    const invalid = Buffer.from("not json");
    const f = await fixture(
      failure === "timeout"
        ? {
            traceLoadTimeoutMs: 20,
            fetchImpl: async () => new Promise<Response>(() => {}),
          }
        : failure === "gateway"
          ? { fetchImpl: async () => new Response("", { status: 500 }) }
          : failure === "hash"
            ? { fetchImpl: async () => new Response("wrong") }
            : failure === "json"
              ? {
                  repository: new MapTraceRepository(
                    new Map([
                      [
                        "1",
                        {
                          traceId: "1",
                          ipfsCid: "fixture",
                          traceHash: createHash("sha256")
                            .update(invalid)
                            .digest("hex"),
                        },
                      ],
                    ]),
                  ),
                  fetchImpl: async () => new Response(invalid),
                }
              : {},
    );
    try {
      const start = Date.now();
      const r = await request(f.app).get(
        `/traces/${failure === "missing" ? "99" : "1"}`,
      );
      assert.equal(r.status, failure === "missing" ? 404 : 502);
      assert.ok(Date.now() - start < 1000);
      assert.equal(f.a.calls.filter((c) => c.kind !== "supported").length, 0);
      assert.equal(f.b.calls.filter((c) => c.kind !== "supported").length, 0);
    } finally {
      await f.close();
    }
  });
test("tampered, unconfigured, upfront and expired payloads never settle", async () => {
  const f = await fixture();
  try {
    const accepts = requirements(await request(f.app).get("/traces/1"));
    for (const patch of [
      { payTo: Keypair.random().publicKey() },
      { amount: "1" },
      { asset: "wrong" },
      { network: "stellar:other" },
      { extra: { paymentFlow: "upfront" } },
    ]) {
      const r = await request(f.app)
        .get("/traces/1")
        .set(
          "PAYMENT-SIGNATURE",
          signature({ ...accepts[0], ...patch } as PaymentRequirements),
        );
      assert.equal(r.status, 402);
    }
    const r = await request(f.app)
      .get("/traces/1")
      .set(
        "PAYMENT-SIGNATURE",
        signature(accepts[0], tx("stellar:testnet", true)),
      );
    assert.equal(r.status, 402);
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 0);
    assert.equal(f.a.calls.filter((c) => c.kind === "verify").length, 0);
  } finally {
    await f.close();
  }
});
test("invalid payment and settlement refusal do not deliver content", async () => {
  const f = await fixture();
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    f.a.knobs.valid = false;
    assert.equal(
      (
        await request(f.app)
          .get("/traces/1")
          .set("PAYMENT-SIGNATURE", signature(a))
      ).status,
      402,
    );
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 0);
    f.a.knobs.valid = true;
    f.a.knobs.success = false;
    const r = await request(f.app)
      .get("/traces/1")
      .set("PAYMENT-SIGNATURE", signature(a));
    assert.notEqual(r.status, 200);
    assert.equal(r.body.content, undefined);
  } finally {
    await f.close();
  }
});
test("concurrent requests have one settlement and a durable settling record", async () => {
  const f = await fixture();
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a);
    const id = paymentIdentity(
      JSON.parse(Buffer.from(header, "base64").toString()) as PaymentPayload,
    ).paymentId;
    f.a.knobs.verifyLatencyMs = 20;
    f.a.knobs.beforeSettle = async () => {
      assert.equal((await f.ledger.get(id))?.state, "settling");
    };
    const rs = await Promise.all(
      [1, 2].map(() =>
        request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header),
      ),
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 1);
  } finally {
    await f.close();
  }
});
test("settlement timeout is indeterminate and is never retried", async () => {
  const f = await fixture({ facilitatorTimeoutMs: 150 });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a);
    f.a.knobs.settleLatencyMs = 400;
    const r = await request(f.app)
      .get("/traces/1")
      .set("PAYMENT-SIGNATURE", header);
    assert.equal(r.status, 502);
    const id = paymentIdentity(
      JSON.parse(Buffer.from(header, "base64").toString()) as PaymentPayload,
    ).paymentId;
    assert.equal((await f.ledger.get(id))?.state, "indeterminate");
    assert.equal(
      (await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header))
        .status,
      409,
    );
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 1);
  } finally {
    await f.close();
  }
});
test("duplicate/invalid config and timeout budgets rejected synchronously", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        createTraceApi({
          ...f.options,
          networks: [f.options.networks[0], f.options.networks[0]],
        }),
      /Duplicate/,
    );
    assert.throws(
      () =>
        createTraceApi({
          ...f.options,
          networks: [{ ...f.options.networks[0], payTo: "invalid" }],
        }),
      /payTo/,
    );
    assert.throws(
      () => createTraceApi({ ...f.options, traceLoadTimeoutMs: 60_000 }),
      /maxTimeout/,
    );
  } finally {
    await f.close();
  }
});
test("strict startup fails; degraded startup drops unreachable networks; single-network works", async () => {
  const f = await fixture();
  try {
    const dead = {
      ...f.options.networks[1],
      facilitatorUrl: "http://127.0.0.1:1",
    };
    const strict = createTraceApi({
      ...f.options,
      networks: [f.options.networks[0], dead],
      facilitatorTimeoutMs: 30,
    });
    await assert.rejects(strict.locals.ready);
    const degraded = createTraceApi({
      ...f.options,
      networks: [f.options.networks[0], dead],
      facilitatorTimeoutMs: 30,
      requireAllNetworks: false,
    });
    await degraded.locals.ready;
    const a = requirements(await request(degraded).get("/traces/1"));
    assert.equal(a.length, 1);
    assert.equal(
      (
        await request(degraded)
          .get("/traces/1")
          .set("PAYMENT-SIGNATURE", signature(a[0]))
      ).status,
      200,
    );
    const none = createTraceApi({
      ...f.options,
      networks: [dead],
      facilitatorTimeoutMs: 30,
      requireAllNetworks: false,
    });
    await assert.rejects(none.locals.ready, /No reachable/);
  } finally {
    await f.close();
  }
});

test("challenge matches stock SDK middleware, including headers and body", async () => {
  const { default: express } = await import("express");
  const { HTTPFacilitatorClient, x402ResourceServer } = await import(
    "@x402/core/server"
  );
  const { paymentMiddleware } = await import("@x402/express");
  const { ExactStellarScheme } = await import("@x402/stellar/exact/server");
  const { buildRoutes } = await import("./trace-api.js");
  const f = await fixture();
  try {
    const server = new x402ResourceServer(
      new HTTPFacilitatorClient({ url: f.a.url }),
    );
    server
      .register("stellar:testnet", new ExactStellarScheme())
      .register("stellar:pubnet", new ExactStellarScheme());
    const stock = express();
    stock.use(paymentMiddleware(buildRoutes(f.options), server));
    stock.get("/traces/:traceId", (_req, res) => res.json({}));
    const a = await request(f.app)
      .get("/traces/1")
      .set("Host", "fixture.invalid");
    const b = await request(stock)
      .get("/traces/1")
      .set("Host", "fixture.invalid");
    assert.equal(a.status, b.status);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.headers["payment-required"], b.headers["payment-required"]);
    assert.equal(a.headers["cache-control"], b.headers["cache-control"]);
  } finally {
    await f.close();
  }
});
test("ledger failure prevents settlement; support endpoint is authenticated and redacted", async () => {
  class BrokenLedger extends MemoryPaymentLedger {
    override async transition(
      ...args: Parameters<MemoryPaymentLedger["transition"]>
    ) {
      if (args[2] === "settling")
        throw new Error("simulated disk failure before settle");
      return super.transition(...args);
    }
  }
  const ledger = new BrokenLedger();
  const f = await fixture({ ledger, adminToken: "admin-test" });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a);
    const id = paymentIdentity(
      JSON.parse(Buffer.from(header, "base64").toString()) as PaymentPayload,
    ).paymentId;
    const r = await request(f.app)
      .get("/traces/1")
      .set("PAYMENT-SIGNATURE", header);
    assert.notEqual(r.status, 200);
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 0);
    assert.equal(
      (await request(f.app).get(`/admin/payments/${id}`)).status,
      401,
    );
    const admin = await request(f.app)
      .get(`/admin/payments/${id}`)
      .set("Authorization", "Bearer admin-test");
    assert.equal(admin.status, 200);
    assert.equal(admin.body.paymentId, id);
    assert.equal(admin.body.responseBody, undefined);
    assert.equal(admin.body.traceBytes, undefined);
  } finally {
    await f.close();
  }
});
test("replay uses original verified bytes despite mutable repository; replay bounded by the redelivery window", async () => {
  const ledger = new MemoryPaymentLedger();
  let unavailable = false;
  const f = await fixture({
    ledger,
    repository: {
      async get(traceId) {
        if (unavailable) throw new Error("registry changed");
        return { traceId, traceHash: hash, ipfsCid: "fixture" };
      },
    },
  });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a);
    const paid = await request(f.app)
      .get("/traces/1")
      .set("PAYMENT-SIGNATURE", header);
    assert.equal(paid.status, 200);
    unavailable = true;
    const replay = await request(f.app)
      .get("/traces/1")
      .set("PAYMENT-SIGNATURE", header);
    assert.equal(replay.status, 200);
    assert.equal(replay.text, paid.text);
    // Past the payment's authorization expiry (60 s) but inside the
    // redelivery window (900 s default): still replayable (#279).
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      const late = await request(f.app)
        .get("/traces/1")
        .set("PAYMENT-SIGNATURE", header);
      assert.equal(late.status, 200);
      assert.equal(late.text, paid.text);
    } finally {
      Date.now = realNow;
    }
    // Past the redelivery window: closed.
    Date.now = () => realNow() + 901_000;
    try {
      assert.equal(
        (await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header))
          .status,
        410,
      );
    } finally {
      Date.now = realNow;
    }
    assert.equal(f.a.calls.filter((c) => c.kind === "verify").length, 1);
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 1);
  } finally {
    await f.close();
  }
});
test("finite ledger bounds require a live ledger anchor and reject expired ledgers before verify", async () => {
  const f = await fixture({ ledgerSequence: async () => 1000 });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const key = Keypair.random();
    const transaction = new TransactionBuilder(
      new Account(key.publicKey(), "0"),
      { fee: "100", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(Operation.manageData({ name: "fixture", value: "1" }))
      .setLedgerbounds(1, 900)
      .setTimeout(60)
      .build()
      .toXDR();
    assert.equal(
      (
        await request(f.app)
          .get("/traces/1")
          .set("PAYMENT-SIGNATURE", signature(a, transaction))
      ).status,
      402,
    );
    assert.equal(f.a.calls.filter((c) => c.kind === "verify").length, 0);
  } finally {
    await f.close();
  }
});

test("one facilitator URL with different keys still routes by network", async () => {
  const f = await fixture();
  try {
    const app = createTraceApi({
      ...f.options,
      ledger: new MemoryPaymentLedger(),
      networks: f.options.networks.map((n) => ({
        ...n,
        facilitatorUrl: f.a.url,
      })),
    });
    await app.locals.ready;
    const accepts = requirements(await request(app).get("/traces/1"));
    for (const a of accepts)
      assert.equal(
        (
          await request(app)
            .get("/traces/1")
            .set("PAYMENT-SIGNATURE", signature(a))
        ).status,
        200,
      );
    for (const call of f.a.calls.filter((c) => c.kind !== "supported"))
      assert.equal(
        call.auth,
        `Bearer ${call.network === "stellar:testnet" ? "test-key" : "main-key"}`,
      );
    assert.equal(f.b.calls.filter((c) => c.kind !== "supported").length, 0);
  } finally {
    await f.close();
  }
});
test("successful flow prepares content before verify, settles before delivery", async () => {
  const order: string[] = [];
  const f = await fixture({
    fetchImpl: async () => {
      order.push("load");
      return new Response(bytes);
    },
  });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    order.length = 0;
    f.a.knobs.beforeVerify = async () => {
      order.push("verify");
    };
    f.a.knobs.beforeSettle = async () => {
      order.push("settle");
    };
    const paid = await request(f.app)
      .get("/traces/1")
      .set("PAYMENT-SIGNATURE", signature(a));
    assert.equal(paid.status, 200);
    order.push("deliver");
    assert.deepEqual(order, ["load", "verify", "settle", "deliver"]);
  } finally {
    await f.close();
  }
});
test("response encoding failure never verifies or settles", async () => {
  const f = await fixture({
    repository: {
      async get() {
        return {
          traceId: 1n as unknown as string,
          traceHash: hash,
          ipfsCid: "fixture",
        };
      },
    },
  });
  try {
    const result = await request(f.app).get("/traces/1");
    assert.equal(result.status, 502);
    assert.equal(f.a.calls.filter((c) => c.kind !== "supported").length, 0);
  } finally {
    await f.close();
  }
});

test("#299: KeyCompromised trace returns 410 before any payment is verified", async () => {
  const f = await fixture({
    repository: new MapTraceRepository(
      new Map([
        [
          "1",
          {
            traceId: "1",
            traceHash: hash,
            ipfsCid: "fixture",
            verdict: { tag: "KeyCompromised", values: [1n] },
          },
        ],
      ]),
    ),
  });
  try {
    const r = await request(f.app).get("/traces/1");
    assert.equal(r.status, 410);
    assert.deepEqual(r.body, {
      error: "trace_not_valid",
      verdict: { tag: "KeyCompromised", values: [1n] },
    });
    // No facilitator calls should have happened.
    assert.equal(f.a.calls.filter((c) => c.kind !== "supported").length, 0);
    assert.equal(f.b.calls.filter((c) => c.kind !== "supported").length, 0);
  } finally {
    await f.close();
  }
});

// ----- redelivery window and refunds (#279) ---------------------------------

import { connect } from "node:net";
import { StrKey, SorobanDataBuilder, xdr, rpc as stellarRpc } from "@stellar/stellar-sdk";
import { RefundExecutor, sweepRefunds, type RefundPolicy } from "./refunds.js";

const refundPolicy: RefundPolicy = {
  redeliveryWindowMs: 900_000,
  autoApproveMax: 10_000_000n,
  windowCap: 100_000_000n,
  windowMs: 86_400_000,
  maxAttempts: 3,
};

/** Executor against a stub RPC whose transactions always land. */
function refundExecutor(ledger: MemoryPaymentLedger) {
  const sent: string[] = [];
  const executor = new RefundExecutor({
    ledger,
    policy: refundPolicy,
    secret: Keypair.random().secret(),
    rpcFor: () => ({
      async getAccount(a) {
        return new Account(a, "1");
      },
      async simulateTransaction() {
        return {
          id: "1",
          latestLedger: 1,
          events: [],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          result: { auth: [], retval: xdr.ScVal.scvVoid() },
        } as never;
      },
      async sendTransaction(tx) {
        sent.push(tx.hash().toString("hex"));
        return { status: "PENDING" } as never;
      },
      async getTransaction() {
        return { status: stellarRpc.Api.GetTransactionStatus.SUCCESS } as never;
      },
    }),
    sleep: async () => {},
    log: () => {},
  });
  return { executor, sent };
}

/** Sends the paid request on a raw socket and drops it before the response. */
async function abortedPurchase(app: import("express").Express, header: string) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as { port: number };
  const socket = connect(port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  socket.write(
    `GET /traces/1 HTTP/1.1\r\nHost: x\r\nPAYMENT-SIGNATURE: ${header}\r\n\r\n`,
  );
  await new Promise((r) => setTimeout(r, 40));
  socket.destroy();
  return server;
}

async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

test("client abort before finish leaves the entry settled; the sweeper refunds it; replay then returns 410", async () => {
  const f = await fixture();
  const payer = Keypair.random().publicKey();
  f.a.knobs.payer = payer;
  f.a.knobs.settleLatencyMs = 150;
  let server: import("node:http").Server | undefined;
  const realNow = Date.now;
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a);
    server = await abortedPurchase(f.app, header);
    const id = paymentIdentity(JSON.parse(Buffer.from(header, "base64").toString())).paymentId;
    await waitFor(async () => (await f.ledger.get(id))?.state === "settled");
    await new Promise((r) => setTimeout(r, 50));
    // Never delivered: still settled, with the payer recorded.
    const e = (await f.ledger.get(id))!;
    assert.equal(e.state, "settled");
    assert.equal(e.payer, payer);
    assert.ok(e.settledAt);

    // Past the redelivery window the sweeper refunds it.
    const t0 = realNow();
    Date.now = () => t0 + refundPolicy.redeliveryWindowMs + 1_000;
    const r = refundExecutor(f.ledger);
    await sweepRefunds(f.ledger, r.executor, refundPolicy, { batch: 10, log: () => {} });
    const refunded = (await f.ledger.get(id))!;
    assert.equal(refunded.state, "refunded");
    assert.equal(r.sent.length, 1);

    // A replay now never gets the trace.
    const replay = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(replay.status, 410);
    assert.deepEqual(replay.body, { error: "Payment refunded", refundTx: refunded.refundTx });
    assert.ok(!replay.text.includes("fixture"));
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 1);
  } finally {
    Date.now = realNow;
    server?.close();
// ── #328 observability ────────────────────────────────────────────────────

function captureLogger() {
  const lines: string[] = [];
  const log = createLogger({
    write(line: string) {
      lines.push(line);
    },
  });
  log.level = "trace";
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

test("logs carry reqId, paymentId, traceId and network", async () => {
  const cap = captureLogger();
  const f = await fixture({ logger: cap.log });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const paid = await request(f.app)
      .get("/traces/1")
      .set("X-Request-Id", "req-abcdef-123")
      .set("PAYMENT-SIGNATURE", signature(a!));
    assert.equal(paid.status, 200);
    assert.equal(paid.headers["x-request-id"], "req-abcdef-123");
    const delivered = cap.parsed().find((l) => l.msg === "x402 trace delivered");
    assert.ok(delivered, "no delivery log line");
    assert.equal(delivered.reqId, "req-abcdef-123");
    assert.equal(delivered.traceId, "1");
    assert.match(delivered.paymentId, /^[0-9a-f]{64}$/);
    assert.equal(delivered.network, "stellar:testnet");
    assert.equal(delivered.stage, "delivered");
    assert.equal(typeof delivered.settleMs, "number");
    assert.equal(typeof delivered.verifyMs, "number");
    assert.equal(delivered.bytes, bytes.length);
    for (const line of cap.parsed()) assert.ok(line.reqId || line.event, JSON.stringify(line));
  } finally {
    await f.close();
  }
});

test("no payment payload or api key appears in any log line", async () => {
  const cap = captureLogger();
  const f = await fixture({ logger: cap.log });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    const transaction = JSON.parse(Buffer.from(header, "base64").toString())
      .payload.transaction as string;
    await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header); // replay
    await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", "!!notbase64");
    await request(f.app)
      .get("/traces/1")
      .set("Authorization", "Bearer admin-secret")
      .set("Cookie", "session=secret-cookie");
    f.a.knobs.success = false;
    const [b] = requirements(await request(f.app).get("/traces/2"));
    await request(f.app).get("/traces/2").set("PAYMENT-SIGNATURE", signature(b!));
    const all = cap.lines.join("\n");
    assert.ok(cap.lines.length > 5);
    for (const secret of [
      header,
      transaction,
      "test-key",
      "main-key",
      "admin-secret",
      "secret-cookie",
    ])
      assert.ok(!all.includes(secret), `log leaked ${secret.slice(0, 16)}`);
  } finally {
    await f.close();
  }
});

test("registry RPC outage returns 503 registry_unavailable", async () => {
  const reader = {
    async get_trace(): Promise<never> {
      throw new Error("fetch failed", { cause: new Error("ECONNREFUSED") });
    },
    async traces_by_agent(): Promise<never> {
      throw new Error("unused");
    },
    async traces_by_market_action(): Promise<never> {
      throw new Error("unused");
    },
  };
  const f = await fixture({ repository: new RegistryTraceRepository(reader) });
  try {
    const r = await request(f.app).get("/traces/1");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "registry_unavailable");
    assert.equal(r.headers["retry-after"], "30");
    assert.equal(f.a.calls.filter((c) => c.kind !== "supported").length, 0);
  } finally {
    await f.close();
  }
});

test("archived registry entry returns 503 registry_restore_required, not 404", async () => {
  const reader = {
    async get_trace(): Promise<never> {
      throw Object.assign(new Error("simulation requires restore"), {
        restorePreamble: { minResourceFee: "100" },
      });
    },
    async traces_by_agent(): Promise<never> {
      throw new Error("unused");
    },
    async traces_by_market_action(): Promise<never> {
      throw new Error("unused");
    },
  };
  const f = await fixture({ repository: new RegistryTraceRepository(reader) });
  try {
    const r = await request(f.app).get("/traces/1");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "registry_restore_required");
    assert.ok(r.headers["retry-after"]);
  } finally {
    await f.close();
  }
});

test("hash mismatch returns 502 trace_hash_mismatch; trace not found is 404", async () => {
  const f = await fixture({ fetchImpl: async () => new Response("tampered") });
  try {
    const r = await request(f.app).get("/traces/1");
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, {
      error: "trace_hash_mismatch",
      message: "Trace failed on-chain hash verification",
    });
    const missing = await request(f.app).get("/traces/404");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "trace_not_found");
    const metricsText = await f.app.locals.metrics.registry.metrics();
    assert.match(metricsText, /x402_errors_total\{kind="trace_hash_mismatch"\} 1/);
  } finally {
    await f.close();
  }
});

test("verify and settle order and settling CAS unchanged", async () => {
  const f = await fixture();
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    const id = paymentIdentity(JSON.parse(Buffer.from(header, "base64").toString()))
      .paymentId;
    const states: (string | undefined)[] = [];
    f.a.knobs.beforeVerify = async () => {
      states.push((await f.ledger.get(id))?.state);
    };
    f.a.knobs.beforeSettle = async () => {
      states.push((await f.ledger.get(id))?.state);
    };
    const paid = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(paid.status, 200);
    assert.deepEqual(
      f.a.calls.filter((c) => c.kind !== "supported").map((c) => c.kind),
      ["verify", "settle"],
    );
    // The durable settling claim is written before the facilitator settles.
    assert.deepEqual(states, ["verifying", "settling"]);
  } finally {
    await f.close();
  }
});

test("replay after expiry works inside the redelivery window and records delivery", async () => {
  const f = await fixture();
  f.a.knobs.payer = Keypair.random().publicKey();
  f.a.knobs.settleLatencyMs = 150;
  let server: import("node:http").Server | undefined;
  const realNow = Date.now;
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a);
    server = await abortedPurchase(f.app, header);
    const id = paymentIdentity(JSON.parse(Buffer.from(header, "base64").toString())).paymentId;
    await waitFor(async () => (await f.ledger.get(id))?.state === "settled");
    const t0 = realNow();
    Date.now = () => t0 + 300_000; // authorization expired (60 s), window open
    const replay = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.content, { reason: "fixture" });
    assert.equal((await f.ledger.get(id))!.state, "delivered");
    // A delivered payment is never refunded.
    const r = refundExecutor(f.ledger);
    Date.now = () => t0 + 10 * refundPolicy.redeliveryWindowMs;
    await sweepRefunds(f.ledger, r.executor, refundPolicy, { batch: 10, log: () => {} });
    assert.equal(r.sent.length, 0);
  } finally {
    Date.now = realNow;
    server?.close();
test("payment stages are counted; replay counts deliver/replay, not settle", async () => {
  const f = await fixture();
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    const values = (await f.app.locals.metrics.stage.get()).values as {
      labels: Record<string, string>;
      value: number;
    }[];
    const count = (stage: string, outcome: string) =>
      values.find((v) => v.labels.stage === stage && v.labels.outcome === outcome)
        ?.value ?? 0;
    assert.equal(count("verify", "ok"), 1);
    assert.equal(count("settle", "ok"), 1);
    assert.equal(count("deliver", "ok"), 1);
    assert.equal(count("deliver", "replay"), 1);
    const text = await f.app.locals.metrics.registry.metrics();
    assert.match(text, /x402_upstream_duration_seconds_count\{upstream="facilitator_settle",outcome="ok"\} 1/);
    assert.match(text, /x402_ledger_transitions_total\{from="verifying",to="settling"\} 1/);
    // /metrics is not exposed on the public API.
    assert.equal((await request(f.app).get("/metrics")).status, 404);
  } finally {
    await f.close();
  }
});

// ── #330 signed delivery receipts ─────────────────────────────────────────

async function signerFor(extra: object[] = []) {
  const { seed, publicKey } = testKey();
  return loadReceiptSigner(
    JSON.stringify([...extra, { publicKey, secret: seed, notBefore: 1 }]),
  );
}

function idOf(header: string) {
  return paymentIdentity(JSON.parse(Buffer.from(header, "base64").toString()))
    .paymentId;
}

test("settled payment returns X-OracleDesk-Receipt and body.receipt; replay is identical", async () => {
  const receiptSigner = await signerFor();
  const f = await fixture({ receiptSigner });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    const paid = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(paid.status, 200);
    const receipt = paid.headers["x-oracledesk-receipt"] as string;
    assert.ok(receipt);
    assert.equal(paid.body.receipt, receipt);
    assert.deepEqual(paid.body.content, { reason: "fixture" });
    const v = await verifyReceipt(receipt, receiptSigner.publicKeySet());
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.fields.paymentId, idOf(header));
      assert.equal(v.fields.traceId, "1");
      assert.equal(v.fields.traceHash, hash);
      assert.equal(v.fields.network, "stellar:testnet");
      assert.equal(v.fields.amount, a!.amount);
      assert.equal(v.fields.asset, a!.asset);
      assert.equal(v.fields.payTo, destination);
      assert.equal(v.fields.payer, "test-payer");
      assert.equal(v.fields.settlementTx, "ab".repeat(32));
      assert.equal(v.fields.verdict, "unchecked");
    }
    const replay = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["x-oracledesk-receipt"], receipt);
    assert.equal(replay.text, paid.text);
    const entry = await f.ledger.get(idOf(header));
    assert.equal(entry?.receipt, receipt);
    assert.equal(typeof entry?.settledAt, "number");
  } finally {
    await f.close();
  }
});

test("concurrent replay and refund produce exactly one outcome", async () => {
  for (let round = 0; round < 6; round++) {
    const f = await fixture();
    f.a.knobs.payer = StrKey.encodeContract(Buffer.alloc(32, round + 1));
    f.a.knobs.settleLatencyMs = 150;
    let server: import("node:http").Server | undefined;
    const realNow = Date.now;
    try {
      const [a] = requirements(await request(f.app).get("/traces/1"));
      const header = signature(a);
      server = await abortedPurchase(f.app, header);
      const id = paymentIdentity(JSON.parse(Buffer.from(header, "base64").toString())).paymentId;
      await waitFor(async () => (await f.ledger.get(id))?.state === "settled");
      const e = (await f.ledger.get(id))!;
      // Exactly at the window boundary both the replay check and the
      // sweeper's classify let the payment through; the CAS decides.
      Date.now = () => e.settledAt! + refundPolicy.redeliveryWindowMs;
      const r = refundExecutor(f.ledger);
      const [replay] = await Promise.all([
        request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header),
        sweepRefunds(f.ledger, r.executor, refundPolicy, { batch: 10, log: () => {} }),
      ]);
      const final = (await f.ledger.get(id))!;
      if (replay.status === 200) {
        assert.equal(final.state, "delivered");
        assert.equal(r.sent.length, 0, "delivered and refunded");
      } else {
        assert.equal(replay.status, 410);
        assert.ok(!replay.text.includes("fixture"));
        assert.ok(["refund_pending", "refunding", "refunded"].includes(final.state));
      }
    } finally {
      Date.now = realNow;
      server?.close();
      await f.close();
    }
  }
});

test("admin refunds API lists, approves and rejects reviewed refunds", async () => {
  const f = await fixture({ adminToken: "secret" });
  try {
    const ledger = f.ledger;
    for (const id of ["p1", "p2"]) {
      await ledger.claim({
        paymentId: id,
        traceId: "1",
        traceHash: hash,
        network: "stellar:testnet",
        payTo: destination,
        amount: "50000000",
        asset: StrKey.encodeContract(Buffer.alloc(32, 3)),
        expiresAt: 0,
      });
      await ledger.transition(id, ["verifying"], "settling");
      await ledger.transition(id, ["settling"], "settled", {
        settlementTx: "tx",
        payer: Keypair.random().publicKey(),
        paymentResponseHeader: "r",
        settledAt: 0,
      });
      const r = refundExecutor(ledger);
      await r.executor.open((await ledger.get(id))!, true);
    }
    const auth = { Authorization: "Bearer secret" };
    assert.equal((await request(f.app).get("/admin/refunds")).status, 401);
    const list = await request(f.app).get("/admin/refunds?state=review").set(auth);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 2);
    assert.ok(!("txXdr" in list.body.items[0]));
    assert.equal((await request(f.app).get("/admin/refunds?state=bogus").set(auth)).status, 400);
    const ok = await request(f.app).post("/admin/refunds/p1/approve").set(auth);
    assert.deepEqual(ok.body, { paymentId: "p1", state: "refund_pending" });
    assert.equal((await ledger.get("p1"))!.refundReview, false);
    assert.equal((await request(f.app).post("/admin/refunds/p1/approve").set(auth)).status, 409);
    const no = await request(f.app).post("/admin/refunds/p2/reject").set(auth);
    assert.equal(no.body.state, "refund_failed");
    const p = await request(f.app).get("/admin/payments/p2").set(auth);
    assert.equal(p.body.state, "refund_failed");
    assert.ok(p.body.refundId);
    assert.ok(!("responseBody" in p.body));
test("two concurrent requests with the same payment persist one receipt", async () => {
  const receiptSigner = await signerFor();
  const f = await fixture({ receiptSigner });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    f.a.knobs.settleLatencyMs = 50;
    const results = await Promise.all(
      [0, 1].map(() => request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header)),
    );
    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 1);
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 1);
    const entry = await f.ledger.get(idOf(header));
    assert.equal(entry?.receipt, ok[0]!.headers["x-oracledesk-receipt"]);
  } finally {
    await f.close();
  }
});

test("/receipts/:id requires a matching payment header and does not leak existence", async () => {
  const receiptSigner = await signerFor();
  const f = await fixture({ receiptSigner });
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    const other = signature(a!);
    const id = idOf(header);
    const paid = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    const noHeader = await request(f.app).get(`/receipts/${id}`);
    const wrongHeader = await request(f.app)
      .get(`/receipts/${id}`)
      .set("PAYMENT-SIGNATURE", other);
    const unknown = await request(f.app)
      .get(`/receipts/${idOf(other)}`)
      .set("PAYMENT-SIGNATURE", other);
    for (const r of [noHeader, wrongHeader, unknown]) {
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, noHeader.body);
    }
    const ok = await request(f.app).get(`/receipts/${id}`).set("PAYMENT-SIGNATURE", header);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
      receipt: paid.headers["x-oracledesk-receipt"],
      keysUrl: "/.well-known/oracledesk-x402-keys.json",
    });
  } finally {
    await f.close();
  }
});

test("well-known key set lists active and retired keys, without secrets", async () => {
  const retired = testKey("retired receipt key");
  const receiptSigner = await signerFor([
    { publicKey: retired.publicKey, notBefore: 1, notAfter: 2 },
  ]);
  const f = await fixture({ receiptSigner });
  try {
    const r = await request(f.app).get("/.well-known/oracledesk-x402-keys.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "public, max-age=300");
    assert.equal(r.body.keys.length, 2);
    assert.equal(r.body.keys[0].notAfter, 2);
    assert.equal(r.body.keys[1].notAfter, undefined);
    assert.ok(!r.text.includes(testKey().seed));
    assert.ok(!r.text.includes("secret"));
  } finally {
    await f.close();
  }
});

test("payments settled before receipts get one backfilled on replay", async () => {
  const f = await fixture();
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    const paid = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(paid.headers["x-oracledesk-receipt"], undefined);
    const receiptSigner = await signerFor();
    const app = createTraceApi({ ...f.options, receiptSigner });
    await app.locals.ready;
    const r1 = await request(app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    const r2 = await request(app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.ok(r1.headers["x-oracledesk-receipt"]);
    assert.equal(r2.headers["x-oracledesk-receipt"], r1.headers["x-oracledesk-receipt"]);
    const entry = await f.ledger.get(idOf(header));
    assert.equal(entry?.receiptBackfilled, true);
    assert.ok((await verifyReceipt(entry!.receipt!, receiptSigner.publicKeySet())).ok);
    assert.equal(f.a.calls.filter((c) => c.kind === "settle").length, 1);
  } finally {
    await f.close();
  }
});

test("a retry while settling gets 409 payment_conflict with Retry-After", async () => {
  const f = await fixture();
  try {
    const [a] = requirements(await request(f.app).get("/traces/1"));
    const header = signature(a!);
    let during: request.Response | undefined;
    f.a.knobs.beforeSettle = async () => {
      during = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    };
    const paid = await request(f.app).get("/traces/1").set("PAYMENT-SIGNATURE", header);
    assert.equal(paid.status, 200);
    assert.ok(during);
    assert.equal(during.status, 409);
    assert.equal(during.headers["retry-after"], "2");
    assert.equal(during.body.error, "payment_conflict");
    assert.equal(during.body.retryAfter, 2);
  } finally {
    await f.close();
  }
});