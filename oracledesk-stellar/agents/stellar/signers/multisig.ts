import { Transaction, xdr } from "@stellar/stellar-sdk";
import type { SignerPolicy, StellarSigner, TransactionSigningProvider } from "./types.js";
import { assertSigningRequest, validateTransaction } from "./policy.js";
import { findValidSignature, verifySignedTransaction } from "./local.js";

export interface MultisigSignerOptions {
  /** Address used as the transaction source and exposed to the SDK client. */
  address: string;
  participants: readonly TransactionSigningProvider[];
  threshold: number;
  policy: SignerPolicy;
}

export function createMultisigSigner({
  address,
  participants,
  threshold,
  policy,
}: MultisigSignerOptions): StellarSigner {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > participants.length) {
    throw new Error("multisig threshold must be between one and the participant count");
  }
  const participantAddresses = participants.map((participant) => participant.address);
  if (new Set(participantAddresses).size !== participantAddresses.length) {
    throw new Error("multisig participants must have distinct addresses");
  }

  return {
    address,
    async signTransaction(transactionXdr, options) {
      assertSigningRequest(options ?? {}, address, policy);
      const approved = validateTransaction(transactionXdr, policy.networkPassphrase, policy);
      const accepted = new Map<string, Transaction["signatures"][number]>();

      for (const participant of participants) {
        try {
          const result = await participant.signTransaction(transactionXdr, {
            networkPassphrase: policy.networkPassphrase,
            address: participant.address,
          });
          if (result.error || result.signerAddress !== participant.address) continue;
          const signed = verifySignedTransaction(
            result.signedTxXdr,
            approved.transactionHash,
            participant.address,
            policy.networkPassphrase,
          );
          const signature = findValidSignature(signed, participant.address);
          if (signature) accepted.set(participant.address, signature);
        } catch {
          // A failed participant does not prevent other configured signers from contributing.
        }
        if (accepted.size >= threshold) break;
      }

      if (accepted.size < threshold) {
        throw new Error(`multisig threshold not met (${accepted.size}/${threshold})`);
      }

      const merged = approved.transaction;
      const signatures = new Map<string, Transaction["signatures"][number]>();
      for (const signature of merged.signatures) {
        signatures.set(signature.toXDR().toString("base64"), signature);
      }
      for (const signature of accepted.values()) {
        signatures.set(signature.toXDR().toString("base64"), signature);
      }
      const envelope = merged.toEnvelope();
      if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) {
        throw new Error("multisig requires a classic transaction envelope");
      }
      envelope.v1().signatures([...signatures.values()]);
      return { signedTxXdr: envelope.toXDR("base64"), signerAddress: address };
    },
    async signAuthEntry() {
      throw new Error(
        "multisig auth-entry signing is unsupported: the SDK helper accepts one Ed25519 signature and cannot enforce this threshold",
      );
    },
  };
}
