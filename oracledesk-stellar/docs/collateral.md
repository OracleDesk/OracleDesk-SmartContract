# Collateral Configuration & Circle Testnet USDC

OracleDesk contracts (`market-core` and `treasury`) accept any SEP-41 token with **7 decimals** as their collateral asset. Because collateral is immutable in both contracts' constructors, choosing or switching collateral happens at deployment time in `scripts/deploy-testnet.sh`.

## Modes

| `COLLATERAL_MODE` | Behavior | Default `TREASURY_FUND_AMOUNT` |
|---|---|---|
| `self-issued` *(default)* | Deploys a self-issued testnet `USDC:<deployer>` SAC and funds the treasury via `mint` + `deposit`. Self-contained for demos and CI. | `10000000000000` (1,000,000 USDC) |
| `existing` | Uses an existing classic Stellar asset's SAC (`COLLATERAL_ASSET=CODE:ISSUER`), verifies `decimals == 7`, checks issuer flags, creates G-account trustlines, and funds the treasury strictly via `deposit` from a faucet-funded deployer account. | `5000000000` (500 USDC) |

## Official Circle Testnet USDC Citation

- **Asset code:** `USDC`
- **Testnet issuer:** `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **Official source:** Circle Developers — *USDC on test networks* (`https://developers.circle.com/stablecoins/usdc-on-test-networks`)
- **Testnet faucet:** `https://faucet.circle.com/`
- **Verified on:** `2026-11-19`

`COLLATERAL_MODE` defaults to `self-issued` so local demos and tests remain self-contained. To deploy against Circle's testnet USDC:

```bash
cd oracledesk-stellar
COLLATERAL_MODE=existing \
COLLATERAL_ASSET=USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  ./scripts/deploy-testnet.sh
```

## Pre-Deploy Verification

1. **Format check:** `COLLATERAL_ASSET` must match `CODE:ISSUER` where `CODE` is 1–12 ASCII alphanumerics and `ISSUER` is a 56-character `G...` Stellar public key.
2. **SAC resolution:** Computes the deterministic SAC ID with `stellar contract id asset --asset "$COLLATERAL_ASSET" --network "$NETWORK"`. If the SAC is not yet deployed on testnet, deploys it via `stellar contract asset deploy` (permissionless for any classic asset).
3. **Decimals check:** Calls `decimals()`, `name()`, and `symbol()` on the SAC and **aborts unless `decimals == 7`**, because `market-core` hardcodes `MIN_SEED = 100 * 10_000_000` and `math::MAX_SETS = 1_000_000_000_000_000` assuming 7 decimal places.
4. **Deployment record:** Persists `.collateral = { mode, asset, contract_id, decimals, name, symbol, issuer_flags }` in `deployments/<network>.json`.

## Issuer Flags & Clawback Semantics

Before deploying, `deploy-testnet.sh` queries Horizon (`GET /accounts/<issuer>`) for the issuer's classic account flags:

- **`auth_required = true`:** Deployment **aborts**. Every holder would need explicit issuer authorization before holding or transferring collateral, which breaks permissionless trading and cannot be satisfied by automated test identities.
- **`auth_revocable = true` or `auth_clawback_enabled = true`:** Deployment prints a **warning** and records the flags under `.collateral.issuer_flags`.
  - **SAC risk:** Under Stellar Asset Contract (CAP-46-6) semantics, classic issuer authorization revocation and clawback also apply to balances held by Soroban contracts (`C...` addresses). If an issuer freezes or claws back collateral held by `market-core`, the solvency invariant (`balance == sets_minted + fees_accrued`) can break and redemptions can fail. Treat issuer-controlled clawback/revocation as an explicit collateral trust risk.

## Classic Trustlines & Faucet Funding

- **G-accounts only:** `oracledesk-deployer` and `oracledesk-agent` are classic `G...` accounts and must hold a trustline to `COLLATERAL_ASSET` before receiving faucet funds or calling `treasury.deposit`. `deploy-testnet.sh` checks Horizon `/accounts/<addr>` and idempotently submits `stellar tx new change-trust` only when missing.
- **Contract addresses (`C...`):** `market-core` and `treasury` hold SAC balances directly without classic trustlines; the script never attempts `change-trust` on contract IDs.
- **No mint authority:** In `existing` mode the deployer cannot call `mint`. If the deployer's balance is below the remaining `TREASURY_FUND_AMOUNT` delta, the script deploys and wires all contracts, prints faucet instructions (faucet URL + deployer address + required stroops), and exits with **code `3`** (*action required*). After funding via `https://faucet.circle.com/`, re-run the script to complete `treasury.deposit`.
- **Caps guidance:** When funding from a faucet (for example 500 USDC), keep `MAX_TRADE`, `MAX_MARKET`, `MAX_DAILY`, and `SEED_AMOUNT` (>= `1000000000` / 100 USDC `MIN_SEED`) within your funded balance.

## Switching Collateral on an Existing Deployment

Collateral is immutable in `market-core` and `treasury`. If `deployments/<network>.json` already records a different collateral contract ID, `deploy-testnet.sh` refuses to continue unless `FORCE_REDEPLOY=1` is set (which clears `market_core`, `treasury`, `resolver`, wiring, and funding totals so the contracts redeploy cleanly against the new collateral).

## Relationship to x402 Settlement

`x402/server.ts` settles trace payments via `@x402/stellar`'s `ExactStellarScheme` using the network's configured USDC asset. Aligning `COLLATERAL_MODE=existing` with Circle's testnet USDC lets a single faucet-funded testnet wallet both trade on OracleDesk and pay for x402 traces, while keeping x402 settlement configuration independent of `deploy-testnet.sh`.
