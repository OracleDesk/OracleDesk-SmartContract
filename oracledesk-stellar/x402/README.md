# OracleDesk x402 paid-trace server

Sells access to agent reasoning traces through x402 (verify → settle →
deliver), backed by a durable payment ledger. Architecture, payment states and
reconciliation: [`docs/architecture.md`](../docs/architecture.md#x402-payment-preparation-settlement-and-replay).

```bash
cd oracledesk-stellar/x402
npm ci && npm run build && npm test
npm start                     # tsx server.ts; reads .env
LOG_LEVEL=debug npm start | npx pino-pretty   # readable local logs
```

## Logging and metrics (#328)

### Logs

Every line is structured pino JSON on stdout with `service`, `level`, `time`
and `msg`. Request-scoped lines carry `reqId`: an inbound `X-Request-Id`
matching `^[A-Za-z0-9-]{8,64}$` is reused, otherwise a UUID is generated, and
the id is echoed in the `X-Request-Id` response header. Payment-path lines add
`paymentId`, `traceId` and `network`. A successful purchase logs
`x402 trace delivered` with `{ stage: "delivered", verifyMs, settleMs, bytes }`.
Every failure is logged once, at `error` for 5xx kinds and `warn` otherwise,
with its `kind` and `stage`. `LOG_LEVEL` sets the level (default `info`).

**Redaction guarantees.**

- Payment payloads (signed authorisations) are never logged: only
  `paymentIdentity(...)` fields are. `PAYMENT-SIGNATURE`, `X-Payment`,
  `Authorization`, `Cookie`, `X-Api-Key`, `PAYMENT-RESPONSE` and
  `X-OracleDesk-Receipt` headers, `facilitatorApiKey`, any `paymentPayload`
  and `*.payload.signature` are censored by pino `redact`.
- The error serializer drops `config`, `request`, `response` and
  `paymentPayload` from error objects (HTTP clients, including `@x402/core`,
  embed the request body there).
- Request logs record method and path only; query strings never appear.
- pino redaction does not apply to text inside the message, so every log
  call uses a constant message and structured fields. Tests search all
  captured log output for the raw payment header, the transaction and the
  facilitator keys.

### Metrics

`/metrics` is served by a separate `node:http` listener on `METRICS_PORT`,
bound to `METRICS_HOST` (default `0.0.0.0` so a container's published port
works). It is not reachable through the public API port. Without
`METRICS_PORT` no listener starts.

| Metric | Type | Labels |
| --- | --- | --- |
| `x402_stage_total` | counter | `stage` = `prepare\|verify\|settle\|deliver`, `outcome` = `ok\|error\|timeout\|replay`, `network` |
| `x402_stage_duration_seconds` | histogram | `stage`, `network` |
| `x402_upstream_duration_seconds` | histogram | `upstream` = `facilitator_verify\|facilitator_settle\|registry\|ipfs`, `outcome` = `ok\|error\|timeout` |
| `x402_ledger_transitions_total` | counter | `from` (the allowed source states, comma-joined), `to` |
| `x402_ledger_entries` | gauge | `state` (every `PaymentState`), sampled from the ledger on scrape |
| `x402_errors_total` | counter | `kind` (the error codes below) |
| `process_*`, `nodejs_*` | prom-client defaults | none |

Every label comes from a closed set. `network` is one of the configured
CAIP-2 ids, or `other` for anything a client sends that is not configured.
Trace ids, payment ids, payer addresses and URLs are never labels. Replays
count as `deliver` with `outcome="replay"` and never increment `settle`. A
facilitator timeout (`X402_FACILITATOR_TIMEOUT_MS`) is still observed, with
`outcome="timeout"`. `x402_ledger_entries` runs one indexed
`SELECT state, COUNT(*) … GROUP BY state` per scrape, never per request.

The two replicas in the root `docker-compose.yml` expose separate registries
(9090 and 9091); Prometheus aggregates them by `instance`:

```yaml
scrape_configs:
  - job_name: oracledesk-x402
    scrape_interval: 15s
    static_configs:
      - targets: ["x402-1:9090", "x402-2:9091"]
```

Example: settle error rate per network,
`sum by (network) (rate(x402_stage_total{stage="settle",outcome!="ok"}[5m]))`.

### Error codes

Every failure response is `{ "error": <kind>, "message": <constant text> }`
(plus `paymentId`, `retryAfter` or `transaction` where relevant). Messages
never echo the underlying cause. The SDK's own 402 challenge and its
verification/settlement rejections keep the x402 protocol body.

| `error` | Status | Meaning |
| --- | --- | --- |
| `invalid_envelope` | 402 | `PAYMENT-SIGNATURE` is not a decodable payment payload |
| `payment_expired` | 402 | Payment time or ledger bounds expired, or no ledger anchor |
| `unsupported_requirements` | 402 | Requirements do not match what this server advertises |
| `verify_rejected` | 402 | Facilitator rejected verification (SDK body) |
| `verify_unavailable` | 503 | Facilitator unreachable or timed out during verify |
| `settle_failed` | 402 / 409 | Settlement refused; 409 while it is being reconciled |
| `settle_indeterminate` | 502 | Settlement outcome unknown; never retried automatically |
| `registry_unavailable` | 503 | Registry RPC outage (`Retry-After: 30`); not a 404 |
| `registry_restore_required` | 503 | Registry entry archived; restore needed (#329) |
| `trace_not_found` | 404 | The registry has no such trace |
| `gateway_unavailable` | 502 | IPFS gateway failed or trace loading timed out |
| `trace_hash_mismatch` | 502 | Fetched bytes do not match the on-chain hash |
| `trace_invalid_json` | 502 | Trace bytes are not JSON |
| `ledger_unavailable` | 503 | The payment ledger could not be read or written |
| `payment_conflict` | 409 | Payment in progress or bound to another purchase |
| `verdict_refused` | 410 / policy | Registry verdict refuses sale (body keeps its `verdict`) |
| `internal` | 502 | Anything unclassified |

## Signed delivery receipts (#330)

Format, issuance and rotation are specified in
[`docs/architecture.md`](../docs/architecture.md#x402-signed-delivery-receipts-330).
Operationally:

```bash
# Generate a key pair (raw Ed25519, hex):
node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ed25519");
const j=k.privateKey.export({format:"jwk"});
console.log(JSON.stringify([{publicKey:Buffer.from(j.x,"base64url").toString("hex"),
secret:Buffer.from(j.d,"base64url").toString("hex"),notBefore:Math.floor(Date.now()/1000)}]))'
```

Put the output in `X402_RECEIPT_KEYS` (or a file named by
`X402_RECEIPT_KEYS_FILE`; an entry may use `secretFile` instead of `secret`).
`X402_RECEIPTS=required` makes a missing key set a startup error.

| Endpoint / header | Purpose |
| --- | --- |
| `X-OracleDesk-Receipt` + body `receipt` | On delivery and every replay; identical bytes |
| `GET /receipts/:paymentId` | Re-fetch with the original `PAYMENT-SIGNATURE`; same 404 for unknown and mismatched |
| `GET /.well-known/oracledesk-x402-keys.json` | Published keys and validity windows |
| `GET /admin/payments/:id` | Admin view now includes `receipt`, `settledAt` and decoded `receiptFields` |

Buyers verify offline with `verifyReceipt(receipt, await fetchKeySet(origin))`
from `verify-client.ts` (browser-safe). Golden vectors:
`docs/vectors/x402-receipt-v1.json`, regenerated with `npx tsx receipt-vectors.ts`.
