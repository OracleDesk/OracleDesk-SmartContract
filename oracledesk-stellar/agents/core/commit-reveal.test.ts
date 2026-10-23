import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommitRevealCoordinator,
  PendingCommitStore,
  type CommitRevealChainAdapter,
} from "./commit-reveal.js";
import { commitmentFor } from "./trace.js";

test("CommitRevealCoordinator never pins to IPFS during commit phase and reveals after ledger delay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "commit-reveal-"));
  const storePath = join(dir, "pending-commits.json");
  const store = new PendingCommitStore(storePath);

  const callOrder: string[] = [];
  const adapter: CommitRevealChainAdapter = {
    async commitTrace({ commitmentHex }) {
      callOrder.push(`commit:${commitmentHex.slice(0, 8)}`);
    },
    async executeAction({ traceHashHex }) {
      callOrder.push(`trade:${traceHashHex.slice(0, 8)}`);
    },
    async pinTraceJson(_json, traceHashHex) {
      callOrder.push(`pin:${traceHashHex.slice(0, 8)}`);
      return `ipfs://bafy-${traceHashHex.slice(0, 8)}`;
    },
    async revealTrace({ commitmentHex, traceHashHex, saltHex, cid }) {
      assert.equal(commitmentFor(traceHashHex, saltHex), commitmentHex);
      callOrder.push(`reveal:${cid}`);
    },
  };

  const coordinator = new CommitRevealCoordinator({
    store,
    adapter,
    minRevealDelaySecs: 30,
    minRevealLedgers: 2,
  });

  const rec = await coordinator.commitAndExecute(
    {
      agent: "trader",
      marketId: 12,
      action: "buy",
      reasoning: "private alpha edge",
      inputs: { yesBps: 3800 },
      timestamp: 1_750_000_000,
    },
    1_750_000_000,
    100,
  );

  // During Phase 1, IPFS pinning must NOT have occurred
  assert.equal(callOrder.length, 2);
  assert.match(callOrder[0], /^commit:/);
  assert.match(callOrder[1], /^trade:/);
  assert.equal(rec.revealed, false);

  // Verify 0600 permissions on the persisted pending store
  const mode = statSync(storePath).mode & 0o777;
  assert.equal(mode, 0o600);

  // Sweep before reveal window elapses -> nothing revealed
  const early = await coordinator.sweepAndRevealEligible(1_750_000_010, 101);
  assert.equal(early.length, 0);
  assert.equal(callOrder.length, 2);

  // Simulate restart + sweep after 30s and 2 ledgers -> pins to IPFS and reveals
  const restartedCoordinator = new CommitRevealCoordinator({
    store: new PendingCommitStore(storePath),
    adapter,
    minRevealDelaySecs: 30,
    minRevealLedgers: 2,
  });
  const revealed = await restartedCoordinator.sweepAndRevealEligible(1_750_000_035, 102);
  assert.equal(revealed.length, 1);
  assert.equal(revealed[0].revealed, true);
  assert.equal(callOrder.length, 4);
  assert.match(callOrder[2], /^pin:/);
  assert.match(callOrder[3], /^reveal:ipfs:\/\/bafy-/);
});
