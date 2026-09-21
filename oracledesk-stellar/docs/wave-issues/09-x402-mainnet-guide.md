# x402: mainnet RPC configuration guide and health checks

## Context

`x402/server.ts` already supports a `stellar:pubnet` network branch
(`MAINNET_SERVER_STELLAR_ADDRESS` / `MAINNET_FACILITATOR_URL` env vars —
see `.env.example`), but nothing in this repo documents how to actually go
from the testnet setup this repo verifies (`docs/STATUS.md`) to a real
mainnet deployment: which facilitator to use, what monitoring/health checks
to run, and what changes (if any) to `TRACE_RECORDS_JSON` /
`REASONING_REGISTRY_CONTRACT_ID` are needed when the registry contract
itself is on mainnet.

## What to change

1. Write a `docs/x402-mainnet.md` guide: real x402-on-Stellar facilitator
   options for mainnet (verified against current docs, not guessed), the
   env vars to set, and a checklist for what must be true before flipping
   `AGENT_MODE=live` against mainnet contracts (out of scope for this repo
   to actually do, but the checklist should be complete).
2. Add a `/health` endpoint to `x402/server.ts` that checks: the configured
   RPC is reachable, the reasoning-registry contract (if configured) is
   readable, and the facilitator URL(s) respond.

## Files to touch

- `docs/x402-mainnet.md` (new)
- `x402/server.ts`, `x402/trace-api.ts` (health endpoint)
- `x402/trace-api.test.ts`-equivalent test for the health endpoint

## Acceptance criteria

- The guide cites real, current sources for facilitator options — no
  invented URLs.
- `/health` returns 200 with a breakdown of each check when everything is
  reachable, and a non-200 with which check(s) failed otherwise.

## How to test

```bash
cd x402 && npm test
curl localhost:3001/health
```

## Complexity

`complexity/small`
