# Reproducible Soroban contract release build image (#127).
# Digest-pinned base image + exact Rust & checksum-verified stellar-cli versions
# synchronized with `oracledesk-stellar/toolchain.env`.
FROM debian:bookworm-slim@sha256:4724b8cc51e33e398f0e2e15e18d5ec2851ff0c2280647e1310bc1642182655d

ARG TARGETARCH
ARG RUST_VERSION=1.93.1
ARG RUST_WASM_TARGET=wasm32v1-none
ARG STELLAR_CLI_VERSION=27.1.0
ARG STELLAR_CLI_SHA256_X86_64=9915fe63753d7154c26bb9e6410cf1d1ff9727a9b378e663c2790ab7a266af94
ARG STELLAR_CLI_SHA256_ARM64=750a8dcda225fab33c87fa0d0dc79936266ed62cd316245fba234f18aab385bd

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/cargo \
    SOURCE_DATE_EPOCH=1700000000 \
    CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/build=/build --remap-path-prefix=/cargo=/cargo" \
    PATH=/cargo/bin:/usr/local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN set -euo pipefail; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"; \
    rustup target add "${RUST_WASM_TARGET}"

RUN set -euo pipefail; \
    case "${TARGETARCH:-amd64}" in \
      amd64) \
        STELLAR_TRIPLE="x86_64-unknown-linux-gnu"; \
        STELLAR_SHA="${STELLAR_CLI_SHA256_X86_64}" \
        ;; \
      arm64) \
        STELLAR_TRIPLE="aarch64-unknown-linux-gnu"; \
        STELLAR_SHA="${STELLAR_CLI_SHA256_ARM64}" \
        ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/stellar.tgz \
      "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${STELLAR_TRIPLE}.tar.gz"; \
    echo "${STELLAR_SHA}  /tmp/stellar.tgz" | sha256sum -c -; \
    tar -xzf /tmp/stellar.tgz -C /usr/local/bin stellar; \
    chmod +x /usr/local/bin/stellar; \
    rm -f /tmp/stellar.tgz

WORKDIR /build
