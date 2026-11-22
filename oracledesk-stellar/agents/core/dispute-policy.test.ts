import assert from "node:assert/strict";
import test from "node:test";
import { alternativeFor, decideDispute, DEFAULT_POLICY, payoutFor, protectedValue, type DisputeInputs } from "./dispute-policy.js";

const base: DisputeInputs = {
  proposal: "Yes",
  verdict: { outcome: "No", confidenceBps: 9_800 },
  exposure: { yes: 0n, no: 1_000_000_000n, costBasis: 500_000_000n },
  bond: 100_000_000n,
  budgetAvailable: 500_000_000n,
  secondsLeft: 300n,
};
const decide = (o: Partial<DisputeInputs>, cfg = DEFAULT_POLICY) => decideDispute({ ...base, ...o }, cfg);

test("disputes when the protected value clearly outweighs the bond", () => {
  const d = decide({});
  assert.equal(d.dispute, true);
  assert.equal(d.protectedValue, 1_000_000_000n);
});

test("never disputes a proposal the verdict agrees with", () => {
  const d = decide({ verdict: { outcome: "Yes", confidenceBps: 10_000 } });
  assert.deepEqual([d.dispute, !d.dispute && d.reason], [false, "AGREES_WITH_PROPOSAL"]);
});

test("confidence below the threshold never disputes, however large the exposure", () => {
  const d = decide({ verdict: { outcome: "No", confidenceBps: 9_499 }, exposure: { yes: 0n, no: 10n ** 15n, costBasis: 0n } });
  assert.deepEqual([d.dispute, !d.dispute && d.reason], [false, "LOW_CONFIDENCE"]);
  assert.equal(decide({ verdict: { outcome: "No", confidenceBps: 9_500 } }).dispute, true, "exactly at the threshold is allowed");
});

test("the bond must be worth risking: protected*p > bond*(1-p), strictly", () => {
  // p = 0.95: protected * 9500 vs bond * 500. bond 100 => protected must exceed 100 * 500 / 9500 = 5.26...
  const cfg = { ...DEFAULT_POLICY };
  const at = (protectedStroops: bigint) =>
    decide({ verdict: { outcome: "No", confidenceBps: 9_500 }, exposure: { yes: 0n, no: protectedStroops, costBasis: 0n }, bond: 100n, budgetAvailable: 100n }, cfg);
  assert.equal(at(5n).dispute, false, "5 * 9500 = 47_500 <= 100 * 500 = 50_000");
  assert.equal(at(6n).dispute, true, "6 * 9500 = 57_000 > 50_000");
  // Tie: bond * (1 - p) exactly equals protected * p -> rounds toward not disputing.
  const tie = decide({ verdict: { outcome: "No", confidenceBps: 5_000 }, exposure: { yes: 0n, no: 100n, costBasis: 0n }, bond: 100n, budgetAvailable: 100n }, { ...cfg, minConfidenceBps: 0 });
  assert.deepEqual([tie.dispute, !tie.dispute && tie.reason], [false, "NOT_WORTH_BOND"]);
});

test("no exposure on the verdict's side means nothing to protect", () => {
  const d = decide({ exposure: { yes: 800n, no: 0n, costBasis: 0n } });
  assert.deepEqual([d.dispute, !d.dispute && d.reason, d.protectedValue], [false, "NOT_WORTH_BOND", 0n]);
});

test("insufficient budget blocks the dispute", () => {
  const d = decide({ budgetAvailable: base.bond - 1n });
  assert.deepEqual([d.dispute, !d.dispute && d.reason], [false, "BUDGET"]);
  assert.equal(decide({ budgetAvailable: base.bond }).dispute, true);
});

test("a window with too little ledger time left blocks the dispute", () => {
  assert.equal(decide({ secondsLeft: 59n }).dispute, false);
  const late = decide({ secondsLeft: 59n });
  assert.equal(!late.dispute && late.reason, "TOO_LATE");
  assert.equal(decide({ secondsLeft: 60n }).dispute, true);
  assert.equal(decide({ secondsLeft: -5n }).dispute, false);
});

test("an Invalid proposal is protected against with the cost basis, and disputed with an explicit side", () => {
  const e = { yes: 0n, no: 900_000_000n, costBasis: 100n };
  assert.equal(payoutFor(e, "Invalid"), 100n);
  assert.equal(protectedValue(e, "Invalid", "No"), 900_000_000n - 100n);
  assert.equal(protectedValue(e, "No", "Invalid"), 0n, "a refund is worse than the win the proposal gives");
  assert.equal(alternativeFor("Yes"), "Yes");
  assert.equal(alternativeFor("Invalid"), null);
});
