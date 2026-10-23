import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EncryptedFileKeystoreSigner,
  EnvKeypairSigner,
  RemoteHttpSigner,
  redactStellarSecrets,
} from "./key-signer.js";

test("EnvKeypairSigner and EncryptedFileKeystoreSigner produce identical Ed25519 signatures and reject wrong passphrases", async () => {
  const kp = Keypair.random();
  const dir = mkdtempSync(join(tmpdir(), "keystore-"));
  const ksPath = join(dir, "agent-keystore.json");

  EncryptedFileKeystoreSigner.writeKeystoreFile(ksPath, kp.secret(), "correct-horse-battery");

  const envSigner = new EnvKeypairSigner(kp.secret());
  const fileSigner = new EncryptedFileKeystoreSigner(ksPath, "correct-horse-battery");

  assert.equal(await envSigner.publicKey(), kp.publicKey());
  assert.equal(await fileSigner.publicKey(), kp.publicKey());

  const message = Buffer.from("oracledesk-attestation-payload", "utf8");
  const sigEnv = await envSigner.signBytes(message);
  const sigFile = await fileSigner.signBytes(message);
  assert.deepEqual(sigEnv, sigFile);
  assert.equal(kp.verify(message, sigFile), true);

  assert.throws(
    () => new EncryptedFileKeystoreSigner(ksPath, "wrong-passphrase-123"),
    /Unsupported state or unable to authenticate data/,
  );
});

test("RemoteHttpSigner delegates signing without holding secret material and redactStellarSecrets scrubs seeds", async () => {
  const kp = Keypair.random();
  const remote = new RemoteHttpSigner(
    "https://signer.internal/v1/sign",
    kp.publicKey(),
    "tok-123",
    async (_url, init) => {
      const reqBody = JSON.parse(String(init?.body)) as { payloadHex: string };
      const sig = kp.sign(Buffer.from(reqBody.payloadHex, "hex"));
      return new Response(JSON.stringify({ signatureHex: Buffer.from(sig).toString("hex") }), {
        status: 200,
      });
    },
  );

  const payload = Buffer.from("remote-sign-check", "utf8");
  const sig = await remote.signBytes(payload);
  assert.equal(kp.verify(payload, sig), true);

  const leakedLog = `Failed loading AGENT_SECRET=${kp.secret()} from env`;
  const scrubbed = redactStellarSecrets(leakedLog);
  assert.equal(scrubbed.includes(kp.secret()), false);
  assert.match(scrubbed, /S\[REDACTED_STELLAR_SECRET\]/);
});
