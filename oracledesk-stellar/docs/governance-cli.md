# Governance timelock CLI

`scripts/governance/timelock-cli.ts` encodes admin calls from typed JSON,
simulates them as the timelock, schedules them, and keeps reviewable proposal
records. It is the supported replacement for the placeholder `schedule
--args '<scval-json>'` hint in `scripts/deploy-testnet.sh` and for hand-written
`Vec<Val>` JSON.

The timelock executes every target call as `invoke_contract::<()>`. Only calls
that return `void` or `Result<(), E>` can be scheduled; the encoder rejects
others (for example treasury `collect_market_fees`) before any transaction is
built.

## Setup

Build the bindings first (the CLI imports their embedded specs):

```sh
make setup
cd scripts/governance
npm install
npm run build
```

There is no committed `package-lock.json` for this package yet; CI uses
`npm install`, not `npm ci`.

Run all commands from the `oracledesk-stellar/` directory so proposal records
land in `governance/proposals/<network>/`.

Common environment variables (flags override them):

| Variable | Purpose |
| --- | --- |
| `GOVERNANCE_NETWORK` | `testnet` (default) or `local` |
| `GOVERNANCE_RPC` | Soroban RPC URL |
| `GOVERNANCE_PASSPHRASE` | Network passphrase |
| `TIMELOCK` | Timelock contract id |
| `GOVERNANCE_SOURCE` | Funded public key used for read-only simulations |
| `GOVERNANCE_MAX_ARGS_BYTES` | Encoded arg-size limit (default `16384`) |
| `GOVERNANCE_PROPOSER_SECRET` | Signs `schedule` with `--submit` |
| `GOVERNANCE_EXECUTOR_SECRET` | Signs `execute` with `--submit` |
| `GOVERNANCE_CANCELLER_SECRET` | Signs `cancel` with `--submit` |
| `GOVERNANCE_EMERGENCY_SECRET` | Signs `emergency` with `--submit` |

For `--submit`, the role secret's public key is the transaction source. Use
`--xdr-out <file>` instead to write the assembled transaction XDR for an
external signer; no secret is needed in that mode. The external signer must sign
both the envelope and any Soroban authorization entries.

`--offline` skips the local-binding vs on-chain spec comparison. It does not
remove the need for RPC when a subcommand simulates a call. Do not use it for
production proposals unless you have verified the deployed spec another way.

## Intent file

Every call is described by a JSON intent:

```json
{
  "network": "testnet",
  "timelock": "C…TIMELOCK…",
  "target": "C…MARKET_CORE…",
  "contract": "market-core",
  "fn": "set_default_fee_bps",
  "args": { "fee_bps": 200 },
  "title": "Raise default fee to 2%",
  "rationale": "Restores the intended fee after the market-creation incident."
}
```

`contract` is one of `market-core`, `resolver`, `treasury`,
`reasoning-registry`, `timelock`, or `router`. Values are encoded using that
binding's `ContractSpec`; the same function's inputs and outputs on-chain must
match before encoding. 64/128-bit values (`u64`, `i64`, `u128`, `i128`,
`u256`, `i256`, `timepoint`, `duration`) must be decimal strings, never JSON
numbers. Optional fields must be present and explicitly `null`.

## Examples

### market-core `set_default_fee_bps`

```sh
cd scripts/governance
npm run cli -- encode --intent intents/default-fee.json
npm run cli -- simulate --intent intents/default-fee.json
npm run cli -- propose --intent intents/default-fee.json --submit
npm run cli -- status 42
npm run cli -- execute 42 --submit
```

The `encode` output includes `argsXdr`, `argsVecXdr`, a canonical `argsEcho`,
the encoded byte count and the operation hash preview. `simulate` additionally
prints the id that `schedule` would return, `eta`, `expires`, decoded events,
ledger-entry changes, auth addresses and auth-entry XDR. It fails if any
address other than the timelock must authorize the inner call.

### treasury `propose_config(GlobalConfig)`

`i128` fields are decimal strings:

