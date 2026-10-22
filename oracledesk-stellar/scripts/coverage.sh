#!/usr/bin/env bash
# Coverage for the whole repo: Rust contracts (cargo llvm-cov) and the TypeScript
# packages (c8). Outputs, all under coverage/:
#
#   rust.lcov x402.lcov agents.lcov   per-language reports, repo-relative paths
#   lcov.info                         the three merged
#   html/index.html                   genhtml if installed, else a built-in summary
#
# Needs: cargo-llvm-cov + the llvm-tools-preview rustup component, Node 20.19+/22.12+
# with `make setup` already run (the packages import the generated bindings).
# See coverage/README.md.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=coverage
TOOLS="python3 scripts/coverage-tools.py"
# Test code, the dependency graph and generated artifacts are not what we measure.
IGNORE='(/tests?/|/test\.rs|scripts/spec-hash|market_core\.wasm|/\.cargo/|/rustc/)'

mkdir -p "$OUT"

echo "== Rust: instrumented tests, market-core registered as wasm, then native"
# Accumulate both runs into one profile: wasm keeps the shipped artifact honest,
# native is the only way llvm-cov can see market-core code that resolver/treasury
# scenarios reach (the wasm VM produces no host coverage). A reduced search depth
# keeps the exhaustive treasury test (itself a rich source of coverage) quick.
# --ignore-run-fail: a failing test must not hide the report; the test job gates
# pass/fail, this one measures.
cargo llvm-cov clean --workspace
export TREASURY_SEARCH_DEPTH="${TREASURY_SEARCH_DEPTH:-3}"
cargo llvm-cov --no-report --workspace --ignore-run-fail
MARKET_CORE_IMPL=native cargo llvm-cov --no-report --workspace --ignore-run-fail
cargo llvm-cov report --lcov --output-path "$OUT/rust.raw.lcov" --ignore-filename-regex "$IGNORE"
$TOOLS rust-filter "$OUT/rust.raw.lcov" "$OUT/rust.lcov"

echo "== TypeScript: c8 over tsx --test"
for pkg in x402 agents; do
  (cd "$pkg" && npm run --silent coverage >/dev/null)
  $TOOLS ts-rebase "$pkg" "$OUT/$pkg/lcov.info" "$OUT/$pkg.lcov"
done

echo "== Merge and report"
$TOOLS merge "$OUT/lcov.info" "$OUT/rust.lcov" "$OUT/x402.lcov" "$OUT/agents.lcov"
if command -v genhtml >/dev/null 2>&1; then
  genhtml "$OUT/lcov.info" --output-directory "$OUT/html" --quiet --ignore-errors source,unmapped 2>/dev/null \
    || $TOOLS html "$OUT/lcov.info" "$OUT/html"
else
  $TOOLS html "$OUT/lcov.info" "$OUT/html"
fi
echo
$TOOLS summary "$OUT/lcov.info" | tee "$OUT/summary.md"
echo
echo "report: $OUT/html/index.html   merged: $OUT/lcov.info"
