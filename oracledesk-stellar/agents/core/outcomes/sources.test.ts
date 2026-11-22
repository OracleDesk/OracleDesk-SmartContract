import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { combineVerdicts, EvidenceTraceSource, ManualSource, type LinkedEvidence, type WatchedMarket } from "./index.js";

const market: WatchedMarket = { marketId: 7n, closeTime: 1000n, proposal: { outcome: "Yes", proposedAt: 1100n } };
const signal = new AbortController().signal;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const trace = (concluded: string) => JSON.stringify({ inputs: { concludedOutcome: concluded } });

function evidenceSource(traces: Record<string, string | undefined>, hashes: Record<string, string> = {}) {
  const linked: LinkedEvidence[] = Object.keys(traces).map((id, i) => ({
    signer: `S${i}`,
    attested: "Yes",
    traceId: BigInt(id),
    traceHash: hashes[id] ?? sha(traces[id] ?? ""),
  }));
  return new EvidenceTraceSource({ evidence: async () => linked, fetchTrace: async (e) => traces[e.traceId.toString()] });
}

test("combineVerdicts: agreement takes the lowest confidence; disagreement is a conflict, never a dispute", () => {
  const v = (outcome: "Yes" | "No", confidenceBps: number) => ({ outcome, confidenceBps, evidence: {} });
  const agree = combineVerdicts([{ source: "a", verdict: v("No", 9_900) }, { source: "b", verdict: v("No", 9_600) }, { source: "c", verdict: undefined }]);
  assert.equal(agree.kind, "agree");
  assert.equal(agree.kind === "agree" && agree.verdict.confidenceBps, 9_600);
  assert.equal(combineVerdicts([{ source: "a", verdict: v("No", 9_900) }, { source: "b", verdict: v("Yes", 9_900) }]).kind, "conflict");
  assert.equal(combineVerdicts([{ source: "a", verdict: undefined }]).kind, "none");
  assert.equal(combineVerdicts([]).kind, "none");
});

test("EvidenceTraceSource: verified traces vote, confidence comes from agreement", async () => {
  const v = await evidenceSource({ "1": trace("No"), "2": trace("No"), "3": trace("No") }).determine(market, signal);
  assert.equal(v?.outcome, "No");
  assert.equal(v?.confidenceBps, 9_500, "unanimous, capped");
  const split = await evidenceSource({ "1": trace("No"), "2": trace("No"), "3": trace("Yes") }).determine(market, signal);
  assert.equal(split?.outcome, "No");
  assert.equal(split?.confidenceBps, 6_666);
});

test("EvidenceTraceSource: a trace that does not hash to its on-chain record is excluded and lowers confidence", async () => {
  const s = evidenceSource({ "1": trace("No"), "2": trace("No"), "3": trace("No") }, { "3": sha("something else") });
  const v = await s.determine(market, signal);
  assert.equal(v?.outcome, "No");
  assert.equal(v?.confidenceBps, 6_666, "2 of 3 linked traces verified");
  assert.deepEqual((v?.evidence.rejected as { reason: string }[]).map((r) => r.reason), ["hash mismatch"]);
});

test("EvidenceTraceSource: too few verified traces, or a tie, give zero confidence", async () => {
  assert.equal((await evidenceSource({ "1": trace("No") }).determine(market, signal))?.confidenceBps, 0);
  assert.equal((await evidenceSource({ "1": trace("No"), "2": trace("Yes") }).determine(market, signal))?.confidenceBps, 0);
  assert.equal(await evidenceSource({ "1": undefined }).determine(market, signal), undefined, "nothing verifiable: no opinion");
});

test("ManualSource reads the operator file on every call and validates entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
  const path = join(dir, "watcher-verdicts.json");
  const src = new ManualSource(path);
  assert.equal(await src.determine(market), undefined, "no file: no opinion");
  writeFileSync(path, JSON.stringify({ "7": { outcome: "No", confidenceBps: 10_000, note: "ticket 12" } }));
  const v = await src.determine(market);
  assert.deepEqual([v?.outcome, v?.confidenceBps, v?.evidence.note], ["No", 10_000, "ticket 12"]);
  assert.equal(await src.determine({ ...market, marketId: 8n }), undefined);
  writeFileSync(path, JSON.stringify({ "7": { outcome: "Maybe", confidenceBps: 10_000 } }));
  await assert.rejects(() => src.determine(market), /invalid verdict/);
});
