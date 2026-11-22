# Agent signer primitives

The signer factories in `agents/stellar/signers/` implement the Stellar SDK
16 `contract.Signer` callback shape. `StellarAdapter` accepts one of these
signers through its `signer` option in live mode, and uses `signer.address` as
the acting agent. The signer address must match `agentAddress` (or the
deployment's default agent). The existing CLI wiring still selects local
`agentSecret` keys; remote or multisig signers must currently be supplied by a
programmatic adapter caller. The signers are deliberately narrower than a
general-purpose wallet:

- A `SignerPolicy` must enumerate allowed transaction source addresses and
  exact allowed Soroban contract/function/argument combinations. Each
  `argsHash` is the SHA-256 hash of a four-byte big-endian argument count
  followed by each argument's `ScVal` XDR bytes; use `hashInvocationArgs` to
  calculate it.
- Only a classic transaction with exactly one `invokeContract` host-function
  operation and no Soroban authorization entries is accepted. Fee bumps,
  contract creation, WASM upload, other operation types, and unsupported
  invocation shapes are rejected.
- Local signers use the SDK's `KeypairSigner` for transaction signatures; remote signers require an
  injected signing transport and verify that its response preserves the
  approved transaction and contains a valid signature from the expected
  Ed25519 address. Multisig gathers and merges participant transaction
  signatures until its configured threshold is met.
- Local and remote signers support SDK auth-entry callbacks only for
  address-bound Soroban authorization preimages. They parse the supplied
  `HashIdPreimage`, require the preimage address to match the signer, rebuild
  it with `buildAuthorizationEntryPreimage`, and sign/verify through the SDK's
  `authorizeEntry` helper. Legacy address-less auth preimages, nested
  invocations, contract-creation authorization, other networks, and calls not
  in the invocation allowlist are rejected. Multisig explicitly rejects
  auth-entry signing because the SDK helper accepts a single Ed25519
  signature, not a verifiable multisig threshold.
- `createReferencePolicyServer` is a minimal HTTP example (`POST /sign`) for
  trusted environments, not a production security boundary. Put it behind
  authenticated, encrypted transport and add durable audit storage, rate
  limits, and operational controls before deployment. The sample audit log
  records decision metadata and transaction hashes, never raw transaction
  XDR.

## Adapter callback integration

Pass a signer to `new StellarAdapter({ mode: "live", signer, ... })`. The
adapter sets the generated-client `publicKey` from `signer.address` and passes
the `contract.Signer` object to `Client.from`. The signer callback receives
base64 transaction-envelope XDR plus optional
`networkPassphrase`/`address`/`submit`/`submitUrl`, and returns
`{ signedTxXdr, signerAddress? }` (or an SDK wallet error). This implementation
requires the supplied network and address to match policy/identity, forbids
submission options, and validates before signing.

`signAuthEntry` is a separate callback used for non-invoker Soroban
authorization. Its input is the SDK-generated base64 `HashIdPreimage` XDR,
not a raw `SorobanAuthorizationEntry`; it returns the base64 Ed25519
signature over the SDK-generated network-bound payload. Adapter integration
should keep the existing dry-run behavior and avoid handing secrets to
dry-run mode.

## Exported signer APIs

The signer package currently exports factory functions (not concrete signer
classes):

```ts
createLocalSigner(options: LocalSignerOptions): StellarSigner
createRemoteSigner(options: RemoteSignerOptions): StellarSigner
createMultisigSigner(options: MultisigSignerOptions): StellarSigner
createReferencePolicyServer(options: PolicyServerOptions): ReferencePolicyServer
```

`LocalSignerOptions` is `{ keypair: Keypair; policy: SignerPolicy }`.
`RemoteSignerOptions` is `{ address: string; policy: SignerPolicy;
sign: (request: SigningRequest) => Promise<SignedTransaction>;
signAuthEntry?: AuthEntrySigningProvider["signAuthEntry"] }`.
`MultisigSignerOptions` is `{ address: string;
participants: readonly TransactionSigningProvider[]; threshold: number;
policy: SignerPolicy }`. `StellarSigner` aliases SDK 16's `contract.Signer`.
`TransactionSigningProvider` exposes `address` and
`signTransaction(transactionXdr, options?)`; `AuthEntrySigningProvider`
exposes `address` and `signAuthEntry(preimageXdr, options?)`.

## Key compromise and retroactive revocation (#299)

When a signing key leaks (from a policy server, remote signer host, or CI
secret), two tools are available:

- **`retire_signing_key`** stops future use of the key but does not taint
  traces already published. Every trace the key signed between the compromise
  and the retirement keeps `verify_trace_signature == true` and
  `TraceVerdict::Valid`.
- **`revoke_signing_key(key, compromised_since, reason)`** retroactively
  taints exactly the traces that key signed at or after `compromised_since`.
  The verdict flips to `KeyCompromised(since)` for those traces, and
  `verify_trace_signature` returns `false` for them. Traces signed by the
  agent's other keys are unaffected.

`revoke_signing_key` is callable by the agent or the registry admin,
including for retired or revoked agents. Revocation is permanent:
`compromised_since` can only move earlier on a subsequent call (widening the
taint window). Picking `compromised_since` too late leaves tainted traces
looking valid; too early taints honest traces. Use the earliest timestamp the
key could have been exposed.

The `signature_verdict` view returns a `SignatureVerdict` (NotSigned,
WrongAgent, Valid, or KeyCompromised) independent of hash/flag/agent checks.
`trace_verdict` precedence is: HashMismatch > Flagged > AgentRevokedAfter >
KeyCompromised > Valid.

Auditors can page through a key's signed traces with `key_traces` and
`key_trace_count`, and binary-search for the first affected trace with
`key_affected_from`. The per-key index is built by `publish_trace_signed`
and `publish_chained_trace_signed`; traces published before the index existed
or published unsigned have no entries and are not covered.
