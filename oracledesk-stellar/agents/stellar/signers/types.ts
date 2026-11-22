import type { Signer } from "@stellar/stellar-sdk/contract";

export interface InvocationPolicy {
  contractId: string;
  functionName: string;
  /** SHA-256 of the length-prefixed concatenation of each argument's XDR. */
  argsHash: string;
}

export interface SignerPolicy {
  networkPassphrase: string;
  allowedSourceAddresses: readonly string[];
  allowedInvocations: readonly InvocationPolicy[];
}

export interface SigningRequest {
  xdr: string;
  networkPassphrase: string;
  address: string;
  submit?: boolean;
  submitUrl?: string;
}

export interface SignedTransaction {
  signedTxXdr: string;
  signerAddress?: string;
  error?: { message: string; code: number; ext?: string[] };
}

export interface TransactionSigningProvider {
  readonly address: string;
  signTransaction(
    transactionXdr: string,
    options?: {
      networkPassphrase?: string;
      address?: string;
      submit?: boolean;
      submitUrl?: string;
    },
  ): Promise<SignedTransaction>;
}

export interface AuthEntrySigningProvider {
  readonly address: string;
  signAuthEntry(
    preimageXdr: string,
    options?: { address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: { message: string; code: number } }>;
}

export type StellarSigner = Signer;

export interface AuditEvent {
  timestamp: string;
  action: "allow" | "deny";
  signerAddress: string;
  transactionHash?: string;
  reason?: string;
}

export interface AuditLog {
  append(event: AuditEvent): void;
  entries(): readonly AuditEvent[];
}
