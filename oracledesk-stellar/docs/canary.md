# Scheduled Testnet Canary & Reset Recovery Runbook

`.github/workflows/testnet-canary.yml` runs every 6 hours (and on demand via `workflow_dispatch`) to detect Stellar testnet resets, contract wiring drift, RPC degradation, and end-to-end functional regressions.

## Secrets & Identities

| Secret | Scope | Purpose |
| --- | --- | --- |
| `TESTNET_CANARY_SECRET` | Repository secret (canary job) | Dedicated `oracledesk-canary` testnet keypair — never the deployer or agent key. |
| `TESTNET_DEPLOYER_SECRET` | `testnet-deploy` environment (required reviewers) | Used only during manually approved redeploy runs. |
| `TESTNET_AGENT_SECRET` | `testnet-deploy` environment (required reviewers) | Used only during manually approved redeploy runs. |

## One-Time Canary Setup

```bash
# 1. Create and friendbot-fund the dedicated canary identity
stellar keys generate oracledesk-canary --network testnet --fund
CANARY_PUB="$(stellar keys address oracledesk-canary)"

# 2. Mint 300 test USDC float from the deployer
USDC="$(jq -r '.contracts.usdc' oracledesk-stellar/deployments/testnet.json)"
stellar contract invoke --id "$USDC" --source-account oracledesk-deployer --network testnet -- \
  mint --to "$CANARY_PUB" --amount 3000000000

# 3. Register canary on reasoning-registry
REGISTRY="$(jq -r '.contracts.reasoning_registry' oracledesk-stellar/deployments/testnet.json)"
stellar contract invoke --id "$REGISTRY" --source-account oracledesk-deployer --network testnet -- \
  register_agent --agent "$CANARY_PUB"
```

Store the secret key (`stellar keys show oracledesk-canary`) in the GitHub Actions secret `TESTNET_CANARY_SECRET` and never commit it.

## Failure Classes & Deduplicated Issues

- **`reset`**: All five contracts and the deployer account are missing, or RPC `latestLedger` regressed below the last seen ledger. Short-circuits the cycle and opens/updates `Testnet canary: reset`.
- **`drift`**: Partial contract loss, archival, wiring mismatch (`market-core`/`treasury`/`reasoning-registry`), or treasury capital below threshold. Opens/updates `Testnet canary: drift`.
- **`degraded`**: RPC error or timeout. Requires **two consecutive failures** before filing `Testnet canary: degraded` to avoid alert noise from transient RPC blips.
- **`functional`**: Existence and wiring passed, but the end-to-end market/trade/resolve/redeem/trace cycle or balance-delta bound failed. Opens/updates `Testnet canary: functional`.

Every open canary issue is closed automatically on the next green run.

## Reset Recovery Procedure

1. Dispatch `.github/workflows/testnet-canary.yml` with `redeploy: true`.
2. Approve the `testnet-deploy` environment gate.
3. Review and merge the generated PR into `develop` (which updates `oracledesk-stellar/deployments/testnet.json` and regenerates the root `README.md` table via `scripts/render-addresses.mjs --write`).
4. Run the one-time canary funding/registration commands above against the fresh deployment.
5. Sync the updated testnet addresses into `OracleDesk-Backend` and `OracleDesk-Frontend`.
