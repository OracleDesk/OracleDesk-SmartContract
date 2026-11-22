import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateV1Record, readRecord, writeRecordAtomic, type DeploymentRecordV1 } from "../src/record.ts";

describe("deployment record v2", () => {
  it("migrates_v1_record_preserving_keys", () => {
    const v1: DeploymentRecordV1 = {
      deployer: "GDEPLOYER123",
      agent: "GAGENT456",
      contracts: {
        usdc: "CUSDC1",
        market_core: "CMC2",
        resolver: "CRES3",
        treasury: "CTRS4",
        reasoning_registry: "CREG5",
      },
      wired: true,
      agent_registered: true,
      treasury_funded_amount: "10000000000000",
      last_deployed_at: "2026-09-21T00:00:00Z",
    };

    const v2 = migrateV1Record(v1, {
      market_core: { wasm_hash: "deadbeef", deployed_ledger: 12345, deploy_tx: "tx1" },
    });

    assert.equal(v2.schema, 2);
    assert.equal(v2.network, "testnet");
    assert.equal(v2.deployer, "GDEPLOYER123");
    assert.equal(v2.agent, "GAGENT456");
    assert.equal(v2.contracts.usdc, "CUSDC1");
    assert.equal(v2.contracts.market_core, "CMC2");
    assert.equal(v2.contracts.treasury, "CTRS4");
    assert.equal(v2.wired, true);
    assert.equal(v2.agent_registered, true);
    assert.equal(v2.treasury_funded_amount, "10000000000000");
    assert.equal(v2.contracts_meta["market_core"]?.wasm_hash, "deadbeef");
    assert.deepEqual(v2.history, []);
  });

  it("atomic_write_survives_crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "oracledesk-record-"));
    try {
      const recordPath = join(dir, "testnet.json");
      const initial = migrateV1Record({
        deployer: "GINITIAL",
        agent: "GAGENT",
        contracts: { market_core: "CMC_INITIAL" },
      });
      writeRecordAtomic(recordPath, initial);

      const updated = migrateV1Record({
        deployer: "GUPDATED",
        agent: "GAGENT",
        contracts: { market_core: "CMC_UPDATED" },
      });

      assert.throws(
        () => writeRecordAtomic(recordPath, updated, { simulateCrashBeforeRename: true }),
        /Simulated crash/
      );

      // Original record must remain completely intact and valid JSON after crash
      const surviving = readRecord(recordPath);
      assert.equal(surviving.deployer, "GINITIAL");
      assert.equal(surviving.contracts?.["market_core"], "CMC_INITIAL");
      assert.doesNotThrow(() => JSON.parse(readFileSync(recordPath, "utf8")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
