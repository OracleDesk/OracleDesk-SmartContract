/**
 * JSON-safe model of the resolver's legacy `ResolutionSpec::{Signers, Price}`
 * (contracts/resolver, `oracledesk-types`). The market-maker commits to one
 * of these at creation (`resolution_hash = sha256(XDR(spec))`) and reveals it
 * right after through `register_signer_spec` / `register_price_spec`. See
 * docs/adr/0001-resolution-commitment.md, "Agent flow and recovery".
 *
 * Every u64/i128 is a decimal string so a stored spec round-trips through
 * JSON without precision loss.
 */
import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";

export type PriceDirectionJson = "above" | "at-or-above" | "below" | "at-or-below";

export type SpecJson =
  | { mode: "signers"; signers: string[]; threshold: number; disputeWindow: string }
  | {
      mode: "price";
      reflector: string;
      asset: { stellar: string } | { other: string };
      threshold: string;
      direction: PriceDirectionJson;
      maxStaleness: string;
    };

/** Shape of the generated `SignerConfig` binding type. */
export interface SignerConfigArg {
  signers: string[];
  threshold: number;
  dispute_window: bigint;
}

/** Shape of the generated `PriceConfig` binding type. */
export interface PriceConfigArg {
  reflector: string;
  asset: { tag: "Stellar"; values: readonly [string] } | { tag: "Other"; values: readonly [string] };
  threshold: bigint;
  direction: { tag: "Above" | "AtOrAbove" | "Below" | "AtOrBelow"; values: void };
  max_staleness: bigint;
}

export class InvalidSpecError extends Error {
  constructor(message: string) {
    super(`invalid resolution spec: ${message}`);
    this.name = "InvalidSpecError";
  }
}

const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I128_MAX = (1n << 127n) - 1n;
const DIRECTIONS: Record<PriceDirectionJson, PriceConfigArg["direction"]["tag"]> = {
  above: "Above",
  "at-or-above": "AtOrAbove",
  below: "Below",
  "at-or-below": "AtOrBelow",
};

function isAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

function parseUint(name: string, value: string, max: bigint): bigint {
  if (!/^\d+$/.test(value)) throw new InvalidSpecError(`${name} must be a decimal integer, got '${value}'`);
  const n = BigInt(value);
  if (n > max) throw new InvalidSpecError(`${name} ${value} is out of range`);
  return n;
}

function parseI128(name: string, value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new InvalidSpecError(`${name} must be a decimal integer, got '${value}'`);
  const n = BigInt(value);
  if (n > I128_MAX || n < -I128_MAX - 1n) throw new InvalidSpecError(`${name} ${value} is out of range`);
  return n;
}

/**
 * Canonical signer order: lexicographic by strkey. `Vec` order is part of
 * the XDR, so hashing and revealing must both use this exact order or the
 * reveal fails with `SpecHashMismatch`. Returns a new spec; never mutates.
 */
