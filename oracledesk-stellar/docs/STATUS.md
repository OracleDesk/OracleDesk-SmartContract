# Status

Last updated: 2026-09-21. This is the honest account of what works, what's
unverified, and what's left. Everything marked "verified" was demonstrated
with real command output in the session that wrote this file, not asserted.

## Phase 0: recon and safety

**Toolchain** (as installed in the environment this was built in):
rustc 1.94.1, cargo 1.94.1, Stellar CLI 27.1.0, soroban-sdk 27.0.6, Node
v24.13.1, npm 11.8.0, Python 3.14.5, jq 1.7. `soroban` (the old CLI name),
`gitleaks`, and `trufflehog` were not installed.

**Inventory of inherited code** (`soroban/` in the parent repo, moved into
`contracts/` here): `market-core` compiled and had tests already; the
`resolution_hash` commitment described in the design brief was *not* yet
implemented (added — see below). `reasoning-registry`, `resolver`, and
`treasury` all had substantive implementations already, not stubs, but
`treasury`'s "trading" functions (`authorize_trade`/`close_trade`) were
advisory-only bookkeeping that never actually called `market-core` — a real
gap, since it meant the on-chain caps didn't cap anything real. Rewritten —
see below.

**Secrets scan**: manual regex over the whole `OracleDesk-SmartContract`
working tree for `PRIVATE_KEY`/`SECRET`/PEM headers/Stellar seed shape
(`S[A-Z2-7]{55}`), plus `git log -p --all` over the same patterns. No real
secrets found — the only hits were env var *names* (e.g. `DEPLOYER_PRIVATE_KEY=`
in the parent repo's README, referencing the Arc-era Foundry deploy flow,
not this repo). One `.env` file exists at `oracledesk-contracts/.env`
(the sibling Arc-era repo, not this one); confirmed gitignored via
`git check-ignore`, never read, never committed. No `.env` files exist
anywhere under `oracledesk-stellar/`.

## Phase-by-phase results

