import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMode } from "./mode.js";

describe("AGENT_MODE parser", () => {
  it("parseMode_defaults_to_dry_run", () => {
    assert.equal(parseMode(undefined), "dry-run");
    assert.equal(parseMode("dry-run"), "dry-run");
    assert.equal(parseMode("live"), "live");
  });

  it("parseMode_rejects_unknown_values", () => {
    assert.throws(() => parseMode(""), /AGENT_MODE must be/);
    assert.throws(() => parseMode("production"), /AGENT_MODE must be/);
    assert.throws(() => parseMode("LIVE"), /AGENT_MODE must be/);
    assert.throws(() => parseMode("dry_run"), /AGENT_MODE must be/);
  });
});
