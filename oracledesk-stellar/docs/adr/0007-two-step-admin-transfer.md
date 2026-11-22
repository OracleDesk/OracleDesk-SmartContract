# ADR 0007: Two-step admin transfer, multisig-capable

## Status

Accepted.

## Context

Every contract had a single `admin` address with no way to rotate it. The
address was written once in the constructor and read for the lifetime of the
contract. Losing the key, or wanting to move control to a cold or shared key,
meant redeploying and migrating state — which for `market-core` means
abandoning every open market.

Some deployments also want the admin to be a multisig or a governance
contract rather than an EOA. A single `set_admin(new)` would let a
compromised admin key hand control to an attacker instantly and silently, and
would leave no way to back out if a mistake was made.

## Decision

### Two-step transfer with a deadline

`market-core`, `resolver`, `treasury` and `reasoning-registry` expose the same
four entrypoints:

- `propose_admin(new_admin)` — current admin only. Stores
  `PendingAdmin { address, expires_at = now + ADMIN_PROPOSAL_TTL_SECS }` and
  emits `AdminTransferProposed { new_admin }`. (`ADMIN_PROPOSAL_TTL_SECS` is
  seven days.)
- `accept_admin()` — only `pending.address`. Clears the pending record, sets
  the new admin, emits `AdminTransferred`. Because the *new* admin must call
  it, a proposal to an address the operator does not control never lands.
- `cancel_admin_transfer()` — current admin only. Clears the pending record
  and emits `AdminTransferCancelled`.
- `admin()` / `pending_admin()` — read views.

An expired proposal is inert: `accept_admin` returns `PendingAdminExpired`
once `expires_at <= now`, so a proposal that was forgotten cannot be used to
take over later. The record stays readable so operators can inspect and clear
it.

Errors: `NoPendingAdmin`, `PendingAdminExpired`.

### Multisig and contract admins

`new_admin` is an `Address`, so it can be a Stellar account, a multisig
account (a smart account implementing `CustomAccountInterface::__check_auth`),
or a contract such as the governance timelock (ADR 0008). No code changes are
needed to point a contract at a multisig: the account validates its own
`require_auth` calls against its signer weights. `market-core`'s test suite
ships a weighted-ed25519 `MultisigAccount` fixture
(`require_admin_accepts_weighted_multisig`) that proves `accept_admin` and an
admin-gated call both succeed when the threshold is met and fail when it is
not.

### Classic multisig procedure

For a Stellar classic multisig account there is no `__check_auth`; the network
validates signatures. To hand a contract over to one:

1. `propose_admin(<multisig account G...>)`.
2. Build a transaction whose only operation is
   `accept_admin()` on the contract, source = the multisig account.
3. Collect the required signatures (weights meeting the account's medium
   threshold) and submit.

## Consequences

- Control can move to a cold key, a multisig, or the timelock without
  redeploying.
- A mistaken proposal is harmless until the new admin accepts, and expires on
  its own after seven days.
- Operators must keep the pending proposal's deadline in mind; the deploy and
  migration scripts surface `pending_admin()` so a stuck proposal is visible.

## Formal model

The transfer is model-checked in
[`docs/formal/governance.tla`](../formal/README.md#governance-model). It
confirms that admin changes only through `accept_admin` by the address the
then-admin proposed, and found one discrepancy with this ADR (finding G2): the
text above says a proposal is inert once `expires_at <= now`, but every
implementation rejects only `now > expires_at`, so a proposal can be accepted
**at** `expires_at`. One side must change; `governance_admin_aligned.cfg` is the
configuration for the ADR's boundary, and
`model_trace_admin_accept_at_expiry_boundary` pins the current behaviour.