```json
{
  "network": "testnet",
  "timelock": "C…TIMELOCK…",
  "target": "C…TREASURY…",
  "contract": "treasury",
  "fn": "propose_config",
  "args": {
    "config": {
      "collateral": "C…USDC…",
      "market_core": "C…MARKET_CORE…",
      "max_daily": "10000000000",
      "max_market": "5000000000",
      "max_net_exposure": "10000000000",
      "max_trade": "2000000000"
    }
  },
  "title": "Restore treasury caps",
  "rationale": "Return to the reviewed cap set after incident #139."
}
```

### resolver `set_evidence_config`

Enums use `{ "tag": "Name" }` (add `values` for variants that carry data):

```json
{
  "network": "testnet",
  "timelock": "C…TIMELOCK…",
  "target": "C…RESOLVER…",
  "contract": "resolver",
  "fn": "set_evidence_config",
  "args": {
    "registry": "C…REASONING_REGISTRY…",
    "policy": { "tag": "Required" }
  },
  "title": "Require supporting evidence",
  "rationale": "Dispute resolution now depends on registered evidence."
}
```

### timelock self-call `set_default_delay`

Only `set_default_delay` may be scheduled with the timelock itself as target;
all other self-calls are rejected. This is how the delay floor is raised:

```json
{
  "network": "testnet",
  "timelock": "C…TIMELOCK…",
  "target": "C…TIMELOCK…",
  "contract": "timelock",
  "fn": "set_default_delay",
  "args": { "delay": "172800" },
  "title": "Raise default delay to two days",
  "rationale": "Governance decision G-17."
}
```

## Records and status

`propose` writes `governance/proposals/<network>/<draft-id>.json` first, with
`status: "draft"`. With `--submit`, it parses `OperationScheduled` from the
transaction, reads `operation(id)` back, compares its `args` XDR byte-for-byte
with the encoded args, then renames the file to `<id>.json` and stores `eta`,
`expires` and `scheduleTx`.

`status <id>` merges the on-chain operation with
`OperationScheduled/Executed/Cancelled/EmergencyExecuted` events. States are
`pending`, `ready`, `expired`, `executed`, `cancelled`, and `unknown`. An
on-chain operation with no local record is flagged loudly: the canceller must
review it manually because the record has no human-readable intent.

`list` prints all records for the selected network. `execute <id>` refuses
before `eta`, refuses past `expires`, re-simulates the inner call and
`timelock.execute(id)`, and shows any state drift since scheduling. `cancel
<id>` simulates the canceller call before submitting.

## Batches

A batch file is a JSON object with `ops` (intents) and `predecessors` keyed by
operation index:

```json
{
  "ops": [
    { "network": "testnet", "timelock": "C…", "target": "C…", "contract": "treasury", "fn": "propose_config", "args": {}, "title": "first", "rationale": "" },
    { "network": "testnet", "timelock": "C…", "target": "C…", "contract": "market-core", "fn": "set_default_fee_bps", "args": { "fee_bps": 200 }, "title": "second", "rationale": "" }
  ],
  "predecessors": { "1": [0] }
}
```

```sh
npm run cli -- propose --batch batches/reconfig.json --batch-id reconfig --submit
npm run cli -- execute --batch batches/reconfig.json --batch-id reconfig --submit
```

`execute --batch` uses the records' `batchId`/`batchIndex`/`predecessors` in
topological order and stops at the first failure. Batches are client-side only;
the timelock does not know about them. The `opHash` in each record is currently
a local preview with a pluggable hook (`hash.ts`) for a future on-chain hash;
it is never used for ordering.

## Emergency

`emergency` only constructs `set_paused(true)` and `cancel_proposal` calls,
mirroring the contract allow-list. It warns on every invocation because the
allow-list matches function names on **any** target contract, not just the
approved ones.

```sh
npm run cli -- emergency \
  --target C…MARKET_CORE… --contract market-core \
  --fn set_paused --args '{"paused":true}' \
  --title "Pause after oracle incident" --submit
```

## Limitations

- No Rust contract changes, multisig coordination service, or web UI.
- No `package-lock.json`; CI uses `npm install` for this package.
- Fixture-based simulation tests and local quickstart integration tests are not
  included; unit tests cover encoding, spec drift, hashing, and batch ordering.
- Records are keyed by network and operation id; the timelock id and tx hashes
  are stored inside each record. Do not share one proposals directory between
  multiple timelocks on the same network.
