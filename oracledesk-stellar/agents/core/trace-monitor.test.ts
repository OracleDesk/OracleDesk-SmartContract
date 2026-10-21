import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTrace } from "./trace.js";
import { LocalHashArchive, probeAndRecoverTrace } from "./trace-monitor.js";

test("probeAndRecoverTrace verifies hash and archives trace when primary gateway responds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-archive-"));
  const archive = new LocalHashArchive(dir);
  const { trace, json, hash } = buildTrace({
    agent: "trader",
    marketId: 3,
    action: "buy",
    reasoning: "edge 900 bps",
    inputs: { yesBps: 4100 },
    timestamp: 1_750_000_000,
  });
  void trace;

  const res = await probeAndRecoverTrace(
    { traceHash: hash, cid: "ipfs://bafybeigdyrzt" },
    {
      gateways: [
        {
          name: "pinata",
          async fetchByCid() {
            return json;
          },
        },
      ],
      archive,
    },
  );

  assert.equal(res.status, "available");
  assert.equal(res.resolvedFrom, "pinata");
  assert.equal(archive.load(hash), json);
});

test("probeAndRecoverTrace recovers from local archive and re-pins when gateways fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-archive-"));
  const archive = new LocalHashArchive(dir);
  const { json, hash } = buildTrace({
    agent: "maker",
    marketId: 9,
    action: "propose_market",
    reasoning: "seed market",
    inputs: { seed: 1000 },
    timestamp: 1_750_000_100,
  });
  archive.save(hash, json);

  const repinned: string[] = [];
  const res = await probeAndRecoverTrace(
    { traceHash: hash, cid: "ipfs://bafydead" },
    {
      gateways: [
        {
          name: "dead-gateway",
          async fetchByCid() {
            return null;
          },
        },
      ],
      archive,
      pinTargets: [
        {
          name: "web3storage-backup",
          async pinTrace(_raw, expected) {
            repinned.push(expected);
            return { cid: "bafyrepinned" };
          },
        },
      ],
    },
  );

  assert.equal(res.status, "recovered_and_repinned");
  assert.equal(res.resolvedFrom, "local-archive");
  assert.deepEqual(res.repinnedTo, ["web3storage-backup"]);
  assert.deepEqual(repinned, [hash]);
});

test("probeAndRecoverTrace detects content hash tampering across gateways", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-archive-"));
  const archive = new LocalHashArchive(dir);
  const { json, hash } = buildTrace({
    agent: "trader",
    marketId: 4,
    action: "buy",
    reasoning: "honest trace",
    inputs: { edge: 600 },
    timestamp: 1_750_000_200,
  });

  const tamperedJson = json.replace("honest trace", "tampered trace");
  const res = await probeAndRecoverTrace(
    { traceHash: hash, cid: "ipfs://bafytampered" },
    {
      gateways: [
        {
          name: "rogue-gateway",
          async fetchByCid() {
            return tamperedJson;
          },
        },
      ],
      archive,
    },
  );

  assert.equal(res.status, "hash_mismatch");
});
