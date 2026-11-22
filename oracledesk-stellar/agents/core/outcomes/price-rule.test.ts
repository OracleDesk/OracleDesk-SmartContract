import assert from "node:assert/strict";
import test from "node:test";
import { compare, marginConfidenceBps, MAX_LOOKBACK_RECORDS, PRICE_MAX_CONFIDENCE_BPS, PriceRuleSource, readOnGrid, type ReflectorReader } from "./price-rule.js";
import { parsePriceQuestion, type PriceQuestion } from "./question.js";
import type { WatchedMarket } from "./types.js";

const asset = { tag: "Other" as const, value: "BTC" };
const question = (over: Partial<PriceQuestion> = {}): PriceQuestion => ({
  reflector: "CREFLECTOR",
  asset,
  threshold: "10000000",
  direction: "Above",
  closeTime: "1000",
  maxStaleness: "600",
  ...over,
});
const market: WatchedMarket = { marketId: 1n, metaUri: "ipfs://q", closeTime: 1000n, proposal: { outcome: "Yes", proposedAt: 1100n } };

/** A feed with records at the given grid timestamps. */
function feed(resolution: number, records: Record<string, bigint>, reads: bigint[] = []): ReflectorReader {
  return {
    resolution: async () => resolution,
    price: async (_a, ts) => {
      reads.push(ts);
      const price = records[ts.toString()];
      return price === undefined ? undefined : { price, timestamp: ts };
    },
  };
}
const source = (f: ReflectorReader, q = question(), opts = {}) =>
  new PriceRuleSource({ loadQuestion: async () => q, reflector: () => f, ...opts });
const signal = new AbortController().signal;

test("reads the record on the close-time grid: close_time rounded down to the oracle's resolution", async () => {
  const reads: bigint[] = [];
  const f = feed(300, { "900": 11_000_000n }, reads);
  const v = await source(f).determine(market, signal);
  assert.deepEqual(reads, [900n], "1000 - 1000 % 300 = 900");
  assert.equal(v?.outcome, "Yes");
  assert.equal(v?.evidence.recordTimestamp, "900");
});

test("walks back one grid step at a time while the record is still within max_staleness", async () => {
  const reads: bigint[] = [];
  const f = feed(300, { "600": 9_000_000n }, reads);
  const v = await source(f).determine(market, signal);
  assert.deepEqual(reads, [900n, 600n]);
  assert.equal(v?.outcome, "No");
});

test("stops at max_staleness and at the lookback cap, like the resolver", async () => {
  const stale = await readOnGrid(feed(300, { "0": 5n }), question({ closeTime: "1000", maxStaleness: "600" }), 1000n);
  assert.equal(stale, undefined, "ts 600 is the last candidate: 1000 - 600 + 300 = 700 > 600 stops before ts 300");
  const reads: bigint[] = [];
  await readOnGrid(feed(1, {}, reads), question({ maxStaleness: "1000000" }), 5_000n);
  assert.equal(reads.length, MAX_LOOKBACK_RECORDS);
});

test("a missing close-time record gives zero confidence, so it can never trigger a dispute", async () => {
  const v = await source(feed(300, {})).determine(market, signal);
  assert.equal(v?.confidenceBps, 0);
  assert.match(String(v?.evidence.reason), /no record/);
});

test("a non-positive price or a record after close is rejected like validate_price", async () => {
  assert.equal(await readOnGrid(feed(300, { "900": 0n }), question(), 1000n), undefined);
  const late: ReflectorReader = { resolution: async () => 300, price: async () => ({ price: 5n, timestamp: 1001n }) };
  assert.equal(await readOnGrid(late, question(), 1000n), undefined);
});

test("direction semantics match the resolver for each comparison and the boundary", () => {
  assert.equal(compare("Above", 10n, 10n), "No");
  assert.equal(compare("AtOrAbove", 10n, 10n), "Yes");
  assert.equal(compare("Below", 10n, 10n), "No");
  assert.equal(compare("AtOrBelow", 10n, 10n), "Yes");
  assert.equal(compare("Below", 9n, 10n), "Yes");
});

test("a price within one tick of the threshold has no confidence; further away it grows to the cap", () => {
  const T = 10_000_000n;
  assert.equal(marginConfidenceBps(T + 1n, T, 1n, 100), 0, "one tick above");
  assert.equal(marginConfidenceBps(T - 1n, T, 1n, 100), 0, "one tick below");
  assert.equal(marginConfidenceBps(T, T, 1n, 100), 0, "exactly on it");
  const near = marginConfidenceBps(T + 2n, T, 1n, 100);
  assert.ok(near >= 5_000 && near < 5_100, `just past the tick starts near 5000, got ${near}`);
  const mid = marginConfidenceBps(T + T / 200n, T, 1n, 100); // 0.5%
  assert.ok(mid > near && mid < PRICE_MAX_CONFIDENCE_BPS);
  assert.equal(marginConfidenceBps(T + T / 100n, T, 1n, 100), PRICE_MAX_CONFIDENCE_BPS, "1% clear");
  assert.equal(marginConfidenceBps(T * 2n, T, 1n, 100), PRICE_MAX_CONFIDENCE_BPS);
});

test("decimals: the same relative margin gives the same confidence at any feed precision", () => {
  const a = marginConfidenceBps(1_005_000_000_000_000n, 1_000_000_000_000_000n, 1n, 100); // 14 decimals
  const b = marginConfidenceBps(10_050_000n, 10_000_000n, 1n, 100); // 7 decimals
  assert.equal(a, b);
});

test("end to end: a price just past the threshold yields the right outcome but too little confidence to dispute", async () => {
  const v = await source(feed(300, { "900": 10_000_001n })).determine(market, signal);
  assert.equal(v?.outcome, "Yes");
  assert.equal(v?.confidenceBps, 0);
  const clear = await source(feed(300, { "900": 5_000_000n })).determine(market, signal);
  assert.equal(clear?.outcome, "No");
  assert.equal(clear?.confidenceBps, PRICE_MAX_CONFIDENCE_BPS);
});

test("no metadata price question means no opinion", async () => {
  const none = new PriceRuleSource({ loadQuestion: async () => undefined, reflector: () => feed(300, {}) });
  assert.equal(await none.determine(market, signal), undefined);
  assert.equal(none.supports({ ...market, metaUri: undefined }), false);
});

test("parsePriceQuestion accepts a well-formed block and rejects malformed ones", () => {
  const ok = parsePriceQuestion({ price_question: { reflector: "C1", asset: { tag: "Other", value: "BTC" }, threshold: "100", direction: "AtOrBelow", closeTime: 5, maxStaleness: "60" } });
  assert.deepEqual(ok, { reflector: "C1", asset: { tag: "Other", value: "BTC" }, threshold: "100", direction: "AtOrBelow", closeTime: "5", maxStaleness: "60" });
  assert.equal(parsePriceQuestion({}), undefined);
  assert.equal(parsePriceQuestion({ price_question: { reflector: "C1", asset, threshold: "1.5", direction: "Above", closeTime: 1, maxStaleness: 1 } }), undefined);
  assert.equal(parsePriceQuestion({ price_question: { reflector: "C1", asset, threshold: "1", direction: "Sideways", closeTime: 1, maxStaleness: 1 } }), undefined);
});
