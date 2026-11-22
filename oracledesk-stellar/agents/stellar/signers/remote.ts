import type {
  AuthEntrySigningProvider,
  SignerPolicy,
  StellarSigner,
  SigningRequest,
  SignedTransaction,
} from "./types.js";
import { assertSigningRequest, validateTransaction } from "./policy.js";
import { verifySignedTransaction } from "./local.js";
import { validateAuthEntryPreimage, verifyAuthEntrySignature } from "./auth-entry.js";

export interface RemoteSignerOptions {
  address: string;
  policy: SignerPolicy;
  sign: (request: SigningRequest) => Promise<SignedTransaction>;
  signAuthEntry?: AuthEntrySigningProvider["signAuthEntry"];
}

export function createRemoteSigner({
  address,
  policy,
  sign,
  signAuthEntry,
}: RemoteSignerOptions): StellarSigner {
  return {
    address,
    async signTransaction(transactionXdr, options) {
      assertSigningRequest(options ?? {}, address, policy);
      const approved = validateTransaction(transactionXdr, policy.networkPassphrase, policy);
      const response = await sign({
        xdr: transactionXdr,
        networkPassphrase: policy.networkPassphrase,
        address,
      });
      if (response.error) throw new Error(`remote signer rejected request: ${response.error.message}`);
      if (response.signerAddress !== address) {
        throw new Error("remote signer returned a different signer identity");
      }
      verifySignedTransaction(
        response.signedTxXdr,
        approved.transactionHash,
        address,
        policy.networkPassphrase,
      );
      return { signedTxXdr: response.signedTxXdr, signerAddress: address };
    },
    async signAuthEntry(preimageXdr, options) {
      if (options?.address && options.address !== address) {
        throw new Error("requested signer address does not match signer identity");
      }
      validateAuthEntryPreimage(preimageXdr, address, policy);
      if (!signAuthEntry) throw new Error("remote auth-entry signing is not configured");
      const response = await signAuthEntry(preimageXdr, { address });
      if (response.error) throw new Error(`remote signer rejected auth entry: ${response.error.message}`);
      if (response.signerAddress !== address) {
        throw new Error("remote signer returned a different signer identity");
      }
      await verifyAuthEntrySignature(preimageXdr, response.signedAuthEntry, address, policy);
      return { signedAuthEntry: response.signedAuthEntry, signerAddress: address };
    },
  };
}
