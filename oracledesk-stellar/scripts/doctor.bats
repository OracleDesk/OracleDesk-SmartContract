#!/usr/bin/env bats
# Unit tests for scripts/doctor.sh using stubbed tool binaries (#135).

setup() {
  TEST_BIN="$(mktemp -d)"
  SCRIPT="${BATS_TEST_DIRNAME}/doctor.sh"

  cat > "${TEST_BIN}/rustc" <<'EOF'
#!/usr/bin/env bash
echo "rustc 1.93.1 (01f6ddf75 2026-02-11)"
EOF
  cat > "${TEST_BIN}/rustup" <<'EOF'
#!/usr/bin/env bash
echo "wasm32v1-none"
EOF
  cat > "${TEST_BIN}/stellar" <<'EOF'
#!/usr/bin/env bash
echo "stellar 27.1.0"
EOF
  cat > "${TEST_BIN}/node" <<'EOF'
#!/usr/bin/env bash
echo "v24.13.1"
EOF
  cat > "${TEST_BIN}/python3" <<'EOF'
#!/usr/bin/env bash
echo "Python 3.12.7"
EOF
  cat > "${TEST_BIN}/jq" <<'EOF'
#!/usr/bin/env bash
echo "jq-1.7.1"
EOF
  cat > "${TEST_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
echo "Docker version 27.0.0"
EOF
  chmod +x "${TEST_BIN}"/*
}

teardown() {
  rm -rf "${TEST_BIN}"
}

@test "doctor_passes_with_exact_versions" {
  run env CI=true PATH="${TEST_BIN}:${PATH}" bash "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"all required tools verified"* ]]
}

@test "doctor_fails_on_rust_mismatch" {
  cat > "${TEST_BIN}/rustc" <<'EOF'
#!/usr/bin/env bash
echo "rustc 1.94.0 (000000000 2026-04-01)"
EOF
  chmod +x "${TEST_BIN}/rustc"

  run env CI=true PATH="${TEST_BIN}:${PATH}" bash "${SCRIPT}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"rustc"* ]]
  [[ "$output" == *"expected 1.93.1"* ]]
}

@test "doctor_fails_without_wasm_target" {
  cat > "${TEST_BIN}/rustup" <<'EOF'
#!/usr/bin/env bash
echo "x86_64-unknown-linux-gnu"
EOF
  chmod +x "${TEST_BIN}/rustup"

  run env CI=true PATH="${TEST_BIN}:${PATH}" bash "${SCRIPT}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"wasm-target"* ]]
  [[ "$output" == *"rustup target add wasm32v1-none"* ]]
}

@test "doctor_soft_warns_on_newer_python" {
  cat > "${TEST_BIN}/python3" <<'EOF'
#!/usr/bin/env bash
echo "Python 3.14.5"
EOF
  chmod +x "${TEST_BIN}/python3"

  run env CI=true PATH="${TEST_BIN}:${PATH}" bash "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[WARN]"*"python3"* ]]
}
