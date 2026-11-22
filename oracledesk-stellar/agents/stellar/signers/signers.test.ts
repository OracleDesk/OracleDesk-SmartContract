import assert from "node:assert/strict";
import test from "node:test";
import {
  Account,
  Address,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createLocalSigner, verifySignedTransaction } from "./local.js";
import { createMultisigSigner } from "./multisig.js";
import { createRemoteSigner } from "./remote.js";
import { hashInvocationArgs, validateTransaction } from "./policy.js";
import type { InvocationPolicy, SignerPolicy } from "./types.js";

const NETWORK = "Test SDF Network ; September 2015";
const CONTRACT = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";
const args = [xdr.ScVal.scvU32(17), xdr.ScVal.scvString("ok")];

function makeTransaction(source: Keypair, functionName = "commit", txArgs = args): string {
  return new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: functionName, args: txArgs }))
    .setTimeout(60)
    .build()
    .toXDR();
}

function rule(functionName = "commit", txArgs = args): InvocationPolicy {
  return { contractId: CONTRACT, functionName, argsHash: hashInvocationArgs(txArgs) };
}

function policy(source: string, ...rules: InvocationPolicy[]): SignerPolicy {
  return {
    networkPassphrase: NETWORK,
    allowedSourceAddresses: [source],
    allowedInvocations: rules,
  };
}

test("local signer signs only the exact allowlisted invocation", async () => {
  const account = Keypair.random();
  const signer = createLocalSigner({ keypair: account, policy: policy(account.publicKey(), rule()) });
  const approved = makeTransaction(account);
  const signed = await signer.signTransaction(approved);
  assert.equal(signed.signerAddress, account.publicKey());
  const txHash = validateTransaction(approved, NETWORK, policy(account.publicKey(), rule())).transactionHash;
  assert.equal(verifySignedTransaction(signed.signedTxXdr, txHash, account.publicKey(), NETWORK).signatures.length, 1);
  assert.ok(signed.signedTxXdr.length > approved.length);
  await assert.rejects(() => signer.signTransaction(makeTransaction(account, "withdraw")), /not explicitly allowed/);
  await assert.rejects(
    () => signer.signTransaction(makeTransaction(account, "commit", [xdr.ScVal.scvU32(18), args[1]])),
    /not explicitly allowed/,
  );
  await assert.rejects(
    () => signer.signTransaction(approved, { submit: true }),
    /must not submit/,
  );
});

test("transaction validation rejects non-contract and multi-operation envelopes", () => {
  const account = Keypair.random();
  const configured = policy(account.publicKey(), rule());
  const operation = Operation.invokeContractFunction({
    contract: CONTRACT,
    function: "commit",
    args,
  });
  const second = new TransactionBuilder(new Account(account.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(operation)
    .addOperation(operation)
    .setTimeout(60)
    .build()
    .toXDR();

  assert.throws(() => validateTransaction(second, NETWORK, configured), /single-operation/);
});

test("remote signer must return the same transaction with its valid signature", async () => {
  const source = Keypair.random();
  const remoteKey = Keypair.random();
  const changedArgs = [xdr.ScVal.scvU32(17), xdr.ScVal.scvString("changed")];
  const configured = policy(source.publicKey(), rule(), rule("commit", changedArgs));
  const localRemote = createLocalSigner({ keypair: remoteKey, policy: configured });
  const remote = createRemoteSigner({
    address: remoteKey.publicKey(),
    policy: configured,
    async sign(request) {
      return localRemote.signTransaction(request.xdr, {
        address: remoteKey.publicKey(),
        networkPassphrase: request.networkPassphrase,
      });
    },
  });

  const response = await remote.signTransaction(makeTransaction(source));
  assert.equal(response.signerAddress, remoteKey.publicKey());

  const altered = createRemoteSigner({
    address: remoteKey.publicKey(),
    policy: configured,
    async sign() {
      const changed = makeTransaction(source, "commit", changedArgs);
      return localRemote.signTransaction(changed);
    },
  });
  await assert.rejects(() => altered.signTransaction(makeTransaction(source)), /signer changed/);
});

test("multisig merges distinct verified participant signatures to threshold", async () => {
  const source = Keypair.random();
  const configured = policy(source.publicKey(), rule());
  const keys = [Keypair.random(), Keypair.random(), Keypair.random()];
  const participants = keys.map((keypair) => createLocalSigner({ keypair, policy: configured }));
  const multisig = createMultisigSigner({
    address: source.publicKey(),
    participants,
    threshold: 2,
    policy: configured,
  });

  const unsigned = makeTransaction(source);
  const expectedHash = validateTransaction(unsigned, NETWORK, configured).transactionHash;
  for (const participant of participants.slice(0, 2)) {
    const participantResult = await participant.signTransaction(unsigned, {
      address: participant.address,
      networkPassphrase: NETWORK,
    });
    assert.equal(participantResult.signerAddress, participant.address);
    assert.doesNotThrow(() =>
      verifySignedTransaction(participantResult.signedTxXdr, expectedHash, participant.address, NETWORK),
    );
  }
  const result = await multisig.signTransaction(unsigned);
  assert.equal(result.signerAddress, source.publicKey());
  const signed = TransactionBuilder.fromXDR(result.signedTxXdr, NETWORK);
  assert.equal(signed.signatures.length, 2);
  assert.throws(
    () => createMultisigSigner({ address: source.publicKey(), participants, threshold: 4, policy: configured }),
    /threshold/,
  );
});

test("local signer exposes the policy-checked Soroban auth-entry callback", () => {
  const account = Keypair.random();
  const signer = createLocalSigner({ keypair: account, policy: policy(account.publicKey(), rule()) });
  assert.equal(typeof signer.signAuthEntry, "function");
});

function makeAuthEntry(address: string, functionName = "commit", txArgs = args) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(CONTRACT).toScAddress(),
        functionName,
        args: txArgs,
      }),
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    rootInvocation: invocation,
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: new xdr.Int64(9n),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
  });
}

