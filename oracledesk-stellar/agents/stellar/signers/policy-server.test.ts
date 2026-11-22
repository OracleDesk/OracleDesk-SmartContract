import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { createLocalSigner } from "./local.js";
import { createReferencePolicyServer, MemoryAuditLog } from "./policy-server.js";
import { hashInvocationArgs } from "./policy.js";
import type { SignerPolicy } from "./types.js";

const NETWORK = "Test SDF Network ; September 2015";
const CONTRACT = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";

test("reference policy server signs approved calls and records no transaction XDR", async (t) => {
  const keypair = Keypair.random();
  const args = [xdr.ScVal.scvU32(7)];
  const policy: SignerPolicy = {
    networkPassphrase: NETWORK,
    allowedSourceAddresses: [keypair.publicKey()],
    allowedInvocations: [{
      contractId: CONTRACT,
      functionName: "commit",
      argsHash: hashInvocationArgs(args),
    }],
  };
  const signer = createLocalSigner({ keypair, policy });
  const auditLog = new MemoryAuditLog();
  const reference = createReferencePolicyServer({ signer, policy, auditLog });
  await new Promise<void>((resolve) => reference.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    reference.server.close((error) => error ? reject(error) : resolve());
  }));

  const transactionXdr = new TransactionBuilder(new Account(keypair.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: "commit", args }))
    .setTimeout(60)
    .build()
    .toXDR();
  const address = reference.server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/sign`;

  const allowed = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr: transactionXdr, networkPassphrase: NETWORK, address: keypair.publicKey() }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(auditLog.entries().map((event) => event.action), ["allow"]);
  assert.equal(JSON.stringify(auditLog.entries()).includes(transactionXdr), false);

  const rejected = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr: transactionXdr, networkPassphrase: "wrong", address: keypair.publicKey() }),
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(auditLog.entries().map((event) => event.action), ["allow", "deny"]);
});
