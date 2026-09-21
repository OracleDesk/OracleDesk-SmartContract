.PHONY: setup build test lint fmt deploy-testnet seed-market demo bindings clean

# Installs Node dependencies for the TypeScript packages. Rust toolchain,
# the `stellar` CLI, and Python 3 are expected to already be on PATH — see
# README.md's Prerequisites section.
setup:
	cd x402 && npm ci
	cd agents && npm ci
	cd packages/bindings && npm ci

# Builds all four Soroban contracts to wasm via the Stellar CLI, keeping
# resolver/treasury's vendored copy of market-core.wasm in sync first (see
# docs/adr/0002-cross-contract-calls.md — contractimport! reads that copy at
# *their* compile time, so a stale copy silently keeps the old interface).
build:
	cargo build --workspace
	stellar contract build
	cp target/wasm32v1-none/release/market_core.wasm contracts/resolver/market_core.wasm
	cp target/wasm32v1-none/release/market_core.wasm contracts/treasury/market_core.wasm
	stellar contract build

test: build
	cargo test --workspace
	python3 model/fpmm_model.py
	cd x402 && npm test

lint:
	cargo fmt --check
	cargo clippy --workspace --all-targets -- -D warnings

fmt:
	cargo fmt

deploy-testnet: build
	./scripts/deploy-testnet.sh

seed-market:
	./scripts/seed-market.sh

demo:
	./scripts/demo.sh

bindings: build
	./scripts/gen-bindings.sh

clean:
	cargo clean
	rm -rf x402/node_modules agents/node_modules packages/bindings/node_modules
