import { Address, authorizeEntry, buildAuthorizationEntryPreimage, xdr } from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import type { InvocationPolicy, SignerPolicy } from "./types.js";
import { hashInvocationArgs } from "./policy.js";

export interface ValidatedAuthPreimage {
  preimage: xdr.HashIdPreimage;
  entry: xdr.SorobanAuthorizationEntry;
  validUntilLedgerSeq: number;
}

function sameXdr(left: xdr.HashIdPreimage, right: xdr.HashIdPreimage): boolean {
  return left.toXDR().equals(right.toXDR());
}

function assertAllowedInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
  allowed: readonly InvocationPolicy[],
): void {
  if (invocation.subInvocations().length !== 0) {
    throw new Error("nested Soroban authorization invocations are unsupported");
  }
  const fn = invocation.function();
  if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    throw new Error("contract creation authorization entries are unsupported");
  }
  const contractFn = fn.contractFn();
  const rawName = contractFn.functionName();
  const functionName = Buffer.isBuffer(rawName) ? rawName.toString("utf8") : rawName;
  if (
    typeof functionName !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(functionName) ||
    (Buffer.isBuffer(rawName) && !Buffer.from(functionName, "utf8").equals(rawName))
  ) {
    throw new Error("authorized contract function name has an unsupported shape");
  }
  const contractId = Address.fromScAddress(contractFn.contractAddress()).toString();
  const argsHash = hashInvocationArgs(contractFn.args());
  if (
    !allowed.some(
      (item) =>
        item.contractId === contractId &&
        item.functionName === functionName &&
        item.argsHash === argsHash,
    )
  ) {
    throw new Error("Soroban authorization invocation is not explicitly allowed by signer policy");
  }
}

export function validateAuthEntryPreimage(
  authEntryXdr: string,
  signerAddress: string,
  policy: SignerPolicy,
): ValidatedAuthPreimage {
  let preimage: xdr.HashIdPreimage;
  try {
    const bytes = Buffer.from(authEntryXdr, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== authEntryXdr) {
      throw new Error("non-canonical base64");
    }
    preimage = xdr.HashIdPreimage.fromXDR(bytes);
  } catch {
    throw new Error("auth signing input must be a valid base64 HashIdPreimage XDR");
  }

  if (
    preimage.switch() !== xdr.EnvelopeType.envelopeTypeSorobanAuthorizationWithAddress()
  ) {
    throw new Error("only address-bound Soroban authorization preimages are supported");
  }
  const addressPreimage = preimage.sorobanAuthorizationWithAddress();
  const address = Address.fromScAddress(addressPreimage.address()).toString();
  if (address !== signerAddress) {
    throw new Error("Soroban authorization preimage is bound to a different address");
  }
  const validUntilLedgerSeq = addressPreimage.signatureExpirationLedger();
  if (!Number.isSafeInteger(validUntilLedgerSeq) || validUntilLedgerSeq <= 0) {
    throw new Error("Soroban authorization expiration ledger is invalid");
  }
  const invocation = addressPreimage.invocation();
  assertAllowedInvocation(invocation, policy.allowedInvocations);

  const entry = new xdr.SorobanAuthorizationEntry({
    rootInvocation: invocation,
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: addressPreimage.address(),
        nonce: addressPreimage.nonce(),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
  });

  let rebuilt: xdr.HashIdPreimage;
  try {
    rebuilt = buildAuthorizationEntryPreimage(entry, validUntilLedgerSeq, policy.networkPassphrase);
  } catch {
    throw new Error("Soroban authorization preimage cannot be safely reconstructed");
  }
  if (!sameXdr(preimage, rebuilt)) {
    throw new Error("Soroban authorization preimage does not match the configured network");
  }

  return { preimage, entry, validUntilLedgerSeq };
}

export async function signValidatedAuthPreimage(
  validated: ValidatedAuthPreimage,
  keypair: Keypair,
  networkPassphrase: string,
): Promise<string> {
  let signature: Buffer | undefined;
  await authorizeEntry(
    validated.entry,
    async (preimage, payload) => {
      if (!sameXdr(validated.preimage, preimage)) {
        throw new Error("SDK-generated authorization preimage differs from validated input");
      }
      signature = keypair.sign(payload);
      return signature;
    },
    validated.validUntilLedgerSeq,
    networkPassphrase,
  );
  if (!signature) throw new Error("SDK did not request an authorization signature");
  return signature.toString("base64");
}

export async function verifyAuthEntrySignature(
  authEntryXdr: string,
  signedAuthEntry: string,
  signerAddress: string,
  policy: SignerPolicy,
): Promise<void> {
  const validated = validateAuthEntryPreimage(authEntryXdr, signerAddress, policy);
  let signature: Buffer;
  try {
    signature = Buffer.from(signedAuthEntry, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== signedAuthEntry) {
      throw new Error("invalid signature encoding");
    }
  } catch {
    throw new Error("auth signer returned an invalid signature");
  }
  let callbackUsed = false;
  try {
    await authorizeEntry(
      validated.entry,
      async (preimage, payload) => {
        if (!sameXdr(validated.preimage, preimage)) {
          throw new Error("SDK-generated authorization preimage differs from validated input");
        }
        callbackUsed = true;
        return signature;
      },
      validated.validUntilLedgerSeq,
      policy.networkPassphrase,
    );
  } catch {
    throw new Error("auth signer returned an invalid or mismatched signature");
  }
  if (!callbackUsed) throw new Error("SDK did not validate an authorization signature");
}
