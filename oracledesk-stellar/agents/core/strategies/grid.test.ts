import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  boundaryFeedUnitsCheck,
} from "./grid-helpers.js";
import { comparePrice, readFeedOnGrid, rescale, twapOutcome, type Direction, type PriceData } from "./grid.js";

type Rec = Record<string, { price: string; timestamp: string }>;
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/vectors/price-grid-v1.json", import.meta.url), "utf8"),
) as {
  spot: { name: string; resolution: string; closeTime: string; maxStaleness: string; records: Rec; expect: Record<string, unknown> }[];
  twap: {
    name: string;
    resolution: string;
    closeTime: string;
    rule: { threshold: string; direction: Direction; window: string; minSamples: number; maxGap: string };
    records: Rec;
    expect: Record<string, unknown>;
  }[];
};

function lookup(records: Rec) {
  return (ts: bigint): PriceData | null => {
    const r = records[ts.toString()];
    return r ? { price: BigInt(r.price), timestamp: BigInt(r.timestamp) } : null;
  };
}

for (const v of vectors.spot)
  test(`grid vector (spot): ${v.name}`, () => {
    const r = readFeedOnGrid(lookup(v.records), BigInt(v.resolution), BigInt(v.maxStaleness), BigInt(v.closeTime));
    assert.deepEqual(r.queried.map(String), v.expect.queried);
    if (v.expect.ok) {
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.value.price.toString(), v.expect.price);
        assert.equal(r.value.timestamp.toString(), v.expect.timestamp);
      }
    } else {
      assert.deepEqual({ ok: r.ok, error: !r.ok && r.error }, { ok: false, error: v.expect.error });
    }
  });

for (const v of vectors.twap)
  test(`grid vector (twap): ${v.name}`, () => {
    const rule = {
      threshold: BigInt(v.rule.threshold),
      direction: v.rule.direction,
      window: BigInt(v.rule.window),
      minSamples: v.rule.minSamples,
      maxGap: BigInt(v.rule.maxGap),
    };
    const r = twapOutcome(lookup(v.records), rule, BigInt(v.resolution), BigInt(v.closeTime));
    assert.deepEqual(r.queried.map(String), v.expect.queried);
    if (v.expect.ok) {
      assert.ok(r.ok, r.ok ? "" : r.error);
      if (r.ok) {
        assert.equal(r.value.twap.toString(), v.expect.twap);
        assert.equal(r.value.samples.length, v.expect.samples);
        assert.equal(r.value.firstTs.toString(), v.expect.firstTs);
        assert.equal(r.value.lastTs.toString(), v.expect.lastTs);
        assert.equal(r.value.outcome, v.expect.outcome);
      }
    } else {
      assert.deepEqual({ ok: r.ok, error: !r.ok && r.error }, { ok: false, error: v.expect.error });
    }
  });

test("a throwing feed is PriceUnavailable, never an exception", () => {
  const boom = () => {
    throw new Error("rpc down");
  };
  const r = readFeedOnGrid(boom, 300n, 600n, 1000n);
  assert.deepEqual(r.ok ? null : r.error, "PriceUnavailable");
});

test("compare_price and rescale match the resolver", () => {
  assert.equal(comparePrice("Above", 10n, 10n), "No");
  assert.equal(comparePrice("AtOrAbove", 10n, 10n), "Yes");
  assert.equal(comparePrice("Below", 10n, 10n), "No");
  assert.equal(comparePrice("AtOrBelow", 10n, 10n), "Yes");
  // threshold 20 with 2 decimals vs a 7-decimal feed: both to 7 decimals.
  assert.deepEqual(rescale(123_456_789n, 7, 20n, 2), { price: 123_456_789n, threshold: 2_000_000n, decimals: 7 });
  assert.deepEqual(rescale(5n, 2, 123n, 4), { price: 500n, threshold: 123n, decimals: 4 });
});

test("boundary feed units agree with rescale + compare_price", () => {
  boundaryFeedUnitsCheck();
});
