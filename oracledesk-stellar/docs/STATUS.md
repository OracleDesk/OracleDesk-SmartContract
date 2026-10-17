# Status

Last updated: 2026-09-21 (contributor addenda 2026-10-16 and 2026-10-17 —
see the first section after this intro). This is the honest account of what
works, what's unverified, and what's left. Everything marked "verified" was
demonstrated with real command output in the session that wrote this file,
not asserted.

## Contributor addendum: 2026-10-16

Fee split + recipient snapshot (#8), per-market circuit breakers (#10),
trade deadlines and limit prices (#12), and transferable positions/LP plus
treasury migration (#13) are implemented on
`feat/fees-breakers-bounds-and-transfers` (PR against `develop`; design
notes in `docs/architecture.md`). Verified in the contributor session:
`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`
and `cargo test --workspace` (now **87** tests: market-core 54, resolver 6,
reasoning-registry 6, treasury 21 — superseding the 40-test count below),
`python3 model/fpmm_model.py`, agents (36 tests) and x402 (5 tests) with the
regenerated bindings, `make build` and `make bindings` with only the
intended diffs. **Not** (re)verified: no testnet redeploy — the deployed
contracts and `deployments/testnet.json` predate these changes, so the new
entrypoints have contract-level and off-chain tests only, not a real-ledger
transaction.

### Merge follow-up: 2026-10-17

The work above landed on `develop` as merge commit `581a3ec` (PR #153,
merged 2026-10-16), so the feature-branch reference above is historical and
`develop` is the source of truth for #8, #10, #12 and #13.

## Contributor addendum: 2026-10-18

Signer-key rotation via committee registry (#35), hybrid price feed with attested
fallback (#36), attestation evidence linking to reasoning-registry (#34), and
constrained guardian powers with time windows and audit logs (#33) are implemented
on `feat/resolver-committee-hybrid-evidence-guardian`.
Key additions:
- Resolver contract: `create_committee`, `propose_rotation`, `execute_rotation`,
  `cancel_rotation`, `register_committee_spec`, `register_hybrid_spec`, `open_fallback`,
  `attest_with_evidence`, `set_evidence_config`, and constrained `cancel_proposal`
  and `guardian_void_market` with `GuardianReason`.
- Spec-hash CLI: Added `committee` and `hybrid` spec hashing commands.
- Reasoning registry wasm vendored into `contracts/resolver/reasoning_registry.wasm`
## Contributor addendum: 2026-10-19

Permissionless treasury settlement (#45), realized PnL tracking and auto-pause on drawdown (#46),
market-creation risk controls (#47), and Blend lending integration with JIT liquidity (#48)
are implemented on `feat/issues-45-46-47-48`.
Key additions:
- **Permissionless settlement (#45)**: `settle_market(caller, market_id)` allows anyone to settle resolved markets, recovering positions and LP remainders without hot agent keys. Graceful error handling for `market_core` errors (`NothingToRedeem`, `AlreadyClaimed`, `NotFinal`). Emits `MarketSettled`.
- **Realized PnL & Drawdown Guard (#46)**: Full ledger tracking of cost and proceeds (`MarketPnl`), daily rolling window (`window_pnl`), and automatic `DrawdownPause` when losses exceed `max_drawdown`. Protects open positions by allowing reduce-only `agent_sell` in drawdown mode. Requires admin acknowledgement to resume.
- **Creation Policy (#47)**: `CreationPolicy` bounding `max_seed` independently of `max_trade`, rolling window creation rate limits, horizon constraints (`min_close_horizon`, `max_close_horizon`), and allowed categories bitmask. Tighten-only admin configuration updates.
- **Blend Lending & JIT Liquidity (#48)**: Idle capital deployment to Blend pool, atomic shortfall withdrawal in `agent_buy` and `agent_create_market` via `ensure_liquid`, fail-closed error handling with `YieldWithdrawFailed`, and comprehensive capital views (`available_capital`, `liquid_capital`, `capital_breakdown`). Documented in `docs/adr/0006-blend-integration.md`.

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
- **Expiry cannot help an oracle the creator controls.** `expire_market`
  voids unresolvable markets 30 days after close, but a creator who commits
  to a feed they control can still decide the outcome of a *resolvable*
  price market; the commitment does not bind oracle identity (ADR 0001,
  "Liveness fallback").
- **Single admin key per contract**, no multisig. A compromised admin key
  has a large blast radius per contract (see
  `docs/wave-issues/12-architecture-deep-dive-and-threat-model.md`, which
  proposes writing this up formally — not yet done). The treasury's
  config, price policy and agent registry are timelocked (loosening waits
  `config_delay`, tightening is immediate), which bounds what a compromised
  admin can unlock for the *agents*; it does not cover `set_paused`,
  `set_successor` + `migrate_market` (which moves positions out of the
  vault), or any other contract's admin.
- **Treasury vault NAV is conservative, not mark-to-market.** Directional
  exposure in open markets counts as zero, so deposits are slightly cheap
  and withdrawals slightly expensive while positions are open; positions
  opened before a lazy migration from the pre-vault layout, or received by
  a successor treasury via `migrate_market`, are not in the open-market
  index and count as zero until redeemed. See
  `docs/adr/0005-treasury-vault.md` for the residual risks (LP floor moved by
  rebalancing trades, fees swept just after a deposit).
- **`treasury`'s per-market cap is cumulative and never decreases** (even
  after `close_trade`) — this is the existing, intentional design (a
  lifetime cap on capital ever committed to one market), documented in
  `contracts/treasury/src/lib.rs`'s comments, but worth stating here since
  it's easy to misread as a bug. The separate **net** cap
  (`max_net_exposure`, see `docs/architecture.md` "Caps") is what bounds
  capital currently deployed; sells and redemptions free it.
- **Price snapshots must be taken within oracle retention.** `snapshot_price`
  lets resolution outlive the oracle's bounded history, but only if someone
  calls it while the `close_time` record is still retained; there is no
  keeper doing so automatically yet.
- **Emergency modes hinge on admin liveness.** `market-core` now has four
  graduated states (`Normal` / `ReduceOnly` / `SettleOnly` / `Halted`, see
  `docs/architecture.md`) instead of a binary pause, so an incident no
  longer has to freeze exits to stop new risk. But only the single admin key
  can move between them: while the contract sits in `Halted`, redemption is
  blocked until that key acts (the matrix guarantees `Halted → SettleOnly →
  redeem` always works, and `set_mode` itself is never gated). Adding a
  timelock/multisig or an automatic de-escalation timer is
  `docs/wave-issues/12-architecture-deep-dive-and-threat-model.md` territory
  (wave-issue #61/#62), not done here.
- **Two separate emergency mechanisms now exist.** The `OperatingMode`
  ladder above lives in `market-core` and is admin-driven; the treasury-side
  drawdown breaker from #46 (`DrawdownTripped`, `acknowledge_drawdown`,
  `NotAcknowledged`, see the contributor addendum) is automatic and
  PnL-triggered, and gates buys at the treasury layer. They overlap in
  intent ("stop new risk, keep exits") but not in code: a buy can be refused
  by either, and resuming one does not resume the other.

## Reproducing this

```bash
make setup && make build && make lint && make test
make deploy-testnet   # idempotent — safe to re-run
make demo             # full create -> trade -> resolve -> trace -> verify loop
```

See `README.md` for prerequisites.
