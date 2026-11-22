# Hermetic OracleDesk development container (#135).
# Base image digest pinned for reproducible container builds (debian:bookworm-slim).
FROM debian:bookworm-slim@sha256:4724b8cc51e33e398f0e2e15e18d5ec2851ff0c2280647e1310bc1642182655d

ARG TARGETARCH
ARG RUST_VERSION=1.93.1
ARG RUST_WASM_TARGET=wasm32v1-none
ARG STELLAR_CLI_VERSION=27.1.0
ARG STELLAR_CLI_SHA256_X86_64=9915fe63753d7154c26bb9e6410cf1d1ff9727a9b378e663c2790ab7a266af94
ARG STELLAR_CLI_SHA256_ARM64=750a8dcda225fab33c87fa0d0dc79936266ed62cd316245fba234f18aab385bd
ARG NODE_VERSION=24.13.1
ARG JQ_VERSION=1.7.1
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:/usr/local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      libdbus-1-dev \
      libudev-dev \
      make \
      pkg-config \
      python3 \
      python3-pip \
      shellcheck \
      sudo \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install pinned jq binary (x86_64 / arm64).
RUN set -euo pipefail; \
    case "${TARGETARCH:-amd64}" in \
      amd64) JQ_ARCH="amd64" ;; \
      arm64) JQ_ARCH="arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/jq \
      "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-${JQ_ARCH}"; \
    chmod +x /usr/local/bin/jq

# Install pinned Node.js binary (x86_64 / arm64).
RUN set -euo pipefail; \
    case "${TARGETARCH:-amd64}" in \
      amd64) NODE_ARCH="x64" ;; \
      arm64) NODE_ARCH="arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    mkdir -p /usr/local/node; \
    tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local/node; \
    rm -f /tmp/node.tar.xz

# Install exact pinned Rust toolchain + wasm32v1-none target + rustfmt + clippy.
RUN set -euo pipefail; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"; \
    rustup target add "${RUST_WASM_TARGET}"; \
    rustup component add rustfmt clippy

# Install checksum-verified stellar-cli release binary (no source compilation).
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

# Create non-root developer user with writable cargo/npm cache directories.
RUN groupadd --gid "${USER_GID}" "${USERNAME}" \
    && useradd --uid "${USER_UID}" --gid "${USER_GID}" -m -s /bin/bash "${USERNAME}" \
    && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}" \
    && mkdir -p /home/${USERNAME}/.cargo /home/${USERNAME}/.npm \
    && chown -R "${USER_UID}:${USER_GID}" /home/${USERNAME} /usr/local/cargo /usr/local/rustup

USER ${USERNAME}
WORKDIR /workspaces/OracleDesk-SmartContract
