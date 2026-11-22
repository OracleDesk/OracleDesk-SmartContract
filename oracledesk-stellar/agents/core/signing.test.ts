import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  actionToAttestationBytes,
  buildKeyBindMessage,
  buildTraceAttestationMessage,
  signKeyBind,
  signTraceAttestation,
  verifyKeyBind,
  verifyTraceAttestation,
  type KeyBindContext,
  type TraceAttestationContext,
} from "./signing.js";
import { hashTrace, type ReasoningTrace } from "./trace.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const keypair = () => Keypair.fromRawEd25519Seed(Buffer.from(SEED));

const REGISTRY_ID = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";
const AGENT_ADDRESS = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

test("actionToAttestationBytes handles canonical actions and custom Other", () => {
  assert.deepEqual(actionToAttestationBytes("create_market"), Buffer.from([0]));
  assert.deepEqual(actionToAttestationBytes("propose_market"), Buffer.from([1]));
  assert.deepEqual(actionToAttestationBytes("buy"), Buffer.from([2]));
  assert.deepEqual(actionToAttestationBytes("sell"), Buffer.from([3]));
  assert.deepEqual(actionToAttestationBytes("skip"), Buffer.from([4]));
  assert.deepEqual(actionToAttestationBytes("redeem"), Buffer.from([5]));
  assert.deepEqual(actionToAttestationBytes("claim_remainder"), Buffer.from([6]));
  assert.deepEqual(actionToAttestationBytes("resolve"), Buffer.from([7]));

  const customBytes = actionToAttestationBytes("other:custom_strategy");
  assert.equal(customBytes[0], 8);
  assert.ok(customBytes.length > 1);
});

test("key binding signing and verification cycle", () => {
  const kp = keypair();
  const ctx: Omit<KeyBindContext, "publicKey"> = {
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId: REGISTRY_ID,
    agent: AGENT_ADDRESS,
  };

  const { publicKey, signature } = signKeyBind(kp, ctx);
  assert.equal(publicKey.length, 32);
  assert.equal(signature.length, 64);

  assert.equal(verifyKeyBind(publicKey, signature, ctx), true);

  // Tampered agent address rejects
  assert.equal(
    verifyKeyBind(publicKey, signature, {
      ...ctx,
      agent: "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW",
    }),
    false,
  );

  // Tampered network passphrase rejects
  assert.equal(
    verifyKeyBind(publicKey, signature, {
      ...ctx,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    }),
    false,
  );

  // Tampered signature rejects
  const badSig = new Uint8Array(signature);
  badSig[0] ^= 0xff;
  assert.equal(verifyKeyBind(publicKey, badSig, ctx), false);
});

test("trace attestation signing and verification cycle", () => {
  const kp = keypair();
  const traceHash = Uint8Array.from({ length: 32 }, (_, i) => 0xb0 + i);
  const ctx: TraceAttestationContext = {
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId: REGISTRY_ID,
    agent: AGENT_ADDRESS,
    marketId: 42n,
    action: "buy",
    traceHash,
  };

  const { publicKey, signature } = signTraceAttestation(kp, ctx);
  assert.equal(publicKey.length, 32);
  assert.equal(signature.length, 64);

  assert.equal(verifyTraceAttestation(publicKey, signature, ctx), true);

  // Tampered fields reject
  assert.equal(verifyTraceAttestation(publicKey, signature, { ...ctx, marketId: 43n }), false);
  assert.equal(verifyTraceAttestation(publicKey, signature, { ...ctx, action: "sell" }), false);
  assert.equal(
    verifyTraceAttestation(publicKey, signature, {
      ...ctx,
      traceHash: Uint8Array.from({ length: 32 }, () => 0),
    }),
    false,
  );
  assert.equal(
    verifyTraceAttestation(publicKey, signature, {
      ...ctx,
      agent: "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW",
    }),
    false,
  );
});

test("trace attestation verifies with real reasoning trace JSON hash offline", () => {
  const kp = keypair();
  const trace: ReasoningTrace = {
    agent: "trader",
    marketId: 10,
    action: "buy",
    reasoning: "Fair probability 0.65 exceeds market price 0.50 by 1500 bps",
    inputs: { p_fair: 0.65, p_market: 0.50 },
    timestamp: 1700000000,
  };

  const traceHash = hashTrace(trace);
  const ctx: TraceAttestationContext = {
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId: REGISTRY_ID,
    agent: AGENT_ADDRESS,
    marketId: BigInt(trace.marketId!),
    action: trace.action,
    traceHash: Buffer.from(traceHash, "hex"),
  };

  const { publicKey, signature } = signTraceAttestation(kp, ctx);
  assert.equal(verifyTraceAttestation(publicKey, signature, ctx), true);

  // If trace JSON is modified, recomputed hash changes and verification fails
  const modifiedTrace = { ...trace, reasoning: "Fraudulent changed explanation" };
  const modifiedHash = hashTrace(modifiedTrace);
  assert.equal(
    verifyTraceAttestation(publicKey, signature, {
      ...ctx,
      traceHash: Buffer.from(modifiedHash, "hex"),
    }),
    false,
  );
});
