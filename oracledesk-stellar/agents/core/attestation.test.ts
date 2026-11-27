import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildAttestationMessage,
  signAttestation,
  verifyAttestation,
  type AttestationContext,
} from "./attestation.js";

// Shared byte-for-byte with `golden_attestation_message_and_signature` in
// contracts/resolver/src/lib.rs.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const CTX: AttestationContext = {
  networkPassphrase: "Test SDF Network ; September 2015",
  resolverId: "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ",
  marketId: 7n,
  round: 3,
  outcome: "No",
  specHash: Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i),
};
const GOLDEN_MESSAGE =
  "6f7261636c656465736b2d6174746573742d7631cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd4720000001200000001b6aa76760026e0dd76457999dda46739543b1bcce3f54d330b9c17ff08bb043900000000000000070000000301a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
const GOLDEN_SIGNATURE =
  "3f7bfc9882bbe894518d059b50326069523358f3da1d74b7ed90b8b395862367155ae6ac7934b3ae610e21c3dd595b7d99c2ab122037918917c96543c0cde002";
const GOLDEN_PUBKEY = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const keypair = () => Keypair.fromRawEd25519Seed(Buffer.from(SEED));

test("buildAttestationMessage matches the golden vector", () => {
  assert.equal(hex(buildAttestationMessage(CTX, 1)), GOLDEN_MESSAGE);
});

test("signAttestation matches the golden signature (Ed25519 is deterministic)", () => {
  const { pubkey, sig } = signAttestation(keypair(), CTX, 1);
  assert.equal(hex(pubkey), GOLDEN_PUBKEY);
  assert.equal(hex(sig), GOLDEN_SIGNATURE);
});

test("verifyAttestation accepts the golden signature", () => {
  const { pubkey, sig } = signAttestation(keypair(), CTX, 1);
  assert.equal(verifyAttestation(pubkey, sig, CTX, 1), true);
});

test("verifyAttestation rejects any tampered context field", () => {
  const { pubkey, sig } = signAttestation(keypair(), CTX, 1);
  const tampered: AttestationContext[] = [
    { ...CTX, marketId: 8n },
    { ...CTX, round: 4 },
    { ...CTX, outcome: "Yes" },
    { ...CTX, networkPassphrase: "Public Global Stellar Network ; September 2015" },
    { ...CTX, resolverId: "CCILJXZCHKAIBTMJ7NSQE756OGLKTOYNSWNNZXWAYZZA4ECAUEC2CNVF" },
    { ...CTX, specHash: Uint8Array.from({ length: 32 }, () => 1) },
  ];
  for (const ctx of tampered) {
    assert.equal(verifyAttestation(pubkey, sig, ctx, 1), false);
  }
});

test("verifyAttestation rejects a malleated signature (S + group order)", () => {
  const { pubkey, sig } = signAttestation(keypair(), CTX, 1);
  const order = (1n << 252n) + 27742317777372353535851937790883648493n;
  const s = BigInt(`0x${Buffer.from(sig.slice(32)).reverse().toString("hex")}`) + order;
  const malleated = Uint8Array.from(sig);
  malleated.set(Buffer.from(s.toString(16).padStart(64, "0"), "hex").reverse(), 32);
  assert.equal(verifyAttestation(pubkey, malleated, CTX, 1), false);
});

test("verifyAttestation rejects malformed lengths", () => {
  const { pubkey, sig } = signAttestation(keypair(), CTX, 1);
  assert.equal(verifyAttestation(pubkey.slice(1), sig, CTX, 1), false);
  assert.equal(verifyAttestation(pubkey, sig.slice(1), CTX, 1), false);
});

test("buildAttestationMessage validates its inputs", () => {
  assert.throws(() => buildAttestationMessage({ ...CTX, specHash: new Uint8Array(31) }, 1));
  assert.throws(() => buildAttestationMessage({ ...CTX, round: -1 }, 1));
  assert.throws(() => buildAttestationMessage({ ...CTX, round: 2 ** 32 }, 1));
});

// ── #326 v2 attestations ─────────────────────────────────────────────────

interface Vector {
  version: 1 | 2;
  network_passphrase: string;
  resolver: string;
  market_id: number;
  round: number;
  outcome: "Yes" | "No" | "Invalid";
  resolution_hash: string;
  secret_seed: string;
  pubkey: string;
  message_hex: string;
  sig_hex: string;
}

// Shared byte-for-byte with `golden_attestation_message_and_signature_v2`.
const VECTORS: Vector[] = JSON.parse(
  readFileSync(new URL("../../docs/vectors/attest-v2.json", import.meta.url), "utf8"),
).vectors;

