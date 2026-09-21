# OracleDesk

> Autonomous prediction market creation, agent-driven trading, and
> tamper-evident on-chain reasoning — natively on Stellar/Soroban.

**Status: testnet only · unaudited · pre-alpha**

OracleDesk is an autonomous prediction-market system: a Market Maker agent
seeds markets from signals it observes, a Trader agent trades mispricings
against a fair-value estimate, and every decision either agent makes is
hashed and recorded on-chain *before* it acts — so a subscriber can pay
about $0.01 (via the [x402](https://x402.org) protocol) to read the exact
reasoning behind a trade and check it against the on-chain hash, rather
than trusting the agent's word for it.

---

## System Architecture

```
STELLAR TESTNET — markets, treasury, and reasoning, all on Soroban
│
├── market-core            ← the hub: every binary market lives here
│   ├── constant-product FPMM (YES/NO share accounting, no external LP token)
│   ├── resolution_hash committed at creation — a market's resolution rule
│   │   is fixed before trading opens, so it can't be picked after the fact
│   └── SEP-41 USDC collateral (7 decimals)
│
├── resolver               ← turns a close market into a resolved one
│   ├── PriceThreshold mode — reads a Reflector (SEP-40) price feed
│   └── Attested mode       — m-of-n signer votes + a dispute window
│       (guardian can cancel a disputed proposal or void the market)
│
├── treasury                ← the only path that spends agent capital
│   ├── agent_create_market / agent_buy / agent_sell → calls market-core
│   │   as the trader/creator itself, after checking on-chain caps
│   └── per-trade / per-market / daily caps are real limits, not advisory
│
└── reasoning-registry      ← the reasoning-as-product layer
    └── publish_trace(agent, market_id, action, trace_hash, cid)
        emits an event; verify_trace(trace_id, hash) checks any claim
        │
        │  x402 (Express) — pays ~$0.01 USDC per trace, exact-payment scheme
        ▼
    x402 trace API  ← fetches the trace JSON, re-hashes it, serves it only
                       if the hash matches the on-chain record
```

Agents (`agents/` — TypeScript) never touch a wallet's raw capital
directly: `core/` is chain-agnostic strategy and trace-building logic,
`stellar/` is a thin, mode-aware adapter (dry-run by default; live mode
needs an explicit secret key) over generated contract bindings.

Design decisions with real trade-offs are written up as ADRs — see
[`oracledesk-stellar/docs/adr/`](oracledesk-stellar/docs/adr/).

---

## Repository Structure

The active implementation is [`oracledesk-stellar/`](oracledesk-stellar/):

```
oracledesk-stellar/
├── contracts/            market-core, resolver, treasury, reasoning-registry
├── model/fpmm_model.py   Python mirror of the FPMM math, property-tested
├── x402/                 the paid trace API (Express + @x402/*)
├── agents/               core/ (strategy + trace building), stellar/ (adapter), bin/ (CLIs)
├── packages/bindings/    generated TypeScript contract clients
├── scripts/              deploy-testnet.sh, seed-market.sh, demo.sh, gen-bindings.sh
├── deployments/          testnet.json — the current live testnet addresses
└── docs/                 architecture.md, adr/, frontend-integration.md, STATUS.md
```

`oracledesk-stellar/` is the only active code in this repo — earlier
prototype directories (an EVM/Arc implementation, an unstructured Soroban
draft) are no longer present.

---

## Contract Architecture

### `market-core`

One instance holds every market, keyed by `market_id`. Pricing is a
Gnosis-style constant-product FPMM — no floating point, no on-chain
square root; selling an exact share count is done by inverting the curve
off-chain (`model/fpmm_model.py` / `agents/core/fpmm.ts`) and calling
`sell` with the resulting collateral amount plus a slippage bound.

| Function | Caller | Purpose |
|---|---|---|
| `create_market(...)` | Anyone | Seeds a market; caller becomes the sole LP; commits to `resolution_hash` |
| `buy` / `sell` | Any trader | Trade while the market is open |
| `resolve` / `void_market` | Resolver only | Finalize a market after close |
| `redeem` | Position holder | Claim a final position's payout |
| `claim_pool_remainder` | Creator | Withdraw the LP's remaining pool after finality |
| `sweep_fees` | Anyone | Moves accrued trading fees to the treasury |
| `get_price` / `quote_buy` / `quote_sell` | Anyone | Read-only pricing views |
| `set_paused` / `set_default_fee_bps` / `set_resolver` / `set_treasury` | Admin only | Config |

**Solvency invariant** (contract-tested): token balance for a market equals
`sets_minted + fees_accrued`; `reserve_yes + Σ(user yes positions) ==
sets_minted` (symmetrically for `no`).

### `resolver`

| Function | Caller | Purpose |
|---|---|---|
| `register_price_spec` / `register_signer_spec` | Anyone | Reveals a resolution rule; accepted only if it hashes to the market's commitment |
| `resolve_price` | Anyone | Resolves via a Reflector feed once the market is closed |
| `attest` | A configured signer | Votes on an outcome (Attested mode) |
| `finalize_signers` | Anyone | Finalizes once threshold + dispute window have passed |
| `cancel_proposal` / `guardian_void_market` | Admin (guardian) only | Edge-case recourse during a dispute |

Spec registration has **no caller restriction** — the cryptographic
commitment is the only gate. See
[ADR 0001](oracledesk-stellar/docs/adr/0001-resolution-commitment.md).

### `treasury`

| Function | Caller | Purpose |
|---|---|---|
| `agent_create_market` / `agent_buy` / `agent_sell` | Agent only | The only path that moves treasury capital; checks caps, then calls market-core itself |
| `redeem` / `claim_pool_remainder` | Agent only | Recover the treasury's own positions after resolution |
| `deposit` | Anyone | Add USDC to the treasury |
| `withdraw` | Admin only | Remove USDC |
| `collect_market_fees` | Admin only | Pulls accrued fees from market-core |
| `set_paused` | Admin only | Kill switch for agent trading |
| `available_capital` / `daily_usage` / `get_config` | Anyone | Read-only views |

Because the treasury calls market-core's `buy`/`create_market` on its own
behalf, the nested SEP-41 transfer market-core makes (`token.transfer(
treasury -> market-core)`) needs the treasury to pre-authorize it via
`authorize_as_current_contract` — a real pitfall, verified with a test
proven to fail without the fix and pass with it. See
[ADR 0002](oracledesk-stellar/docs/adr/0002-cross-contract-calls.md).

### `reasoning-registry`

| Function | Caller | Purpose |
|---|---|---|
| `register_agent` / `unregister_agent` | Admin only | Maintains the allow-list of agents that can publish traces |
| `publish_trace` | A registered agent | Records `{market_id, action, trace_hash, cid}`, returns a `trace_id` |
| `get_trace` / `verify_trace` | Anyone | Read a trace / check a candidate hash against it |
| `market_trace_count` / `market_trace_at` | Anyone | Bounded per-market trace index (no unbounded storage growth) |

---

## Deployed Contract Addresses

### Stellar Testnet

Current live deployment — see
[`oracledesk-stellar/deployments/testnet.json`](oracledesk-stellar/deployments/testnet.json)
for the source of truth (`scripts/deploy-testnet.sh` is idempotent and may
redeploy fresh addresses at any time).

| Contract | Address | Explorer |
|---|---|---|
| market-core | `CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O` | [View](https://stellar.expert/explorer/testnet/contract/CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O) |
| resolver | `CDDJU3PH6T3Z4O6EYLALXXB5XBFPYO2G5P5RBDEIZ7ZVN6V37OQSVYGR` | [View](https://stellar.expert/explorer/testnet/contract/CDDJU3PH6T3Z4O6EYLALXXB5XBFPYO2G5P5RBDEIZ7ZVN6V37OQSVYGR) |
| treasury | `CBTFA3EPQ63PL5XXHOMU4LRDCAB2MHKOLEPDQI7E7TNK454YNBOMZLYB` | [View](https://stellar.expert/explorer/testnet/contract/CBTFA3EPQ63PL5XXHOMU4LRDCAB2MHKOLEPDQI7E7TNK454YNBOMZLYB) |
| reasoning-registry | `CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M` | [View](https://stellar.expert/explorer/testnet/contract/CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M) |
| USDC (self-issued test asset) | `CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH` | [View](https://stellar.expert/explorer/testnet/contract/CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH) |

The USDC above is a **self-issued testnet asset** (a real SEP-41 Stellar
Asset Contract, 7 decimals) — not Circle's testnet USDC. No real USDC
issuer address is hardcoded anywhere in this repo; see
[`docs/STATUS.md`](oracledesk-stellar/docs/STATUS.md) for why.

---

## Setup

### Prerequisites

- Rust (stable) with the `wasm32v1-none` target
- The [Stellar CLI](https://developers.stellar.org/docs/tools/cli) (`stellar`), v27+
- Node.js 20+ and npm
- Python 3.10+
- `jq`

### Install and build

```bash
cd oracledesk-stellar
make setup   # npm install in x402/, agents/, packages/bindings/*
make build   # cargo build + stellar contract build for all 4 contracts
```

---

## Build and Test

```bash
cd oracledesk-stellar
make lint    # cargo fmt --check + clippy -D warnings
make test    # cargo test (40 tests), model/fpmm_model.py, x402 + agents test suites
```

| Suite | Tests | What it covers |
|---|---|---|
| `cargo test --workspace` | 40 | All four contracts: state transitions, wrong-caller auth-failure tests for every privileged function, the resolution-commitment hash check, the treasury cross-contract auth pitfall |
| `model/fpmm_model.py` | property tests | FPMM math, ported line-for-line from `math.rs` |
| `x402` (Node) | 5 | IPFS hash verification, registry-backed trace repository |
| `agents` (Node) | 24 | FPMM math (BigInt), trace canonicalization/hashing, strategy decisions, adapter dry-run mode |

---

## Deployment

```bash
cd oracledesk-stellar
make deploy-testnet   # idempotent: generates/funds two throwaway testnet
                       # identities, deploys all 4 contracts + a self-issued
                       # test USDC, wires them together, writes
                       # deployments/testnet.json
make demo             # create -> trade -> resolve -> record trace -> verify
                       # hash, entirely on testnet, with real transaction output
```

Both scripts submit real Stellar testnet transactions using throwaway
identities generated via `stellar keys generate --fund`. Nothing here ever
touches mainnet.

---

## Security Notes

**Enforced on-chain:**
- Treasury per-trade / per-market / daily caps (`treasury.max_trade`,
  `max_market`, `max_daily`) — the only path that spends treasury capital
  checks these before calling market-core.
- A market's resolution rule is committed (`resolution_hash`) before
  trading opens — it cannot be chosen after seeing how the market trades.
- Resolver dispute window (Attested mode) plus guardian cancel/void as
  recourse.
- Wrong-caller rejection on every privileged function, across all four
  contracts (tested with targeted, non-mocked auth — see
  `contracts/*/src/lib.rs`).
- Reasoning tamper detection: `verify_trace` checks a candidate hash
  against the on-chain record; x402 refuses to serve a trace whose fetched
  content doesn't match.

**Private key model:**
- Two throwaway testnet identities (`oracledesk-deployer`,
  `oracledesk-agent`) are generated by `scripts/deploy-testnet.sh`. Neither
  is committed anywhere.
- Live-mode agents (`agents/stellar/adapter.ts`) require an explicit
  `AGENT_SECRET_KEY` — dry-run is the default and never signs or submits.

---

## Architecture Decision Log

**Why constant-product AMM instead of LMSR?**
LMSR (Logarithmic Market Scoring Rule) needs `log`/`exp` in fixed-point
arithmetic — a real source of precision bugs and overflow risk in a
resource-metered Soroban contract. The constant-product FPMM needs only
integer multiplication and division, is natively unit-testable
(`math.rs` has no `Env` dependency at all), and is mirrored line-for-line
in Python and TypeScript for cross-language property testing. LMSR is
tracked as a possible alternative curve — see
`oracledesk-stellar/docs/wave-issues/03-lmsr-alternative-curve.md`.

**Why commit to a resolution rule at market creation?**
Without it, a market's creator could watch how the crowd prices an event
and only then pick (or negotiate) a resolution rule favoring a different
outcome. A hash commitment fixed before trading opens removes that
degree of freedom entirely — see
[ADR 0001](oracledesk-stellar/docs/adr/0001-resolution-commitment.md).

**Why does resolver generate a client from market-core's compiled wasm
instead of depending on its Cargo crate?**
A crate dependency compiles fine natively but breaks the wasm build:
`#[contractimpl]` exports every contract entrypoint as a `#[no_mangle]`
wasm symbol, and two `#[contract]` structs in one compiled wasm collide.
See [ADR 0002](oracledesk-stellar/docs/adr/0002-cross-contract-calls.md).

**Why x402 for reasoning traces?**
At ~$0.01 per read, traditional payment rails don't make sense for casual,
per-trace access. x402's exact-payment scheme integrates as one middleware
line on an Express route, and the trace is only served after its fetched
content is re-hashed and checked against the on-chain record — so a
subscriber never has to trust the API server's word that a trace is
authentic.

---

## Built With

- [Soroban](https://developers.stellar.org/docs/build/smart-contracts/overview) / [soroban-sdk](https://crates.io/crates/soroban-sdk) — Rust smart contracts
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli) — build, deploy, invoke
- [x402](https://x402.org) — HTTP-native micropayments for reasoning traces
- [@stellar/stellar-sdk](https://www.npmjs.com/package/@stellar/stellar-sdk) — TypeScript contract clients and signing
- Python 3 — the FPMM math's cross-language property-testing reference

---

*OracleDesk — ported to Stellar/Soroban.*