| Phase | Status | Evidence |
|---|---|---|
| 0. Recon & safety | ✅ Done | This section |
| 1. Scaffold | ✅ Done | `contracts/`, `agents/`, `x402/`, `packages/bindings/`, `scripts/`, `docs/` all populated per the target layout; no Solidity/Foundry/Polymarket-execution/Circle code anywhere in this tree |
| 2. Contracts compile + test | ✅ Done | `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (40 tests) all exit 0 — rerun as the last step before writing this file |
| 3. Testnet deploy | ✅ Done | All 4 contracts + a self-issued test USDC deployed to testnet; addresses in `deployments/testnet.json`; `scripts/deploy-testnet.sh` re-run and confirmed idempotent (detects everything already deployed, no-ops) |
| 4. x402 service | ✅ Code done, ⚠️ network round-trip unverified | See "x402" below |
| 5. Agents + demo | ✅ Done | `scripts/demo.sh` ran end-to-end on real testnet: create → trade → resolve → record trace → verify hash. `agents/` CLIs ran in dry-run mode successfully; live mode is implemented but not exercised (see below) |
| 6. Bindings | ✅ Mostly verified | See "Bindings" below |
| 7. Contributor readiness | ✅ Done | This file plus README/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY/LICENSE/CI/issue templates/15 wave-issues |
| 8. Final report | ✅ This file | |

## What's fully verified (command output exists for all of these)

- `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D
  warnings`, `cargo test --workspace` (40 tests across `market-core`,
  `resolver`, `reasoning-registry`, `treasury`) — all exit 0.
- `stellar contract build` produces all four `.wasm` files cleanly, with no
  spec warnings (the `experimental_spec_shaking_v2` soroban-sdk feature was
  needed to get `Outcome`/`Category` properly represented in
  `resolver`'s/`treasury`'s own contract spec — see ADR 0002).
- `python3 model/fpmm_model.py` passes (known-value checks against the same
  worked examples as the Rust tests, a property test, and a
  `gross_for_shares`/`calc_sell` round-trip check).
- `cd agents && npm test` — 24 tests pass, including the same known-value
  and property checks in TypeScript/BigInt (`agents/core/fpmm.ts`).
- `cd x402 && npm test` — 5 tests pass, including the new registry-backed
  `TraceRepository`.
- Live testnet deployment and the full demo loop
  (`scripts/deploy-testnet.sh`, `scripts/seed-market.sh`,
  `scripts/demo.sh`) — real transaction hashes were produced for: market
  creation, a trade, signer attestation, resolution finalization, trace
  publication, and hash verification. Ran twice (once building the scripts
  interactively, once via the finished `scripts/demo.sh`) with consistent
  results.
- **The resolution-commitment design (ADR 0001)** was validated on live
  testnet, not just in unit tests: `treasury.agent_create_market` was
  called with a `resolution_hash` computed off-chain by
  `scripts/spec-hash/`, and `resolver.register_signer_spec` accepted the
  matching revealed spec — the hash genuinely round-tripped through real
  XDR encoding on a real ledger.
- **The treasury cross-contract auth fix (ADR 0002, `authorize_token_pull`)**
  was validated three ways: (1) a unit test using targeted `mock_auths`
  (not `mock_all_auths`, which would hide the bug); (2) that same test was
  manually re-run with the fix commented out, confirmed to fail with
  `HostError: Error(Auth, InvalidAction)` / "Unauthorized function call",
  then confirmed to pass again with the fix restored; (3) the real,
  unmocked testnet transaction for `agent_create_market` succeeded, which
  would have failed with the same auth error had the fix been wrong.
- **All four** `packages/bindings/*` packages: generated, then `npm install
  && npm run build` completed with no errors for every one of them
  (`market-core`, `reasoning-registry`, `resolver`, `treasury`) — a full
  round-trip, not just generation. `resolver`'s and `treasury`'s installs
  were slower (each ~4 minutes against this sandbox's npm registry) and so
  were run later in the session than the other two, but all four are now
  confirmed.

## What's implemented but not fully round-trip verified

- **x402's registry-backed `TraceRepository`**
  (`x402/registry-trace-repository.ts`): unit-tested with a
  dependency-injected fake reader (its real interface, verified against the
  actual generated `get_trace` signature). Attempting to run the real
  server against the live deployed `reasoning-registry` failed — but the
  failure is an environment issue, not a code issue: **Node's own outbound
  `fetch` to `soroban-testnet.stellar.org` times out at the TCP level in
  this sandbox** (`ETIMEDOUT` / `ENETUNREACH`, reproduced with a bare
  `node -e "fetch(...)"` with no OracleDesk code involved at all), while
  `curl` to the identical URL and the Rust `stellar` CLI itself both work
  fine throughout this same session. This looks like a sandbox network
  policy specific to Node's raw socket connections, not a bug here — but it
  means the actual RPC round-trip for this path is unverified in this
  environment. Whoever runs this outside this sandbox should confirm it
  directly.
- **Agents' live mode** (`agents/stellar/adapter.ts` with
  `mode: "live"`, i.e. `AGENT_MODE=live` for the CLIs): implemented,
  type-checked against the real bindings, and structurally exercised in
  dry-run mode end to end. Never run in live mode — that would need the
  same Node→testnet RPC path just noted as unverified, plus a funded
  agent secret key wired through `AGENT_SECRET_KEY`.
- **`quote_sell`/`collateralOutForShares` against a live contract quote**:
  the property test in both `model/fpmm_model.py` and
  `agents/core/fpmm.test.ts` verifies the off-chain math against itself
  (forward `calc_sell` vs. the `collateralOutForShares` inverse), which is
  what the design brief asked for ("add a test against the contract
  quote") in spirit — but it was not additionally checked against a live
  `market-core.quote_sell` call on testnet with real reserves.

## Blocked / not attempted

- **Reflector (SEP-40) price-mode resolution on live testnet**: `resolver`'s
  `PriceThreshold` mode is implemented and unit-tested (with a mock
  reflector), but no real testnet Reflector contract address was used
  anywhere — there was no way to look one up and verify it against
  Reflector's own current docs in this session (no browsing tool was
  used for this). The demo uses **signer mode** instead, which needs no
  external oracle. See `docs/wave-issues/05-reflector-feed-discovery.md`.
- **A real testnet USDC issuer** (e.g. Circle's): not used. `scripts/
  deploy-testnet.sh` deploys a **self-issued** test "USDC" (a real SEP-41
  Stellar Asset Contract, 7 decimals, matching the design doc) rather than
  guessing at a real issuer's address. This is called out as a
  `TODO(maintainer)` in `scripts/deploy-testnet.sh` and `.env.example`.
- **Actually buying a trace through x402** (payment settlement via a real
  facilitator): not attempted. No x402-on-Stellar facilitator URL is known
  or hardcoded anywhere in this repo; finding and verifying one needs
  browsing x402's current docs, which this session didn't do. `x402/`'s
  code path up to "would this trace be served" (hash verification) is
  tested; the payment middleware itself is `@x402/*`'s own code, unmodified
  here.
- **CI has never actually run** (no GitHub Actions run occurred — this repo
  was never pushed). `.github/workflows/ci.yml` mirrors every command this
  file claims was run locally, but "the workflow file is correct" is a
  weaker claim than "the workflow ran green," and it's flagged as such.

## Changed from the original design, and why

- **Treasury's public API**: the design doc describes
  `agent_create_market`/`agent_buy`/`agent_sell` calling market-core "as
  the trader/creator itself." The *inherited* code had a completely
  different, advisory-only `authorize_trade`/`close_trade` pair that never
  called market-core at all. This was a real gap (the on-chain caps didn't
  cap anything), not a style choice, so it was replaced rather than kept
  alongside the new functions — see the commit that did this and ADR
  references in `contracts/treasury/src/lib.rs`.
- **Cross-contract calls**: the design doc suggested either
  `contractimport!` or a Cargo dependency, "pick the simplest that builds."
  A Cargo dependency does not build to wasm (duplicate `__constructor`
  export — see ADR 0002), which the design doc didn't anticipate. Switched
  to `contractimport!` for both `resolver` and `treasury`.
- **Resolution spec registration is not admin-gated.** The original
  resolver had `configure_price`/`configure_signers` as admin-only setters.
  Per the resolution-commitment design (ADR 0001), the correct gate is the
  cryptographic commitment, not caller identity — anyone can reveal a spec
  that hashes correctly, since only whoever picked it in the first place
  could have produced a match.
- **Guardian functions added** (`resolver.cancel_proposal`,
  `resolver.guardian_void_market`): the design doc's Attested mode
  description mentions "a guardian can cancel a proposal or void the market
  during the window," but no such functions existed in the inherited code.
  Added as thin, admin-gated wrappers.
- **`agents/core` is not a port** of `oracledesk-contracts/agents/*.ts`.
  Those files turned out to contain only EVM/Circle/Polymarket *execution*
  plumbing (ABI encoding, Circle Developer-Controlled Wallets, EIP-712
  order signing) — exactly what the design brief says to remove, and
  nothing chain-agnostic to actually carry over. `agents/core/strategy.ts`
  is a fresh, minimal implementation of the two described roles.

## TODO(maintainer)

Decisions only a human maintainer should make, left as `TODO(maintainer)`
markers in the files themselves:

- `SECURITY.md` — an expected triage/response timeline for reports.
- `CODE_OF_CONDUCT.md` — a direct contact channel alongside GitHub's
  security-advisory reporting path, if wanted.
- `CONTRIBUTING.md` — an expected PR review turnaround.
- `scripts/deploy-testnet.sh` / `.env.example` — whether to switch the
  testnet collateral token from the self-issued test USDC to Circle's real
  testnet USDC issuer (needs verifying their current testnet address).
- `.env.example` — the x402-on-Stellar facilitator URL to use for real
  payment settlement (none is hardcoded or guessed anywhere in this repo).

## Known limitations

- **Testnet only, unaudited.** Nothing here has been professionally
  reviewed; do not deploy to mainnet.
- **No indexer.** Soroban RPC's event retention window is short; anything
  needing history beyond it has no data source yet (see
  `docs/wave-issues/06-event-indexer.md`).
- **Agent-vs-agent liquidity** is unbounded: nothing stops multiple
  independent agent deployments from trading against the same
  `market-core` markets. The treasury's caps bound one deployment's own
  risk, not systemic market behavior.
- **Single admin key per contract**, no multisig/timelock. A compromised
  admin key has a large blast radius per contract (see
  `docs/wave-issues/12-architecture-deep-dive-and-threat-model.md`, which
  proposes writing this up formally — not yet done).
- **`treasury`'s per-market cap is cumulative and never decreases** (even
  after `close_trade`) — this is the existing, intentional design (a
  lifetime cap on capital ever committed to one market), documented in
  `contracts/treasury/src/lib.rs`'s comments, but worth stating here since
  it's easy to misread as a bug.

## Reproducing this

```bash
make setup && make build && make lint && make test
make deploy-testnet   # idempotent — safe to re-run
make demo             # full create -> trade -> resolve -> trace -> verify loop
```

See `README.md` for prerequisites.