test("local auth-entry signer signs the SDK-generated, address-bound authorization preimage", async () => {
  const keypair = Keypair.random();
  const configured = policy(keypair.publicKey(), rule());
  const entry = makeAuthEntry(keypair.publicKey());
  const expiration = 12345;
  const preimage = buildAuthorizationEntryPreimage(entry, expiration, NETWORK);
  const preimageXdr = preimage.toXDR("base64");
  const signer = createLocalSigner({ keypair, policy: configured });
  const result = await signer.signAuthEntry!(preimageXdr, { address: keypair.publicKey() });
  assert.equal(result.signerAddress, keypair.publicKey());

  const signed = await authorizeEntry(
    entry,
    async (sdkPreimage, payload) => {
      assert.deepEqual(sdkPreimage.toXDR(), preimage.toXDR());
      return keypair.verify(payload, Buffer.from(result.signedAuthEntry, "base64"))
        ? Buffer.from(result.signedAuthEntry, "base64")
        : Buffer.alloc(64);
    },
    expiration,
    NETWORK,
  );
  assert.equal(signed.credentials().addressV2().signatureExpirationLedger(), expiration);
  assert.equal(
    signed.credentials().addressV2().signature().vec()?.length,
    1,
  );

  await assert.rejects(
    () => signer.signAuthEntry!(entry.toXDR("base64"), { address: keypair.publicKey() }),
    /HashIdPreimage/,
  );
  await assert.rejects(
    () =>
      signer.signAuthEntry!(
        buildAuthorizationEntryPreimage(entry, expiration, "Public Global Stellar Network ; September 2015")
          .toXDR("base64"),
        { address: keypair.publicKey() },
      ),
    /configured network/,
  );
});

test("remote auth-entry signer verifies its response with the SDK authorization helper", async () => {
  const remoteKey = Keypair.random();
  const configured = policy(remoteKey.publicKey(), rule());
  const localSigner = createLocalSigner({ keypair: remoteKey, policy: configured });
  const remote = createRemoteSigner({
    address: remoteKey.publicKey(),
    policy: configured,
    async sign(request) {
      return { signedTxXdr: request.xdr, signerAddress: remoteKey.publicKey() };
    },
    signAuthEntry: (preimageXdr, options) => localSigner.signAuthEntry!(preimageXdr, options),
  });
  const entry = makeAuthEntry(remoteKey.publicKey());
  const preimageXdr = buildAuthorizationEntryPreimage(entry, 12345, NETWORK).toXDR("base64");
  const result = await remote.signAuthEntry!(preimageXdr, { address: remoteKey.publicKey() });
  assert.equal(result.signerAddress, remoteKey.publicKey());
  await assert.rejects(
    () =>
      createRemoteSigner({
        address: remoteKey.publicKey(),
        policy: configured,
        async sign(request) {
          return { signedTxXdr: request.xdr, signerAddress: remoteKey.publicKey() };
        },
        async signAuthEntry() {
          return { signedAuthEntry: Buffer.alloc(64).toString("base64"), signerAddress: remoteKey.publicKey() };
        },
      }).signAuthEntry!(preimageXdr),
    /invalid or mismatched signature/,
  );
});

test("auth-entry signer rejects address mismatch, nested invocations, and unallowlisted calls", async () => {
  const keypair = Keypair.random();
  const other = Keypair.random();
  const configured = policy(keypair.publicKey(), rule());
  const signer = createLocalSigner({ keypair, policy: configured });
  const expiration = 12345;

  const wrongAddress = makeAuthEntry(other.publicKey());
  const wrongAddressPreimage = buildAuthorizationEntryPreimage(wrongAddress, expiration, NETWORK);
  await assert.rejects(
    () => signer.signAuthEntry!(wrongAddressPreimage.toXDR("base64")),
    /different address/,
  );

  const nested = makeAuthEntry(keypair.publicKey());
  nested.rootInvocation().subInvocations([
    new xdr.SorobanAuthorizedInvocation({
      function: nested.rootInvocation().function(),
      subInvocations: [],
    }),
  ]);
  await assert.rejects(
    () =>
      signer.signAuthEntry!(
        buildAuthorizationEntryPreimage(nested, expiration, NETWORK).toXDR("base64"),
      ),
    /nested/,
  );

  const unapproved = makeAuthEntry(keypair.publicKey(), "withdraw");
  await assert.rejects(
    () =>
      signer.signAuthEntry!(
        buildAuthorizationEntryPreimage(unapproved, expiration, NETWORK).toXDR("base64"),
      ),
    /not explicitly allowed/,
  );
});
