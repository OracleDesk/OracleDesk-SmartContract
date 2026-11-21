# Fuzzing

The fuzz targets use `libfuzzer-sys`, which needs a nightly compiler:

```bash
cargo +nightly fuzz build
cargo +nightly fuzz run <target>
```

`fuzz/` is a standalone Cargo workspace. Its lockfile must resolve the Soroban family to the same versions as the root workspace. `make check-lockfiles` checks this.

`fuzz/src/lib.rs` refers to this file. The nightly is not pinned yet. Pinning it is a follow-up.
