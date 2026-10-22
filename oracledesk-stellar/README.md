# OracleDesk (Stellar)

**Status: testnet only · unaudited · pre-alpha**

OracleDesk is an autonomous prediction-market system: a Market Maker agent
seeds markets from signals it observes, a Trader agent trades mispricings
against a fair-value estimate, and every decision either agent makes is
hashed and recorded on-chain before it acts — so a subscriber can pay about
$0.01 (via [x402](https://x402.org)) to read the exact reasoning behind a
trade and check it against the on-chain hash, rather than trusting the
agent's word for it.

This is the Stellar/Soroban native port of the system originally built for
the Agora Hackathon on Arc + Polygon (Solidity, Polymarket execution, Circle
CCTP/Wallets). None of that Arc-era execution stack is part of this repo —
markets, trading, resolution, the reasoning registry, and the agent treasury
are all native Soroban contracts, collateralized in a SEP-41 USDC token.
Polymarket survives only as an optional, execution-free reference price an
agent's strategy may read (see `agents/core/strategy.ts`).

## Architecture

```mermaid
flowchart TB
    subgraph Agents["agents/ (TypeScript)"]
        MM[Market Maker]
        TR[Trader]
    end

    subgraph Contracts["Soroban contracts"]
        MC[market-core]
        RES[resolver]
        TRE[treasury]
        RR[reasoning-registry]
    end

    USDC[(SEP-41 USDC)]
    X402[x402 trace API]
    Buyer([Trace buyer])

    MM -- agent_create_market --> TRE
    TR -- agent_buy / agent_sell --> TRE
    TRE -- create_market / buy / sell --> MC
    TRE -- pre-authorizes nested transfer --> USDC
    MC <-- resolve / void --> RES
    RES -- reads price / signer votes --> Oracle[Reflector oracle / signers]
    MM -- publish_trace --> RR
    TR -- publish_trace --> RR
    Buyer -- pays ~$0.01 --> X402
    X402 -- verifies hash against --> RR
    X402 -- serves trace JSON --> Buyer
```

Design decisions with real trade-offs are written up in `docs/adr/`:

- [0001: resolution commitment](docs/adr/0001-resolution-commitment.md) — why
  a market commits to its resolution rule at creation, before trading opens.
- [0002: cross-contract calls](docs/adr/0002-cross-contract-calls.md) — why
  `resolver`/`treasury` generate a client from `market-core`'s compiled wasm
  instead of a normal Cargo dependency (the latter breaks the wasm build).

## Prerequisites

- Rust (stable) with the `wasm32v1-none` target — `rust-toolchain.toml`
  pins this for you if you use `rustup`.
- The [Stellar CLI](https://developers.stellar.org/docs/tools/cli) (`stellar`), v27+.
- Node.js 22+ and npm.
- Python 3.10+ (for `model/fpmm_model.py`'s property tests).
- `jq` (used by the deploy/seed scripts).

## Quickstart

```bash
make setup          # npm install in x402/, agents/, packages/bindings/*
make build           # cargo build + stellar contract build for all 4 contracts
make test            # cargo test, model/fpmm_model.py, x402 tests
make lint            # cargo fmt --check + clippy -D warnings
make deploy-testnet   # idempotent: generates/funds testnet identities,
                      # deploys all 4 contracts + a self-issued test USDC,
                      # wires them together, writes deployments/testnet.json
make demo            # create -> trade -> resolve -> record trace -> verify hash,
                      # entirely on testnet, with real transaction output
make e2e-local       # hermetic quickstart run: deploy, both resolution modes,
                      # live trader, x402 trace fetch (Docker required)
make model-test      # Python stateful model selftest + proptest-vs-wasm harness
```

`make deploy-testnet` and `make demo` submit real Stellar testnet
transactions using two throwaway identities (`oracledesk-deployer`,
`oracledesk-agent`) that `scripts/deploy-testnet.sh` generates and funds via
`stellar keys generate --fund`. Nothing here ever touches mainnet.

### Local end-to-end harness

`NETWORK=local` is a first-class target for the deploy, seed and demo scripts.
`scripts/e2e-local.sh` starts the Stellar quickstart container, registers the
`local` network, deploys the contracts plus the local-only
`contracts/test-oracle`, and then verifies:

1. signer-mode resolution through the resolver;
2. price-mode resolution through the deployed test oracle;
3. a live TypeScript trader opening a position through the treasury;
4. an x402 registry lookup whose trace hash is verified on-chain.

It is hermetic and never talks to testnet or mainnet. Deployment records are
kept per network (`deployments/testnet.json`, `deployments/local.json`), so a
local run cannot clobber testnet addresses. The local agent environment can be
selected with `DEPLOYMENTS_PATH=deployments/local.json`.

The fake oracle is deliberately absent from the testnet deploy path; do not
pass it to a production deployment.

## Treasury migration

The treasury has no upgrade path or config setters — fixing a bug, changing
caps, or rotating the agent means deploying a **new** treasury. Deploying
one strands nothing: the old treasury's positions and LP ownership can be
handed to a successor market by market:

```bash
make build                        # treasury wasm must be current
scripts/migrate-treasury.sh      # deploys a successor + migrates every market
```

The script reads `deployments/testnet.json` and the old treasury's live
config, deploys a new treasury with the same agent/collateral/caps, records
it as the old treasury's successor (`set_successor`, admin), then calls
`migrate_market(i)` for every `i` in `0..market_count`. Both steps are
admin-gated — the agent cannot invoke them — and the destination is fixed
to the recorded successor, so migration cannot send value anywhere else.
Re-running is safe. It deliberately does **not** rewire market-core
(`propose_treasury` + the treasury's `accept_market_core_role`); that cutover
changes the fee recipient for future markets
and stays a separate operator step (the script prints the exact commands).
See `docs/architecture.md` for the full auth model.

## Repository layout

```
contracts/            market-core, resolver, treasury, reasoning-registry,
                      test-oracle (local E2E only), integration-tests
model/fpmm_model.py   Python mirror of the FPMM math, property-tested
model/system_model.py stateful four-contract model, replayed against wasm
x402/                 the paid trace API (Express + @x402/*)
agents/               core/ (chain-agnostic strategy + trace building),
                      stellar/ (signing/submission adapter), bin/ (CLIs)
packages/bindings/    generated TypeScript contract clients
scripts/              deploy-testnet.sh (NETWORK=testnet|local),
                      migrate-treasury.sh, seed-market.sh, demo.sh,
                      e2e-local.sh, gen-bindings.sh, spec-hash/
deployments/          testnet.json — the current live testnet addresses
docs/                 architecture, ADRs, frontend-integration, STATUS
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, branch/commit
conventions, and how issues are scoped. Issues seeded for the
[Drips Stellar Wave Program](https://drips.network) live as files in
`docs/wave-issues/` before they're filed.

## Status

`docs/STATUS.md` is the honest, current account of what's verified, what's
unverified, and what's left — read it before assuming any given piece works
end to end.

## License

[MIT](LICENSE)
