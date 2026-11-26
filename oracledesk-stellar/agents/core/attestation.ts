/**
 * Off-chain Ed25519 attestations for `resolver.submit_signatures` (v1) and
 * `resolver.submit_signatures_v2` (v2, issue #326).
 *
 * A committee member signs the message built here with a plain Ed25519 key;
 * anyone (typically the agent or a keeper) collects the signatures and submits
 * them in one transaction. The byte layouts must match
 * `Resolver::attestation_message` / `attestation_message_v2` in
 * contracts/resolver/src/lib.rs exactly.
 *
 * Version 1 (Yes/No only):
 *
 *   "oracledesk-attest-v1"                  20 ASCII bytes, domain tag
 *   || network_id                           32 bytes, sha256(network passphrase)
 *   || ScVal-XDR(resolver contract address) 40 bytes for a C... address
 *   || market_id                            u64 big-endian
 *   || round                                u32 big-endian
 *   || outcome                              1 byte: 0 = Yes, 1 = No
 *   || spec_hash                            32 bytes, the market's resolution_hash
 *
 * Version 2 (adds Invalid):
 *
 *   "oracledesk-attest-v2" || 0x02 (version byte) || network_id || XDR(resolver)
 *   || market_id u64 BE || round u32 BE || outcome u8 {0=Yes,1=No,2=Invalid}
 *   || spec_hash
 *
 * The message is signed raw (never pre-hashed), matching the contract's
 * `ed25519_verify`. A v1 signature never verifies as v2 (or the reverse), and
 * the contract aborts the whole batch on one bad signature, so always build
 * and pre-verify with the version you will submit. The golden vectors in
 * docs/vectors/attest-v2.json are shared with the Rust test
 * `golden_attestation_message_and_signature_v2`.
 */

import { createHash } from "node:crypto";
import { Address, Keypair, StrKey } from "@stellar/stellar-sdk";

const DOMAIN_V1 = Buffer.from("oracledesk-attest-v1", "ascii");
const DOMAIN_V2 = Buffer.from("oracledesk-attest-v2", "ascii");
const VERSION_BYTE_V2 = 2;
/** Order of the Ed25519 base-point subgroup. */
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

export type AttestedOutcome = "Yes" | "No" | "Invalid";
export type AttestationVersion = 1 | 2;

export interface AttestationContext {
  networkPassphrase: string;
  /** The resolver contract (`C...`) the signatures will be submitted to. */
  resolverId: string;
  marketId: bigint;
  /** `resolver.current_round(marketId)` at signing time. */
  round: number;
  outcome: AttestedOutcome;
  /** 32-byte `resolution_hash` of the market (from market-core `get_market`). */
  specHash: Uint8Array;
}

export interface Attestation {
  pubkey: Uint8Array;
  sig: Uint8Array;
}

const OUTCOME_BYTE: Record<AttestedOutcome, number> = { Yes: 0, No: 1, Invalid: 2 };

/**
 * Builds the exact bytes a weighted-key signer signs. `version` defaults to 2;
 * pass 1 only for markets whose resolver still accepts v1 (`Invalid` cannot be
 * encoded in v1 and throws).
 */
export function buildAttestationMessage(
  ctx: AttestationContext,
  version: AttestationVersion = 2,
): Uint8Array {
  if (ctx.specHash.length !== 32) {
    throw new Error(`specHash must be 32 bytes, got ${ctx.specHash.length}`);
  }
  if (!Number.isInteger(ctx.round) || ctx.round < 0 || ctx.round > 0xffff_ffff) {
    throw new Error(`round must be a u32, got ${ctx.round}`);
  }
  if (!(ctx.outcome in OUTCOME_BYTE)) {
    throw new Error(`unknown outcome ${String(ctx.outcome)}`);
  }
  if (version === 1 && ctx.outcome === "Invalid") {
    throw new Error("Invalid cannot be attested with the v1 message; use version 2");
  }
  if (version !== 1 && version !== 2) {
    throw new Error(`unknown attestation version ${String(version)}`);
  }
  const marketId = Buffer.alloc(8);
  marketId.writeBigUInt64BE(ctx.marketId);
  const round = Buffer.alloc(4);
  round.writeUInt32BE(ctx.round);

  const prefix = version === 1 ? [DOMAIN_V1] : [DOMAIN_V2, Buffer.from([VERSION_BYTE_V2])];
  return Buffer.concat([
    ...prefix,
    createHash("sha256").update(ctx.networkPassphrase).digest(),
    Address.fromString(ctx.resolverId).toScVal().toXDR(),
    marketId,
    round,
    Buffer.from([OUTCOME_BYTE[ctx.outcome]]),
    ctx.specHash,
  ]);
}

export function signAttestation(
  keypair: Keypair,
  ctx: AttestationContext,
  version: AttestationVersion = 2,
): Attestation {
  const message = buildAttestationMessage(ctx, version);
  return {
    pubkey: new Uint8Array(keypair.rawPublicKey()),
    sig: new Uint8Array(keypair.sign(Buffer.from(message))),
  };
}

/**
 * Pre-filter for a batch before `submit_signatures[_v2]`: the contract aborts
 * the whole batch on one invalid signature, so drop anything this rejects.
 *
 * Besides the Ed25519 check it rejects a non-canonical `S` (>= the group
 * order), which the contract also rejects. It does not re-implement the
 * contract's rejection of weak (small-order) public keys and small-order `R`,
 * so it can pass a signature the contract refuses; that only makes the batch
 * fail, it can never make an invalid signature count.
 */
export function verifyAttestation(
  pubkey: Uint8Array,
  sig: Uint8Array,
  ctx: AttestationContext,
  version: AttestationVersion = 2,
): boolean {
  if (pubkey.length !== 32 || sig.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(sig.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  let message: Buffer;
  try {
    message = Buffer.from(buildAttestationMessage(ctx, version));
  } catch {
    return false;
  }
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(pubkey)));
  return key.verify(message, Buffer.from(sig));
}
