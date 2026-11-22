import assert from "node:assert/strict";
import test from "node:test";
import { resolverPolicyReasons, SPEC_KINDS, type ResolvabilityPolicy, type TradeStatus } from "./due-diligence.js";

const OPEN: ResolvabilityPolicy = { requireRevealed: false, blockWhenDisputed: false, blockWithOpenProposal: false, minSecsToClose: 0n, allowedSpecs: 0x1ff };
const NOW = 1_000n;
const ok: TradeStatus = { spec: "Signers", state: "SignersPending", closeTime: 5_000n, deadline: 5_000n + 30n * 86_400n, openProposal: false };
const codes = (s: TradeStatus, p: ResolvabilityPolicy, now = NOW) => resolverPolicyReasons(s, p, now).map((r) => r.explanation.replace(/.*: /, "").split(" ")[0]);

test("the open default policy allows everything that has not passed its deadline", () => {
  assert.deepEqual(resolverPolicyReasons({ ...ok, spec: "None", state: "Disputed", openProposal: true }, OPEN, NOW), []);
});

test("each knob refuses with the contract's error name, in the contract's order", () => {
  assert.deepEqual(codes({ ...ok, spec: "None" }, { ...OPEN, requireRevealed: true }), ["SpecNotRevealed"]);
  assert.deepEqual(codes({ ...ok, spec: "Twap" }, { ...OPEN, allowedSpecs: (1 << 1) | (1 << 4) }), ["SpecKindNotAllowed"]);
  assert.deepEqual(codes({ ...ok, state: "Disputed" }, { ...OPEN, blockWhenDisputed: true }), ["MarketDisputed"]);
  assert.deepEqual(codes({ ...ok, openProposal: true }, { ...OPEN, blockWithOpenProposal: true }), ["ProposalOpen"]);
  assert.deepEqual(codes(ok, OPEN, ok.deadline), ["PastResolutionDeadline"]);
  assert.deepEqual(codes({ ...ok, spec: "None", state: "Disputed" }, { ...OPEN, requireRevealed: true, blockWhenDisputed: true }), ["SpecNotRevealed"], "first failing check wins, as on-chain");
});

test("min_secs_to_close boundary: exactly that far from close is allowed", () => {
  const p = { ...OPEN, minSecsToClose: 60n };
  assert.deepEqual(codes({ ...ok, closeTime: NOW + 59n }, p), ["TooCloseToClose"]);
  assert.deepEqual(codes({ ...ok, closeTime: NOW + 60n }, p), []);
  assert.deepEqual(codes({ ...ok, closeTime: NOW - 1n }, p), ["TooCloseToClose"], "already past close");
});

test("spec kind bits follow the contract's SpecKind order", () => {
  assert.deepEqual([...SPEC_KINDS], ["None", "Price", "ScaledPrice", "Twap", "Signers", "Disputable", "WeightedKeys", "Committee", "Hybrid"]);
  assert.equal(SPEC_KINDS.indexOf("Signers"), 4);
});
