import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseAnnotationsToml,
  renderContractDoc,
  REPO_STELLAR_ROOT,
} from "./generate.mjs";

function loadFixture(contractName) {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_STELLAR_ROOT, "packages/bindings", contractName, "interface.json"), "utf8")
  );
  const annotations = parseAnnotationsToml(
    readFileSync(resolve(REPO_STELLAR_ROOT, "docs/reference", `${contractName}.annotations.toml`), "utf8")
  );
  return { manifest, annotations };
}

describe("gen-contract-docs", () => {
  it("renders_market_core_functions_with_docs", () => {
    const { manifest, annotations } = loadFixture("market-core");
    const md = renderContractDoc("market-core", manifest, annotations);
    assert.match(md, /### `buy`/);
    assert.match(md, /### `get_config`/);
    assert.match(md, /### `market_count`/);
    assert.match(md, /### `get_market`/);
    assert.match(md, /### `get_position`/);
    assert.match(md, /fn quote_buy\(/);
  });

  it("renders_error_codes_1_to_18", () => {
    const { manifest, annotations } = loadFixture("market-core");
    const md = renderContractDoc("market-core", manifest, annotations);
    for (let code = 1; code <= 18; code += 1) {
      assert.match(md, new RegExp(`\\| ${code} \\| \`[A-Za-z0-9_]+\` \\|`));
    }
  });

  it("renders_trade_event_topics_and_data", () => {
    const { manifest, annotations } = loadFixture("market-core");
    const md = renderContractDoc("market-core", manifest, annotations);
    assert.match(md, /### `Trade`/);
    assert.match(md, /\*\*Prefix topics:\*\*/);
    assert.match(md, /\*\*Topic fields:\*\*/);
    assert.match(md, /\*\*Data fields/);
    assert.match(md, /\*\*Indexer filter:\*\*/);
  });

  it("marks_imported_types_from_market_core", () => {
    const { manifest, annotations } = loadFixture("resolver");
    const md = renderContractDoc("resolver", manifest, annotations);
    assert.match(md, /### `Outcome`/);
    assert.match(md, /Imported from \[`market-core`\]\(\.\/market-core\.md#outcome\)/);
  });

  it("fails_on_unknown_annotation", () => {
    const { manifest, annotations } = loadFixture("reasoning-registry");
    annotations.functions["non_existent_fn"] = { caller: "anyone" };
    assert.throws(
      () => renderContractDoc("reasoning-registry", manifest, annotations),
      /unknown function "non_existent_fn"/i
    );
  });

  it("fails_on_missing_caller_annotation", () => {
    const { manifest, annotations } = loadFixture("reasoning-registry");
    delete annotations.functions["is_registered"];
    assert.throws(
      () => renderContractDoc("reasoning-registry", manifest, annotations),
      /Missing required "caller" annotation for function "is_registered"/
    );
  });

  it("output_is_deterministic", () => {
    const { manifest, annotations } = loadFixture("market-core");
    const first = renderContractDoc("market-core", manifest, annotations);
    const second = renderContractDoc("market-core", manifest, annotations);
    assert.equal(first, second);
  });
});
