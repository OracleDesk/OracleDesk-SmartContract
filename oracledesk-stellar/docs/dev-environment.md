# Hermetic Development Environment

OracleDesk commits compiled cross-contract WASM artifacts (`contracts/resolver/market_core.wasm`, `contracts/treasury/market_core.wasm`, etc.) and TypeScript bindings. To keep local and CI builds byte-identical, all tool versions are pinned in a single file: `oracledesk-stellar/toolchain.env`.

## 1. Dev Container / GitHub Codespaces (Recommended)

Open the repository in VS Code (with the Dev Containers extension) or launch a GitHub Codespace. `.devcontainer/devcontainer.json` builds `.devcontainer/Dockerfile` using a digest-pinned Debian base image, installs the exact Rust toolchain (`wasm32v1-none`, `rustfmt`, `clippy`), verifies the `stellar-cli` release binary against its SHA-256 digest (for both `amd64` and `arm64`), and runs `make doctor && make setup`.

- **Named volume caches**: Cargo registry, Cargo git, and npm caches persist across rebuilds. Cargo `target/` is intentionally kept inside the workspace rather than shared across branches so vendored WASM outputs cannot bleed between branches.
- **Docker-outside-of-Docker**: Enabled so `stellar container start local` works from inside the container. Note that access to the host Docker socket carries host-root-equivalent privileges; only enable it on trusted development machines.
- **Stellar identities**: `~/.config/stellar` is **not** mounted by default so personal or testnet keys are not exposed automatically. To opt in, add a bind mount in your local VS Code user devcontainer settings.

## 2. Nix Flake

```bash
nix develop
cd oracledesk-stellar && make doctor && make setup
```

`flake.nix` pins `nixpkgs`, `rust-overlay`, and `flake-utils` to provide the identical Rust, `stellar-cli`, Node, Python, `jq`, `shellcheck`, and `bash` versions. On NixOS/Linux, `autoPatchelfHook` patches dynamic library paths (`dbus`, `systemd`/`libudev`, `openssl`) on the prebuilt `stellar-cli` binary.

## 3. Manual Setup & `make doctor`

If you manage tools directly on your host (or WSL):

```bash
cd oracledesk-stellar
make doctor                 # checks versions against toolchain.env
make check-toolchain-sync   # verifies toolchain.env matches Dockerfile, flake.nix, rust-toolchain.toml
```

`make doctor` exits non-zero on hard version mismatches (Rust, `wasm32v1-none`, Stellar CLI, Node, `jq`, Bash) and soft-warns when Python is newer than the pinned minor (as long as Python ≥ 3.10) or when Docker/Podman is absent.

## Bumping Toolchain Versions

1. Edit `oracledesk-stellar/toolchain.env` (including the `stellar-cli` x86_64 and arm64 SHA-256 digests).
2. Update `oracledesk-stellar/rust-toolchain.toml`, `oracledesk-stellar/stellar-cli.version`, `.devcontainer/Dockerfile`, and `flake.nix`.
3. Run `make check-toolchain-sync` to confirm zero drift.
4. Rebuild vendored WASM and bindings (`make build && make bindings`) in the updated container and commit the refreshed artifacts alongside the toolchain bump.
