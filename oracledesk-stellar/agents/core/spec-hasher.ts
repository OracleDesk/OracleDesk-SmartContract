/**
 * Computes the commitment (`resolution_hash`) for a {@link SpecJson}. The
 * reference implementation is the Rust `scripts/spec-hash` tool, which
 * delegates to the resolver crate itself and so cannot drift from the
 * contract. A pure-TypeScript library (`@oracledesk/resolution-spec`, a
 * separate issue) is preferred when installed; with `verify` both run and
 * must agree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalizeSpec, toSpecHashArgs, type SpecJson } from "./spec.js";

const execFileAsync = promisify(execFile);

export interface SpecHasher {
  /** Lowercase 64-hex sha256 commitment. */
  hash(spec: SpecJson): Promise<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Accepts exactly one non-empty output line of 64 lowercase hex chars. */
export function parseSpecHashOutput(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length !== 1 || !HEX64.test(lines[0]!.trim())) {
    throw new Error(`spec-hash: expected one line of 64 hex chars, got ${JSON.stringify(stdout)}`);
  }
  return lines[0]!.trim();
}

/**
 * Runs `scripts/spec-hash` without a shell: the prebuilt binary `bin`
 * (`SPEC_HASH_BIN`) if given, else `cargo run --quiet --manifest-path
 * <manifestPath> --`. Production images should ship the binary — the cargo
 * path needs a Rust toolchain at runtime.
 */
export class CliSpecHasher implements SpecHasher {
  private readonly timeoutMs: number;

  constructor(private readonly opts: { manifestPath: string; bin?: string; timeoutMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async hash(spec: SpecJson): Promise<string> {
    const args = toSpecHashArgs(spec);
    const [file, argv] = this.opts.bin
      ? [this.opts.bin, args]
      : ["cargo", ["run", "--quiet", "--manifest-path", this.opts.manifestPath, "--", ...args]];
    const { stdout } = await execFileAsync(file, argv, { timeout: this.timeoutMs, windowsHide: true });
    return parseSpecHashOutput(stdout);
  }
}

/** Wraps two hashers and fails unless they agree (`--verify-spec-hash`). */
export class VerifyingSpecHasher implements SpecHasher {
  constructor(
    private readonly primary: SpecHasher,
    private readonly reference: SpecHasher,
  ) {}

  async hash(spec: SpecJson): Promise<string> {
    const [a, b] = await Promise.all([this.primary.hash(spec), this.reference.hash(spec)]);
    if (a !== b) throw new Error(`spec hash disagreement: library=${a} cli=${b}`);
    return a;
  }
}

/** Library entry points accepted from `@oracledesk/resolution-spec`. */
type SpecLibrary = {
  legacySpecHash?: (spec: SpecJson) => string | Uint8Array | Promise<string | Uint8Array>;
  hashSpec?: (spec: SpecJson) => string | Uint8Array | Promise<string | Uint8Array>;
};

/** The TS library as a {@link SpecHasher}, or `undefined` when not installed. */
export async function loadLibrarySpecHasher(moduleName = "@oracledesk/resolution-spec"): Promise<SpecHasher | undefined> {
  let lib: SpecLibrary;
  try {
    lib = (await import(moduleName)) as SpecLibrary;
  } catch {
    return undefined;
  }
  const fn = lib.legacySpecHash ?? lib.hashSpec;
  if (!fn) return undefined;
  return {
    async hash(spec) {
      const out = await fn(canonicalizeSpec(spec));
      const hex = typeof out === "string" ? out.toLowerCase() : Buffer.from(out).toString("hex");
      if (!HEX64.test(hex)) throw new Error(`resolution-spec returned a malformed hash: ${hex}`);
      return hex;
    },
  };
}

/**
 * The library when installed (cross-checked against the CLI if `verify`),
 * otherwise the CLI alone.
 */
export async function createSpecHasher(opts: {
  manifestPath: string;
  bin?: string;
  verify?: boolean;
}): Promise<SpecHasher> {
  const cli = new CliSpecHasher({ manifestPath: opts.manifestPath, bin: opts.bin });
  const lib = await loadLibrarySpecHasher();
  if (!lib) return cli;
  return opts.verify ? new VerifyingSpecHasher(lib, cli) : lib;
}