export function canonicalizeSpec(spec: SpecJson): SpecJson {
  if (spec.mode !== "signers") return spec;
  return { ...spec, signers: [...spec.signers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

/**
 * Mirrors the resolver's `validate_rule` (`InvalidConfig`, #3) exactly —
 * signers: non-empty, `0 < threshold <= len`, `dispute_window > 0`; price:
 * `threshold >= 0`, `max_staleness > 0` — plus the type-level checks the
 * contract gets for free (address strkeys, integer ranges, symbol shape).
 */
export function validateSpec(spec: SpecJson): void {
  if (spec.mode === "signers") {
    if (!Array.isArray(spec.signers) || spec.signers.length === 0) {
      throw new InvalidSpecError("signers must be non-empty");
    }
    for (const signer of spec.signers) {
      if (!isAddress(signer)) throw new InvalidSpecError(`signer '${signer}' is not a G... or C... address`);
    }
    if (!Number.isInteger(spec.threshold) || BigInt(spec.threshold) > U32_MAX || spec.threshold < 0) {
      throw new InvalidSpecError(`threshold must be a u32, got ${spec.threshold}`);
    }
    if (spec.threshold === 0) throw new InvalidSpecError("threshold must be > 0");
    if (spec.threshold > spec.signers.length) {
      throw new InvalidSpecError(`threshold ${spec.threshold} exceeds ${spec.signers.length} signer(s)`);
    }
    if (parseUint("disputeWindow", spec.disputeWindow, U64_MAX) === 0n) {
      throw new InvalidSpecError("disputeWindow must be > 0");
    }
    return;
  }
  if (spec.mode === "price") {
    if (!StrKey.isValidContract(spec.reflector)) {
      throw new InvalidSpecError(`reflector '${spec.reflector}' is not a C... contract address`);
    }
    if ("stellar" in spec.asset) {
      if (!isAddress(spec.asset.stellar)) throw new InvalidSpecError(`asset '${spec.asset.stellar}' is not an address`);
    } else if ("other" in spec.asset) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(spec.asset.other)) {
        throw new InvalidSpecError(`asset symbol '${spec.asset.other}' is not a valid Soroban symbol`);
      }
    } else {
      throw new InvalidSpecError("asset must be { stellar } or { other }");
    }
    if (parseI128("threshold", spec.threshold) < 0n) throw new InvalidSpecError("price threshold must be >= 0");
    if (!(spec.direction in DIRECTIONS)) throw new InvalidSpecError(`unknown direction '${spec.direction}'`);
    if (parseUint("maxStaleness", spec.maxStaleness, U64_MAX) === 0n) {
      throw new InvalidSpecError("maxStaleness must be > 0");
    }
    return;
  }
  throw new InvalidSpecError(`unknown mode ${JSON.stringify((spec as { mode: unknown }).mode)}`);
}

/** argv for `scripts/spec-hash` (legacy, unsalted commitment). */
export function toSpecHashArgs(spec: SpecJson): string[] {
  const s = canonicalizeSpec(spec);
  if (s.mode === "signers") return ["signers", String(s.threshold), s.disputeWindow, ...s.signers];
  const asset = "stellar" in s.asset ? `stellar:${s.asset.stellar}` : `other:${s.asset.other}`;
  return ["price", s.reflector, asset, s.threshold, s.direction, s.maxStaleness];
}

/** The `register_signer_spec` / `register_price_spec` argument, in canonical order. */
export function toContractArg(spec: SpecJson): SignerConfigArg | PriceConfigArg {
  const s = canonicalizeSpec(spec);
  if (s.mode === "signers") {
    return { signers: s.signers, threshold: s.threshold, dispute_window: BigInt(s.disputeWindow) };
  }
  return {
    reflector: s.reflector,
    asset: "stellar" in s.asset ? { tag: "Stellar", values: [s.asset.stellar] } : { tag: "Other", values: [s.asset.other] },
    threshold: BigInt(s.threshold),
    direction: { tag: DIRECTIONS[s.direction], values: undefined },
    max_staleness: BigInt(s.maxStaleness),
  };
}

/**
 * `question_hash` for a market. Still sha256 of the raw question text;
 * canonical question metadata is a separate issue, so keep every caller
 * behind this one function.
 */
export function questionHashOf(question: string): Buffer {
  return createHash("sha256").update(question).digest();
}

/**
 * Signer markets need room for the dispute window after the agent creates
 * them: rejects a `closeTime` not strictly after
 * `now + dispute_window + marginSecs`.
 */
export function validateCloseTime(closeTime: bigint, nowSecs: number, spec: SpecJson, marginSecs = 60): void {
  const window = spec.mode === "signers" ? BigInt(spec.disputeWindow) : 0n;
  const min = BigInt(nowSecs) + window + BigInt(marginSecs);
  if (closeTime <= min) {
    throw new InvalidSpecError(`close_time ${closeTime} must be > now + dispute_window + margin (${min})`);
  }
}

/** Optional per-signal price rule (a signal about an oracle-tracked asset). */
export interface SignalPriceRule {
  asset: string;
  threshold: string;
  direction: PriceDirectionJson;
}

function parseAsset(value: string): { stellar: string } | { other: string } {
  if (value.startsWith("stellar:")) return { stellar: value.slice("stellar:".length) };
  if (value.startsWith("other:")) return { other: value.slice("other:".length) };
  throw new InvalidSpecError(`asset '${value}' must be stellar:<address> or other:<symbol>`);
}

/**
 * Builds the spec the market-maker commits to from its configuration:
 * `MM_SPEC_MODE=signers|price`, `MM_SIGNERS` (comma-separated, default
 * `defaultSigner`), `MM_SIGNER_THRESHOLD`, `MM_DISPUTE_WINDOW_SECS`, and for
 * price mode `MM_REFLECTOR`, `MM_ASSET`, `MM_PRICE_THRESHOLD`,
 * `MM_PRICE_DIRECTION`, `MM_MAX_STALENESS_SECS`. A signal carrying its own
 * price rule overrides the env asset/threshold/direction. The result is
 * validated and canonical.
 */
export function buildSpec(env: NodeJS.ProcessEnv, defaultSigner: string, priceRule?: SignalPriceRule): SpecJson {
  const mode = env.MM_SPEC_MODE ?? (priceRule ? "price" : "signers");
  let spec: SpecJson;
  if (mode === "signers") {
    const signers = (env.MM_SIGNERS ?? defaultSigner)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (new Set(signers).size !== signers.length) throw new InvalidSpecError("MM_SIGNERS has duplicates");
    spec = {
      mode: "signers",
      signers,
      threshold: Number(env.MM_SIGNER_THRESHOLD ?? 1),
      disputeWindow: env.MM_DISPUTE_WINDOW_SECS ?? "600",
    };
  } else if (mode === "price") {
    const asset = priceRule?.asset ?? env.MM_ASSET;
    const threshold = priceRule?.threshold ?? env.MM_PRICE_THRESHOLD;
    const direction = priceRule?.direction ?? env.MM_PRICE_DIRECTION;
    if (!env.MM_REFLECTOR || !asset || threshold === undefined || !direction) {
      throw new InvalidSpecError("price mode needs MM_REFLECTOR, MM_ASSET, MM_PRICE_THRESHOLD and MM_PRICE_DIRECTION");
    }
    spec = {
      mode: "price",
      reflector: env.MM_REFLECTOR,
      asset: parseAsset(asset),
      threshold,
      direction: direction as PriceDirectionJson,
      maxStaleness: env.MM_MAX_STALENESS_SECS ?? "300",
    };
  } else {
    throw new InvalidSpecError(`MM_SPEC_MODE must be signers or price, got '${mode}'`);
  }
  spec = canonicalizeSpec(spec);
  validateSpec(spec);
  return spec;
}
