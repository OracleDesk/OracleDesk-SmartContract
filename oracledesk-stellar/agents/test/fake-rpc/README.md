# Fake Soroban RPC and chaos tests (#106)

`npm run test:chaos` runs `test/chaos/*.test.ts`: the real live-mode
`StellarAdapter` and the runtime trader/maker tasks against a local fake RPC.
No test reaches a real network; `blockRealNetwork()` makes any non-loopback
request fail.

## What is real and what is modelled

| Layer | In the tests |
| --- | --- |
| `StellarAdapter`, SDK contract client, signing, polling | Production code, unmodified |
| JSON-RPC 2.0 transport | Real HTTP on 127.0.0.1 |
| Responses | SDK shapes with real base64 XDR (ledger entries, `SorobanTransactionData`, auth entries, `TransactionResult`, `TransactionMeta` v3, contract events) |
| Contract code | Real WASM served from ledger entries; the SDK builds its client from the WASM's spec |
| Contract behaviour | `model.ts`: FPMM math from `core/fpmm.ts`, treasury caps, slippage, limit price, deadline, registry checks. Error codes come from each WASM's own `Error` enum |
| Ledger | `FakeSorobanRpc.clock`: one ledger per accepted transaction; sequence numbers, signatures and time bounds are enforced |

## Artifact path per contract

`artifacts.ts` picks, per contract, the first WASM whose spec encodes the
calls the adapter makes:

1. `compiled`: `target/wasm32v1-none/release/<name>.wasm`. CI's Node job
   downloads the Rust job's build here.
2. `vendored`: `contracts/integration-tests/wasm/<name>.wasm`.

If neither fits, the first one found is served with `fits: false` and the
reasons. The first adapter test asserts the source of every artifact.

On `develop` at the time of writing the contracts do not compile, so local
runs use the vendored WASM. That copy of `reasoning_registry` predates
`publish_trace(action: TraceAction)`, so the adapter cannot encode a trace
for it. The test "the trade's trace is published" is TODO with that reason
until a fitting registry WASM is served, and the trace invariants are checked
against journaled pending traces instead.

## Faults

`FaultPlan.script([...])` fires faults on the nth matching request (method
and, for simulate/send, contract function). `FaultPlan.chaos(seed)` draws them
from a seeded RNG (`sim/rng.ts`), so a seed always reproduces the same run:

| Fault | Effect |
| --- | --- |
| `latency`, `timeout` | Delayed response; dropped connection |
| `http`, `rpc-error` | HTTP 5xx; JSON-RPC error object |
| `contract-error` | Simulation fails with `Error(Contract, #n)` |
| `try-again-later`, `duplicate` | Submission refused; nothing applied |
| `tx-error` | `txBAD_SEQ`, `txTOO_LATE`, `txINSUFFICIENT_FEE`; nothing applied |
| `not-found` | Applied, but `getTransaction` answers NOT_FOUND `polls` times |
| `apply-failure` | Simulation passed, application fails; fee and sequence spent |
| `reset-after-accept` | Applied, then the connection is reset before the response |

The SDK polls `getTransaction` with real 1 s / 1.5 s backoff, so
`not-found` faults add real wall time; keep `polls` small.

## TODOs for the transaction-lifecycle issue

Tests marked `todo` assert behaviour that needs the separate lifecycle work
(see `LIFECYCLE_ISSUE` in `test/chaos/helpers.ts`). They run and report, but
do not fail the suite:

- `StellarAdapter.run()` does not check `getTransaction`'s status, so a
  transaction that fails on chain resolves as a success (`value: null`).
- After a lost response the trader trades again on the next tick (its journal
  key includes the trace hash, which changes every tick).
- The maker leaves an ambiguous create as `intent` for an operator; it is
  never retried, but also never reconciled.

## Watcher chaos (#275)

`test/chaos/watcher.chaos.test.ts` does not use `FakeNetwork`: the fake RPC models
market-core, treasury and the registry, not the resolver. It runs the real
`createWatcher` (ticked directly, without the Runtime loop) against a seeded resolver model injected at the
adapter boundary (per-call ledger-time latency, read timeouts, ambiguous
submissions, transient rejections) and checks the invariants listed in the file.
Serving the resolver WASM, its ledger entries and a SEP-41 balance from the fake
HTTP RPC is the natural next step once the resolver compiles on `develop`.
