import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  computeResolutionSpecHash,
  resolverKey,
  type RevealedPriceSpec,
  type RevealedSignersSpec,
} from "./resolver-storage.js";
import { assessMarket, type DiligenceMarketInput, type DiligencePolicy } from "./diligence.js";

const REFLECTOR_ID = StrKey.encodeContract(Buffer.alloc(32, 11));
const SIGNER_1 = Keypair.random().publicKey();
const SIGNER_2 = Keypair.random().publicKey();

const POLICY: DiligencePolicy = {
  reflectors: {
    [REFLECTOR_ID]: ["other:XLM", "other:BTC"],
  },
  signerSets: [
    {
      name: "core-committee",
      signers: [SIGNER_1, SIGNER_2],
      minThreshold: 2,
    },
  ],
  maxCloseHorizonSecs: 30 * 86_400,
  minTimeToCloseSecs: 600,
  minSpecTtlMarginLedgers: 100,
  metadataMaxBytes: 4096,
  metadataGateways: ["https://ipfs.io/ipfs"],
};

const VALID_PRICE_SPEC: RevealedPriceSpec = {
  kind: "price",
  reflector: REFLECTOR_ID,
  asset: { tag: "Other", value: "XLM" },
  threshold: 2_000_000n,
  direction: "Above",
  maxStaleness: 900n,
  liveUntilLedger: 500_000,
};

const METADATA_JSON = JSON.stringify({
  question: "Will XLM trade above $0.20 at market close?",
});
const METADATA_BYTES = new Uint8Array(Buffer.from(METADATA_JSON, "utf8"));
const QUESTION_HASH = createHash("sha256").update(METADATA_BYTES).digest("hex");
const PRICE_SPEC_HASH = computeResolutionSpecHash(VALID_PRICE_SPEC).toString("hex");

function baseMarket(): DiligenceMarketInput {
  return {
    marketId: 42n,
    status: "Open",
    closeTime: 1_000_000 + 86_400,
    feeBps: 100,
    questionHash: QUESTION_HASH,
    resolutionHash: PRICE_SPEC_HASH,
    metaUri: "ipfs://bafkreidemo",
  };
}

test("resolverKey encodes DataKey::Price(u64) as a 2-element Soroban Vec [Symbol, U64]", () => {
  const scv = resolverKey("Price", 42n);
  const vec = scv.vec()!;
  assert.equal(vec.length, 2);
  assert.equal(vec[0].sym().toString(), "Price");
  assert.equal(vec[1].u64().toString(), "42");
});

test("assessMarket passes when all spec, commitment, allow-list, TTL, and metadata checks succeed", async () => {
  const verdict = await assessMarket(baseMarket(), {
    now: 1_000_000,
    currentLedger: 100_000,
    policy: POLICY,
    revealedSpec: VALID_PRICE_SPEC,
    fetchMetadataBytes: async () => METADATA_BYTES,
  });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.specKind, "price");
  assert.equal(verdict.verifiedQuestion, "Will XLM trade above $0.20 at market close?");
});

