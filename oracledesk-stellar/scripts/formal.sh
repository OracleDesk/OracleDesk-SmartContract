#!/usr/bin/env bash
# Model-checks docs/formal/resolver.tla with TLC.
#
#   make formal                       # skips (exit 0) when Java is missing
#   TLA2TOOLS=/path/tla2tools.jar make formal
#
# Every config has an *expected* TLC exit code: 0 means "no error found",
# 12 an invariant violation and 13 a temporal/action-property violation. The
# expected violations are the documented counterexamples (docs/formal/README.md),
# so this script fails when a config's outcome changes in either direction.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/docs/formal"
TOOLS_DIR="$DIR/.tools"
JAR="${TLA2TOOLS:-$TOOLS_DIR/tla2tools.jar}"
# Tested with TLC 2026.10.15 (rev 932d35e). The release asset is rolling, so
# set TLA2TOOLS to a jar you trust to pin it.
JAR_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"

if ! command -v java >/dev/null 2>&1; then
  echo "formal: java not found, skipping model check (install a JRE 11+ to run it)"
  exit 0
fi
if [ ! -f "$JAR" ]; then
  if [ -n "${TLA2TOOLS:-}" ]; then
    echo "formal: TLA2TOOLS=$TLA2TOOLS does not exist" >&2
    exit 1
  fi
  command -v curl >/dev/null 2>&1 || { echo "formal: curl missing, skipping"; exit 0; }
  mkdir -p "$TOOLS_DIR"
  echo "formal: downloading tla2tools.jar to $TOOLS_DIR"
  curl -fsSL -o "$JAR" "$JAR_URL"
fi

# config  expected-exit  what it demonstrates
CONFIGS=(
  "resolver                0  safety invariants + properties hold (signers, price, guardian, expiry)"
  "resolver_both_outcomes  0  signers backing both outcomes cannot reset a pending proposal"
  "resolver_live           0  honest signers => eventually Resolved (fair scheduler, no guardian)"
  "resolver_cancel        12  cancel_proposal can strand a quorum (NoStrandedQuorum)"
  "resolver_invalid       13  an Invalid quorum displaces a pending Yes/No proposal (intended)"
  "resolver_bypass        12  admin resolver swap breaks ResolvedOutcomeHadThreshold (trust)"
  "resolver_live_invalid  13  dishonest Invalid quorum defeats liveness (intended)"
)

META="$(mktemp -d)"
trap 'rm -rf "$META"' EXIT
fail=0
cd "$DIR"
for row in "${CONFIGS[@]}"; do
  read -r cfg want desc <<<"$row"
  start=$(date +%s)
  set +e
  out=$(java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config "$cfg.cfg" resolver.tla \
        -workers auto -noGenerateSpecTE -metadir "$META/$cfg" 2>&1)
  got=$?
  set -e
  states=$(grep -E "distinct states found" <<<"$out" | tail -1 | sed -E 's/.*, ([0-9,]+) distinct states found.*/\1/')
  verdict=$(grep -E "is violated|was violated|No error has been found" <<<"$out" | head -1)
  if [ "$got" -eq "$want" ]; then status=ok; else status=FAIL; fail=1; fi
  printf '%-4s %-22s exit=%-2s (want %-2s) %7ss  %s distinct states\n     %s\n     %s\n' \
    "$status" "$cfg" "$got" "$want" "$(( $(date +%s) - start ))" "${states:-?}" "$desc" "$verdict"
  if [ "$status" = FAIL ]; then echo "$out" | tail -30; fi
done
exit "$fail"
