# Testnet migration: generation 1 to generation 2

This runbook migrates the 97b144a-era live contracts to the develop contract suite without redeploying over generation 1.

## Preconditions

- A dry run has been completed against local Stellar/Soroban state.
- The old and new WASM are built and their hashes are recorded.
- `deployments/testnet-migration-plan.json` explicitly lists every market as `resolve`, `void`, or `leave`.
- `MOVE_CAPITAL_AMOUNT` has been reconciled from the snapshot and old treasury balance.
- Real-world operators hold and review the deployer, proposer, canceller, executor, emergency, and agent identities.

## Phases

1. **Freeze and snapshot**: pause the legacy treasury and write `snapshots/gen1-<ledger>.json`.
2. **Settle legacy markets**: use only legacy entrypoints and the reviewed plan. Do not infer resolution or void actions.
3. **Deploy generation 2**: preserve legacy contract IDs under `legacy`, set `schema: 2`, and skip treasury bootstrap funding.
4. **Move capital**: reconcile the legacy treasury, withdraw to the deployer, then deposit into generation 2.
5. **Register agents**: register the agent, maker, and trader identities in the new reasoning registry.
6. **Governance handover**: deploy or reuse the timelock, run `scripts/wire-timelock.sh`, then execute pending admin transfers after the timelock delay.
7. **Publish**: record WASM hashes, source commit, generation, and legacy retirement time in `deployments/testnet.json`.

The migration journal is `deployments/testnet-migration.json`. Completed steps are skipped on rerun. A step is successful only after its postcondition check passes.

## Rollback

- Before generation 2 deployment: unpause the legacy treasury and stop using the reviewed settlement plan if no state-changing step has committed.
- After legacy settlement: generation 1 remains redeemable for third-party positions; do not delete or overwrite its record.
- After generation 2 deployment: keep the legacy IDs under `legacy` and do not route new agents to generation 2 until capital reconciliation passes.
- After timelock handover: retain CLI/admin identities until every two-step transfer is verified with `admin()`.

Never edit the migration journal by hand while a migration is in progress; it is the source of truth for resumability.