const ctxOf = (v: Vector): AttestationContext => ({
  networkPassphrase: v.network_passphrase,
  resolverId: v.resolver,
  marketId: BigInt(v.market_id),
  round: v.round,
  outcome: v.outcome,
  specHash: Buffer.from(v.resolution_hash, "hex"),
});

test("shared vectors cover both versions and every outcome", () => {
  const ids = VECTORS.map((v) => `${v.version}:${v.outcome}`).sort();
  assert.deepEqual(ids, ["1:No", "1:Yes", "2:Invalid", "2:No", "2:Yes"]);
});

test("v1 entries of the shared vectors equal the legacy golden vector", () => {
  const v1No = VECTORS.find((v) => v.version === 1 && v.outcome === "No")!;
  assert.equal(v1No.message_hex, GOLDEN_MESSAGE);
  assert.equal(v1No.sig_hex, GOLDEN_SIGNATURE);
});

for (const v of VECTORS) {
  test(`golden v${v.version} ${v.outcome}: message, signature and verification`, () => {
    const kp = Keypair.fromRawEd25519Seed(Buffer.from(v.secret_seed, "hex"));
    const ctx = ctxOf(v);
    assert.equal(hex(buildAttestationMessage(ctx, v.version)), v.message_hex);
    const { pubkey, sig } = signAttestation(kp, ctx, v.version);
    assert.equal(hex(pubkey), v.pubkey);
    assert.equal(hex(sig), v.sig_hex);
    assert.equal(verifyAttestation(pubkey, sig, ctx, v.version), true);
  });
}

test("v2 is the default version", () => {
  const v = VECTORS.find((x) => x.version === 2 && x.outcome === "Yes")!;
  assert.equal(hex(buildAttestationMessage(ctxOf(v))), v.message_hex);
});

test("v2 message starts with its own domain and version byte", () => {
  const msg = Buffer.from(buildAttestationMessage({ ...CTX, outcome: "Invalid" }, 2));
  assert.equal(msg.subarray(0, 20).toString("ascii"), "oracledesk-attest-v2");
  assert.equal(msg[20], 2);
  // One byte longer than v1 (the version byte); the outcome byte is 2.
  assert.equal(msg.length, buildAttestationMessage(CTX, 1).length + 1);
  assert.equal(msg[msg.length - 33], 2);
});

test("v1 cannot encode Invalid", () => {
  assert.throws(() => buildAttestationMessage({ ...CTX, outcome: "Invalid" }, 1), /v1/);
  const { pubkey, sig } = signAttestation(keypair(), { ...CTX, outcome: "Invalid" }, 2);
  assert.equal(verifyAttestation(pubkey, sig, { ...CTX, outcome: "Invalid" }, 1), false);
});

test("signatures never verify across versions", () => {
  const v1 = signAttestation(keypair(), CTX, 1);
  const v2 = signAttestation(keypair(), CTX, 2);
  assert.equal(verifyAttestation(v1.pubkey, v1.sig, CTX, 2), false);
  assert.equal(verifyAttestation(v2.pubkey, v2.sig, CTX, 1), false);
});

test("v2 verification rejects tampered fields and malleated S", () => {
  const ctx: AttestationContext = { ...CTX, outcome: "Invalid" };
  const { pubkey, sig } = signAttestation(keypair(), ctx, 2);
  const tampered: AttestationContext[] = [
    { ...ctx, marketId: 8n },
    { ...ctx, round: 4 },
    { ...ctx, outcome: "No" },
    { ...ctx, networkPassphrase: "Public Global Stellar Network ; September 2015" },
    { ...ctx, resolverId: "CCILJXZCHKAIBTMJ7NSQE756OGLKTOYNSWNNZXWAYZZA4ECAUEC2CNVF" },
    { ...ctx, specHash: Uint8Array.from({ length: 32 }, () => 1) },
  ];
  for (const t of tampered) {
    assert.equal(verifyAttestation(pubkey, sig, t, 2), false);
  }
  const order = (1n << 252n) + 27742317777372353535851937790883648493n;
  const s = BigInt(`0x${Buffer.from(sig.slice(32)).reverse().toString("hex")}`) + order;
  const malleated = Uint8Array.from(sig);
  malleated.set(Buffer.from(s.toString(16).padStart(64, "0"), "hex").reverse(), 32);
  assert.equal(verifyAttestation(pubkey, malleated, ctx, 2), false);
});
