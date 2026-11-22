import { Keypair, Transaction, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import type { StellarSigner, SignerPolicy } from "./types.js";
import { assertSigningRequest, validateTransaction } from "./policy.js";
import { signValidatedAuthPreimage, validateAuthEntryPreimage } from "./auth-entry.js";

export interface LocalSignerOptions {
  keypair: Keypair;
  policy: SignerPolicy;
}

export function createLocalSigner({ keypair, policy }: LocalSignerOptions): StellarSigner {
  const sdkSigner = new KeypairSigner(keypair, policy.networkPassphrase);
  return {
    address: sdkSigner.address,
    async signTransaction(transactionXdr, options) {
      assertSigningRequest(options ?? {}, sdkSigner.address, policy);
      validateTransaction(transactionXdr, policy.networkPassphrase, policy);
      return sdkSigner.signTransaction(transactionXdr, {
        networkPassphrase: policy.networkPassphrase,
        address: sdkSigner.address,
      });
    },
    async signAuthEntry(authEntryXdr, options) {
      if (options?.address && options.address !== sdkSigner.address) {
        throw new Error("requested signer address does not match signer identity");
      }
      const validated = validateAuthEntryPreimage(authEntryXdr, sdkSigner.address, policy);
      return {
        signedAuthEntry: await signValidatedAuthPreimage(
          validated,
          keypair,
          policy.networkPassphrase,
        ),
        signerAddress: sdkSigner.address,
      };
    },
  };
}

export function verifySignedTransaction(
  transactionXdr: string,
  expectedTransactionHash: string,
  signerAddress: string,
  networkPassphrase: string,
): Transaction {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch {
    throw new Error("signed transaction XDR is invalid or unsupported");
  }
  if (!(tx instanceof Transaction)) throw new Error("signed fee-bump transactions are unsupported");
  if (tx.hash().toString("hex") !== expectedTransactionHash) {
    throw new Error("signer changed the approved transaction");
  }

  const signature = findValidSignature(tx, signerAddress);
  if (!signature) throw new Error("signed transaction has no valid signature from the signer");
  return tx;
}

export function findValidSignature(
  transaction: Transaction,
  signerAddress: string,
): xdr.DecoratedSignature | undefined {
  let publicKey: Keypair;
  try {
    publicKey = Keypair.fromPublicKey(signerAddress);
  } catch {
    throw new Error("signer address is not a valid Ed25519 account");
  }
  const hint = publicKey.signatureHint();
  return transaction.signatures.find(
    (decorated) =>
      decorated.hint().equals(hint) &&
      publicKey.verify(transaction.hash(), decorated.signature()),
  );
}
