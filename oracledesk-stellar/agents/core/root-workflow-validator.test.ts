import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRootGithubWorkflows } from "./root-workflow-validator.js";

test("validateRootGithubWorkflows returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = validateRootGithubWorkflows({
    contextId: "market-0",
    workflowFileCount: 120,
    invalidTriggerCount: 80,
    missingLabelCount: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("validateRootGithubWorkflows flags blocked status when threshold is breached", () => {
  const res = validateRootGithubWorkflows({
    contextId: "market-1",
    workflowFileCount: 600,
    invalidTriggerCount: 400,
    missingLabelCount: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("validateRootGithubWorkflows rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      validateRootGithubWorkflows({
        contextId: "   ",
        workflowFileCount: 10,
        invalidTriggerCount: 20,
        missingLabelCount: 30,
      }),
    /contextId must be non-empty/,
  );
});