test("assessMarket rejects placeholder unrevealed hash, non-allowlisted reflector, and duplicate signers", async () => {
  const placeholderHash = createHash("sha256").update("unrevealed").digest("hex");
  const vPlaceholder = await assessMarket(
    { ...baseMarket(), resolutionHash: placeholderHash },
    {
      now: 1_000_000,
      currentLedger: 100_000,
      policy: POLICY,
      revealedSpec: { kind: "none" },
      fetchMetadataBytes: async () => METADATA_BYTES,
    },
  );
  assert.equal(vPlaceholder.pass, false);
  assert.equal(
    vPlaceholder.checks.find((c) => c.id === "spec_revealed")?.pass,
    false,
  );

  const badReflectorSpec: RevealedPriceSpec = {
    ...VALID_PRICE_SPEC,
    reflector: StrKey.encodeContract(Buffer.alloc(32, 99)),
  };
  const vBadReflector = await assessMarket(
    {
      ...baseMarket(),
      resolutionHash: computeResolutionSpecHash(badReflectorSpec).toString("hex"),
    },
    {
      now: 1_000_000,
      currentLedger: 100_000,
      policy: POLICY,
      revealedSpec: badReflectorSpec,
      fetchMetadataBytes: async () => METADATA_BYTES,
    },
  );
  assert.equal(vBadReflector.pass, false);
  assert.equal(
    vBadReflector.checks.find((c) => c.id === "allowlist_check")?.pass,
    false,
  );

  const dupSignerSpec: RevealedSignersSpec = {
    kind: "signers",
    signers: [SIGNER_1, SIGNER_1],
    threshold: 2,
    disputeWindow: 3600n,
    liveUntilLedger: 500_000,
  };
  const vDupSigner = await assessMarket(
    {
      ...baseMarket(),
      resolutionHash: computeResolutionSpecHash(dupSignerSpec).toString("hex"),
    },
    {
      now: 1_000_000,
      currentLedger: 100_000,
      policy: POLICY,
      revealedSpec: dupSignerSpec,
      fetchMetadataBytes: async () => METADATA_BYTES,
    },
  );
  assert.equal(vDupSigner.pass, false);
  assert.match(
    vDupSigner.checks.find((c) => c.id === "allowlist_check")?.detail ?? "",
    /duplicate signers/,
  );
});

test("assessMarket rejects recomputed spec hash mismatch, metadata hash mismatch, local:// URI, oversized metadata, and short TTL", async () => {
  // 1. Recomputed spec hash mismatch
  const vMismatch = await assessMarket(
    { ...baseMarket(), resolutionHash: "f".repeat(64) },
    {
      now: 1_000_000,
      currentLedger: 100_000,
      policy: POLICY,
      revealedSpec: VALID_PRICE_SPEC,
      fetchMetadataBytes: async () => METADATA_BYTES,
    },
  );
  assert.equal(vMismatch.checks.find((c) => c.id === "spec_commitment_match")?.pass, false);

  // 2. Metadata hash mismatch
  const vMetaMismatch = await assessMarket(baseMarket(), {
    now: 1_000_000,
    currentLedger: 100_000,
    policy: POLICY,
    revealedSpec: VALID_PRICE_SPEC,
    fetchMetadataBytes: async () => new Uint8Array(Buffer.from("tampered", "utf8")),
  });
  assert.equal(vMetaMismatch.checks.find((c) => c.id === "metadata_hash_match")?.pass, false);

  // 3. local:// meta_uri rejected
  const vLocal = await assessMarket(
    { ...baseMarket(), metaUri: "local:///tmp/trace.json" },
    {
      now: 1_000_000,
      currentLedger: 100_000,
      policy: POLICY,
      revealedSpec: VALID_PRICE_SPEC,
      fetchMetadataBytes: async () => METADATA_BYTES,
    },
  );
  assert.equal(vLocal.checks.find((c) => c.id === "metadata_hash_match")?.pass, false);

  // 4. Oversized metadata rejected
  const vOversized = await assessMarket(baseMarket(), {
    now: 1_000_000,
    currentLedger: 100_000,
    policy: { ...POLICY, metadataMaxBytes: 10 },
    revealedSpec: VALID_PRICE_SPEC,
    fetchMetadataBytes: async () => METADATA_BYTES,
  });
  assert.equal(vOversized.checks.find((c) => c.id === "metadata_hash_match")?.pass, false);

  // 5. Spec TTL shorter than close_time fails
  const vShortTtl = await assessMarket(baseMarket(), {
    now: 1_000_000,
    currentLedger: 100_000,
    policy: POLICY,
    revealedSpec: { ...VALID_PRICE_SPEC, liveUntilLedger: 100_500 },
    fetchMetadataBytes: async () => METADATA_BYTES,
  });
  assert.equal(vShortTtl.checks.find((c) => c.id === "spec_ttl_health")?.pass, false);
});
