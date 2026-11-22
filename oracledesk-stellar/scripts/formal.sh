#!/usr/bin/env bash
# Model-checks docs/formal/{resolver,governance}.tla with TLC.
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

# module  config  expected-exit  what it demonstrates
CONFIGS=(
  "resolver    resolver                  0  safety invariants + properties hold (signers, price, guardian, expiry)"
  "resolver    resolver_both_outcomes    0  signers backing both outcomes cannot reset a pending proposal"
  "resolver    resolver_live             0  honest signers => eventually Resolved (fair scheduler, no guardian)"
  "resolver    resolver_cancel          12  cancel_proposal can strand a quorum (NoStrandedQuorum)"
  "resolver    resolver_invalid         13  an Invalid quorum displaces a pending Yes/No proposal (intended)"
  "resolver    resolver_bypass          12  admin resolver swap breaks ResolvedOutcomeHadThreshold (trust)"
  "resolver    resolver_live_invalid    13  dishonest Invalid quorum defeats liveness (intended)"
  "governance  governance_admin         12  admin transfer: code accepts AT expires_at, ADR 0007 says inert (NoExpiredAccept)"
  "governance  governance_admin_aligned  0  admin transfer with the ADR's boundary: authorised and in time"
  "governance  governance_wiring_callback 13 wiring as deployed: callback re-enters the peer (WiringLiveness)"
  "governance  governance_wiring_peer_asserts 0 wiring with PeerAsserts: live and safe"
  "governance  governance_wiring_safety  0  only a consenting, correctly wired peer is ever wired"
  "governance  governance_stale_wiring  12  a PendingResolver never expires (StalePendingWiring witness)"
  "governance  governance_timelock       0  eta, expiry, cancel-wins and the emergency allow-list hold"
  "governance  governance_single_key    12  a compromised timelock admin key bypasses the watchdog (trust)"
  "governance  governance_selfadmin      0  timelock as its own admin: no single key has instant power"
)

# Deliberate bugs: each must make its property fail (exit 12), proving the
# property can actually fail. module  config  mutation  expected-exit
MUTATIONS=(
  "governance  governance_admin_aligned  accept_no_auth          12  accept_admin without require_auth"
  "governance  governance_timelock       execute_ignores_eta     12  execute ignores eta"
  "governance  governance_timelock       cancel_skips_removal    12  cancel leaves the operation in storage"
  "governance  governance_timelock       emergency_allows_all    12  emergency allow-list widened to everything"
)

META="$(mktemp -d)"
trap 'rm -rf "$META"' EXIT
fail=0
cd "$DIR"

# run <module> <cfg file> <label> <expected exit> <description>
run() {
  local mod=$1 cfgfile=$2 label=$3 want=$4 desc=$5
  local start out got states verdict status
  start=$(date +%s)
  set +e
  out=$(java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config "$cfgfile" "$mod.tla" \
        -workers auto -noGenerateSpecTE -metadir "$META/$label" 2>&1)
  got=$?
  set -e
  states=$(grep -E "distinct states found" <<<"$out" | tail -1 | sed -E 's/.*, ([0-9,]+) distinct states found.*/\1/')
  verdict=$(grep -E "is violated|was violated|No error has been found" <<<"$out" | head -1)
  if [ "$got" -eq "$want" ]; then status=ok; else status=FAIL; fail=1; fi
  printf '%-4s %-30s exit=%-2s (want %-2s) %7ss  %s distinct states\n     %s\n     %s\n' \
    "$status" "$label" "$got" "$want" "$(( $(date +%s) - start ))" "${states:-?}" "$desc" "$verdict"
  if [ "$status" = FAIL ]; then echo "$out" | tail -30; fi
}

for row in "${CONFIGS[@]}"; do
  read -r mod cfg want desc <<<"$row"
  run "$mod" "$cfg.cfg" "$cfg" "$want" "$desc"
done

# FORMAL_MUTATIONS=0 skips the mutation checks.
if [ "${FORMAL_MUTATIONS:-1}" != 0 ]; then
  echo "-- mutation checks (each deliberate bug must be caught)"
  for row in "${MUTATIONS[@]}"; do
    read -r mod cfg mutation want desc <<<"$row"
    mcfg="$META/$cfg.$mutation.cfg"
    sed "s/Mutation = \"None\"/Mutation = \"$mutation\"/" "$cfg.cfg" > "$mcfg"
    grep -q "Mutation = \"$mutation\"" "$mcfg" || { echo "FAIL $cfg: no Mutation line to rewrite" >&2; fail=1; continue; }
    run "$mod" "$mcfg" "$cfg+$mutation" "$want" "$desc"
  done
fi
exit "$fail"
