/**
 * Golden vectors for `oracledesk-x402-receipt-v1` (#330).
 *
 *   npx tsx receipt-vectors.ts            # rewrite docs/vectors/x402-receipt-v1.json
 *
 * Ed25519 is deterministic, so a fixed test key and fixed fields always
 * produce the same bytes; `receipt.test.ts` asserts the committed file still
 * matches this generator and that every vector verifies (or fails) as
 * labelled. The key below is a published TEST key: never use it to sign.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  encodeReceipt,
  importSigningKey,
  kidFor,
  signReceipt,
  type ReceiptFields,
  type ReceiptKeySet,
} from "./receipt.js";

export const VECTORS_PATH = fileURLToPath(
  new URL("../docs/vectors/x402-receipt-v1.json", import.meta.url),
);

const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

export function testKey(label = "oracledesk-x402-receipt-v1 test key") {
  const seed = createHash("sha256").update(label).digest("hex");
  const priv = createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX + seed, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
  const publicKey = Buffer.from(jwk.x, "base64url").toString("hex");
  return { seed, publicKey };
}

const BASE_FIELDS: Omit<ReceiptFields, "kid"> = {
  network: "stellar:testnet",
  paymentId: "5f".repeat(32),
  settlementTx: "ab".repeat(32),
  traceId: "42",
  traceHash: "9c".repeat(32),
  verdict: "unchecked",
  amount: "100000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  payer: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
  settledAt: "1767225600",
};

export async function generateVectors() {
  const { seed, publicKey } = testKey();
  const kid = await kidFor(publicKey);
  const notBefore = 1_735_689_600; // 2025-01-01
  const keySet: ReceiptKeySet = { keys: [{ kid, publicKey, notBefore }] };
  const privateKey = await importSigningKey(seed, publicKey);
  const cases: { name: string; fields: ReceiptFields }[] = [
    { name: "basic", fields: { kid, ...BASE_FIELDS } },
    {
      name: "pubnet_flagged_large_amount",
      fields: {
        kid,
        ...BASE_FIELDS,
        network: "stellar:pubnet",
        traceId: "18446744073709551615",
        verdict: "Flagged:fabricated",
        // Above 2^53: preserved exactly as a decimal string.
        amount: "123456789012345678901234567890",
      },
    },
  ];
  const valid = [];
  for (const c of cases)
    valid.push({
      name: c.name,
      fields: c.fields,
      msgHex: bytesToHex(encodeReceipt(c.fields)),
      receipt: await signReceipt(c.fields, privateKey),
    });
  const good = valid[0]!.receipt;
  const [msgPart, sigPart] = good.split(".") as [string, string];
  const sig = base64urlDecode(sigPart);
  sig[0] = sig[0]! ^ 0x01;
  const other = testKey("oracledesk-x402-receipt-v1 other key");
  const otherKid = await kidFor(other.publicKey);
  const invalid = [
    {
      name: "flipped_signature_byte",
      receipt: `${msgPart}.${base64urlEncode(sig)}`,
      keySet,
      reason: "bad signature",
    },
    {
      name: "wrong_kid",
      receipt: good,
      keySet: {
        keys: [{ kid: otherKid, publicKey: other.publicKey, notBefore }],
      },
      reason: "unknown kid",
    },
    {
      name: "settled_at_outside_key_window",
      receipt: good,
      keySet: {
        keys: [{ kid, publicKey, notBefore, notAfter: Number(BASE_FIELDS.settledAt) }],
      },
      reason: "settledAt outside key window",
    },
  ];
  return {
    domain: "oracledesk-x402-receipt-v1",
    note: "Published TEST key. Never sign real receipts with it.",
    key: { seed, publicKey, kid, notBefore },
    keySet,
    valid,
    invalid,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const vectors = await generateVectors();
  writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2) + "\n");
  console.log(`wrote ${VECTORS_PATH}`);
}
