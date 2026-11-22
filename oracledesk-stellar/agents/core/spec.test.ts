import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildSpec,
  canonicalizeSpec,
  InvalidSpecError,
  toContractArg,
  toSpecHashArgs,
  validateCloseTime,
  validateSpec,
  type SpecJson,
} from "./spec.js";
import { CliSpecHasher, parseSpecHashOutput, VerifyingSpecHasher } from "./spec-hasher.js";

// Same addresses as the golden vectors in contracts/resolver and scripts/spec-hash.
const G1 = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
const G2 = "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW";
const G3 = "GAJ7BAGE252F636J2HNCRCSFLALJRBY3YQK6DE7Q7DWZECWIR2VOTYZL";
const C1 = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";

const signers = (over: Partial<Extract<SpecJson, { mode: "signers" }>> = {}): SpecJson => ({
  mode: "signers",
  signers: [G1],
  threshold: 1,
  disputeWindow: "5",
  ...over,
});
const price = (over: Partial<Extract<SpecJson, { mode: "price" }>> = {}): SpecJson => ({
  mode: "price",
  reflector: C1,
  asset: { other: "XLM" },
  threshold: "2000",
  direction: "above",
  maxStaleness: "10",
  ...over,
});

test("validateSpec rejects threshold 0, threshold > len, empty signers, zero dispute window, negative price threshold, zero staleness", () => {
  const bad: SpecJson[] = [
    signers({ threshold: 0 }),
    signers({ threshold: 2 }),
    signers({ signers: [] }),
    signers({ disputeWindow: "0" }),
    price({ threshold: "-1" }),
    price({ maxStaleness: "0" }),
  ];
  for (const spec of bad) assert.throws(() => validateSpec(spec), InvalidSpecError, JSON.stringify(spec));
  validateSpec(signers());
  validateSpec(signers({ signers: [G1, G2, G3], threshold: 3 }));
  validateSpec(price({ threshold: "0" }));
});

test("validateSpec rejects malformed addresses and integers", () => {
  assert.throws(() => validateSpec(signers({ signers: ["not-an-address"] })), InvalidSpecError);
  assert.throws(() => validateSpec(price({ reflector: G1 })), InvalidSpecError);
  assert.throws(() => validateSpec(signers({ disputeWindow: "1.5" })), InvalidSpecError);
  assert.throws(() => validateSpec(signers({ disputeWindow: "18446744073709551616" })), InvalidSpecError);
});

test("signer order is canonicalized before hashing and reveal", () => {
  const a = signers({ signers: [G2, G3, G1], threshold: 2, disputeWindow: "3600" });
  const b = signers({ signers: [G1, G3, G2], threshold: 2, disputeWindow: "3600" });
  const expected = [G3, G1, G2]; // lexicographic strkey order
  assert.deepEqual(toSpecHashArgs(a), ["signers", "2", "3600", ...expected]);
  assert.deepEqual(toSpecHashArgs(a), toSpecHashArgs(b));
  assert.deepEqual((toContractArg(a) as { signers: string[] }).signers, expected);
  assert.deepEqual(toContractArg(a), toContractArg(b));
  assert.deepEqual(a.mode === "signers" && a.signers, [G2, G3, G1], "canonicalize must not mutate");
  assert.deepEqual(canonicalizeSpec(a), canonicalizeSpec(b));
});

test("toContractArg maps price specs onto the binding types", () => {
  assert.deepEqual(toContractArg(price({ asset: { stellar: G1 }, direction: "at-or-below" })), {
    reflector: C1,
    asset: { tag: "Stellar", values: [G1] },
    threshold: 2000n,
    direction: { tag: "AtOrBelow", values: undefined },
    max_staleness: 10n,
  });
  assert.deepEqual(toSpecHashArgs(price()), ["price", C1, "other:XLM", "2000", "above", "10"]);
});

test("buildSpec reads MM_* config, defaulting to the agent as sole signer", () => {
  assert.deepEqual(buildSpec({ MM_DISPUTE_WINDOW_SECS: "5" }, G1), signers());
  assert.deepEqual(buildSpec({ MM_SIGNERS: `${G2}, ${G1}`, MM_SIGNER_THRESHOLD: "2" }, G3), {
    mode: "signers",
    signers: [G1, G2],
    threshold: 2,
    disputeWindow: "600",
  });
  assert.throws(() => buildSpec({ MM_SIGNERS: `${G1},${G1}` }, G1), InvalidSpecError);
  assert.throws(() => buildSpec({ MM_SPEC_MODE: "price" }, G1), InvalidSpecError);
  assert.deepEqual(
    buildSpec({ MM_REFLECTOR: C1, MM_MAX_STALENESS_SECS: "10" }, G1, {
      asset: "other:XLM",
      threshold: "2000",
      direction: "above",
    }),
    price(),
  );
});

test("validateCloseTime requires room for the dispute window", () => {
  const spec = signers({ disputeWindow: "600" });
  assert.throws(() => validateCloseTime(1_000_660n, 1_000_000, spec, 60), InvalidSpecError);
  validateCloseTime(1_000_661n, 1_000_000, spec, 60);
  validateCloseTime(1_000_061n, 1_000_000, price(), 60);
});

test("parseSpecHashOutput accepts exactly one line of 64 hex", () => {
  const h = "b935a3beeebdbf7b9defc916410f19a1740a3920623230152e41a812b6f141c4";
  assert.equal(parseSpecHashOutput(`${h}\n`), h);
  assert.equal(parseSpecHashOutput(`${h}\r\n`), h);
  assert.throws(() => parseSpecHashOutput(`${h}\n${h}\n`));
  assert.throws(() => parseSpecHashOutput("abc\n"));
  assert.throws(() => parseSpecHashOutput(""));
});

test("VerifyingSpecHasher fails when library and CLI disagree", async () => {
  const fixed = (h: string) => ({ hash: async () => h });
  const a = "a".repeat(64);
  assert.equal(await new VerifyingSpecHasher(fixed(a), fixed(a)).hash(signers()), a);
  await assert.rejects(new VerifyingSpecHasher(fixed(a), fixed("b".repeat(64))).hash(signers()), /disagreement/);
});

function cargoAvailable(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "spec-hash", "Cargo.toml");
const CLI_AVAILABLE = Boolean(process.env.SPEC_HASH_BIN) || cargoAvailable();

test(
  "CliSpecHasher output matches known vector from seed-market defaults",
  { skip: CLI_AVAILABLE ? false : "needs cargo or SPEC_HASH_BIN", timeout: 600_000 },
  async () => {
    const hasher = new CliSpecHasher({ manifestPath: MANIFEST, bin: process.env.SPEC_HASH_BIN || undefined });
    // `cargo run --manifest-path scripts/spec-hash/Cargo.toml -- signers 1 5 <G1>`,
    // pinned identically in contracts/resolver's golden tests.
    assert.equal(
      await hasher.hash(signers()),
      "b935a3beeebdbf7b9defc916410f19a1740a3920623230152e41a812b6f141c4",
    );
    // Order-insensitive input, canonical (and golden) output.
    assert.equal(
      await hasher.hash(signers({ signers: [G3, G2, G1], threshold: 2, disputeWindow: "3600" })),
      await hasher.hash(signers({ signers: [G3, G1, G2], threshold: 2, disputeWindow: "3600" })),
    );
    assert.equal(
      await hasher.hash(price()),
      "b6f2458326d5f76bd9b53a93a103ea6c0fed7129c5496e91e3faef9a9a23d469",
    );
  },
);
