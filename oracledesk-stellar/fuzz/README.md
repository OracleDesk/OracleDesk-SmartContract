# Fuzzing

The fuzz targets use `libfuzzer-sys`, which needs a nightly compiler. The nightly is pinned in `toolchain.env` as `NIGHTLY_TOOLCHAIN`:

```bash
source toolchain.env
rustup toolchain install "$NIGHTLY_TOOLCHAIN" --profile minimal
cargo +"$NIGHTLY_TOOLCHAIN" fuzz build
cargo +"$NIGHTLY_TOOLCHAIN" fuzz run <target>
```

`fuzz/` is a standalone Cargo workspace. Its lockfile must resolve the Soroban family to the same versions as the root workspace. `make check-lockfiles` checks this.
