/**
 * Resolver persistent storage key builder and ResolutionSpec XDR commitment
 * encoder (#111).
 */
import { createHash } from "node:crypto";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export type ResolverStorageVariant = "Price" | "Signers" | "State" | "Proposal";

export interface RevealedPriceSpec {
  kind: "price";
  reflector: string;
  asset: { tag: "Stellar" | "Other"; value: string };
  threshold: bigint;
  direction: "Above" | "AtOrAbove" | "Below" | "AtOrBelow";
  maxStaleness: bigint;
  liveUntilLedger?: number;
}

export interface RevealedSignersSpec {
  kind: "signers";
  signers: string[];
  threshold: number;
  disputeWindow: bigint;
  liveUntilLedger?: number;
}

export type RevealedSpec =
  | RevealedPriceSpec
  | RevealedSignersSpec
  | { kind: "none" }
  | { kind: "archived" };

/**
 * Encodes `DataKey::Price(marketId)` / `Signers(marketId)` / `State(marketId)` /
 * `Proposal(marketId)` as a Soroban `contracttype` enum tuple variant:
 * `scvVec([scvSymbol(variant), scvU64(marketId)])`.
 */
export function resolverKey(variant: ResolverStorageVariant, marketId: bigint): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(variant),
    nativeToScVal(marketId, { type: "u64" }),
  ]);
}

export function buildResolverLedgerKey(
  resolverId: string,
  variant: ResolverStorageVariant,
  marketId: bigint,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(resolverId).toScAddress(),
      key: resolverKey(variant, marketId),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function encodeSortedMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return xdr.ScVal.scvMap(
    sorted.map(([k, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val })),
  );
}

/**
 * Encodes a revealed `PriceConfig` or `SignerConfig` into its Soroban
 * `ResolutionSpec` `ScVal` (`scvVec([scvSymbol("Price"|"Signers"), scvMap(...)])`)
 * with map entries sorted by symbol bytes, matching `soroban-sdk` `to_xdr`.
 */
export function encodeResolutionSpecScVal(
  spec: RevealedPriceSpec | RevealedSignersSpec,
): xdr.ScVal {
  if (spec.kind === "price") {
    const assetScVal =
      spec.asset.tag === "Stellar"
        ? xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol("Stellar"),
            Address.fromString(spec.asset.value).toScVal(),
          ])
        : xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol("Other"),
            xdr.ScVal.scvSymbol(spec.asset.value),
          ]);
    const directionScVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(spec.direction)]);
    const structMap = encodeSortedMap([
      ["asset", assetScVal],
      ["direction", directionScVal],
      ["max_staleness", nativeToScVal(spec.maxStaleness, { type: "u64" })],
      ["reflector", Address.fromString(spec.reflector).toScVal()],
      ["threshold", nativeToScVal(spec.threshold, { type: "i128" })],
    ]);
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Price"), structMap]);
  }

  const signersScVal = xdr.ScVal.scvVec(
    spec.signers.map((s) => Address.fromString(s).toScVal()),
  );
  const structMap = encodeSortedMap([
    ["dispute_window", nativeToScVal(spec.disputeWindow, { type: "u64" })],
    ["signers", signersScVal],
    ["threshold", nativeToScVal(spec.threshold, { type: "u32" })],
  ]);
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Signers"), structMap]);
}

export function computeResolutionSpecHash(
  spec: RevealedPriceSpec | RevealedSignersSpec,
): Buffer {
  const scVal = encodeResolutionSpecScVal(spec);
  return createHash("sha256").update(scVal.toXDR()).digest();
}
