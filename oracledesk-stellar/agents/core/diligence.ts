/**
 * Trader pre-trade due diligence: verifies revealed resolution specs,
 * on-chain commitment hashes, operator oracle/signer allow-lists, off-chain
 * metadata integrity, and TTL/horizon safety (#111).
 */
import { createHash } from "node:crypto";
import {
  computeResolutionSpecHash,
  type RevealedPriceSpec,
  type RevealedSignersSpec,
  type RevealedSpec,
} from "./resolver-storage.js";

export type DiligenceCheckId =
  | "status_open"
  | "time_to_close"
  | "close_horizon"
  | "fee_bps_limit"
  | "spec_revealed"
  | "spec_commitment_match"
  | "allowlist_check"
  | "spec_ttl_health"
  | "metadata_hash_match";

export interface DiligenceCheckResult {
  id: DiligenceCheckId;
  pass: boolean;
  detail: string;
}

export interface DiligenceVerdict {
  marketId: string;
  pass: boolean;
  checkedAtLedger: number;
  checks: DiligenceCheckResult[];
  specKind: "price" | "signers" | "none";
  specHash?: string;
  verifiedQuestion?: string;
}

export interface SignerSetAllowlist {
  name: string;
  signers: string[];
  minThreshold: number;
}

export interface DiligencePolicy {
  /** Map of reflector contract ID -> allowed asset descriptors ("stellar:C..." or "other:BTC"). */
  reflectors: Record<string, string[]>;
  signerSets: SignerSetAllowlist[];
  maxCloseHorizonSecs: number;
  minTimeToCloseSecs: number;
  maxFeeBps?: number;
  maxPriceStalenessSecs?: bigint;
  minSpecTtlMarginLedgers?: number;
  metadataMaxBytes: number;
  metadataGateways: string[];
  allowedHttpsOrigins?: string[];
}

export interface DiligenceMarketInput {
  marketId: bigint | number;
  status: "Open" | "Closed" | "Resolved" | "Voided";
  closeTime: number;
  feeBps: number;
  questionHash: string;
  resolutionHash: string;
  metaUri: string;
}

export interface DiligenceContext {
  now: number;
  currentLedger: number;
  policy: DiligencePolicy;
  revealedSpec: RevealedSpec;
  fetchMetadataBytes: (url: string, maxBytes: number) => Promise<Uint8Array>;
}

const UNREVEALED_PLACEHOLDER_HASH = createHash("sha256")
  .update("unrevealed")
  .digest("hex");

function normalizeHex(h: string): string {
  return h.toLowerCase().replace(/^0x/, "");
}

function resolveMetadataUrl(metaUri: string, policy: DiligencePolicy): { ok: true; url: string } | { ok: false; reason: string } {
  if (metaUri.startsWith("local://")) {
    return { ok: false, reason: "local:// meta_uri is not verifiable off-host" };
  }
  if (metaUri.startsWith("ipfs://")) {
    const cidPath = metaUri.slice("ipfs://".length).replace(/^\/+/, "");
    if (!cidPath) {
      return { ok: false, reason: "empty ipfs:// CID" };
    }
    const gw = (policy.metadataGateways[0] ?? "https://ipfs.io/ipfs").replace(/\/+$/, "");
    return { ok: true, url: `${gw}/${cidPath}` };
  }
  if (metaUri.startsWith("https://")) {
    const allowed = policy.allowedHttpsOrigins ?? [];
    if (!allowed.some((origin) => metaUri.startsWith(origin))) {
      return { ok: false, reason: `https meta_uri origin not in allowedHttpsOrigins: ${metaUri}` };
    }
    return { ok: true, url: metaUri };
  }
  return { ok: false, reason: `unsupported meta_uri scheme: ${metaUri}` };
}

function checkAllowlist(
  spec: RevealedPriceSpec | RevealedSignersSpec,
  policy: DiligencePolicy,
): { pass: boolean; detail: string } {
  if (spec.kind === "price") {
    const allowedAssets = policy.reflectors[spec.reflector];
    if (!allowedAssets) {
      return { pass: false, detail: `reflector ${spec.reflector} is not allow-listed` };
    }
    const assetKey =
      spec.asset.tag === "Stellar" ? `stellar:${spec.asset.value}` : `other:${spec.asset.value}`;
    if (!allowedAssets.includes(assetKey)) {
      return {
        pass: false,
        detail: `asset ${assetKey} is not allow-listed on reflector ${spec.reflector}`,
      };
    }
    if (spec.threshold < 0n) {
      return { pass: false, detail: `negative price threshold ${spec.threshold}` };
    }
    const maxStale = policy.maxPriceStalenessSecs ?? 86_400n;
    if (spec.maxStaleness <= 0n || spec.maxStaleness > maxStale) {
      return {
        pass: false,
        detail: `price max_staleness ${spec.maxStaleness} outside (0, ${maxStale}]`,
      };
    }
    return { pass: true, detail: `reflector ${spec.reflector} (${assetKey}) allow-listed` };
  }

  // Signer spec checks: reject duplicate signers and require an allow-listed committee
  const unique = new Set(spec.signers);
  if (unique.size !== spec.signers.length) {
    return { pass: false, detail: "signer spec contains duplicate signers" };
  }
  if (spec.signers.length === 0 || spec.threshold < 1 || spec.threshold > spec.signers.length) {
    return { pass: false, detail: `invalid signer threshold ${spec.threshold}/${spec.signers.length}` };
  }

  for (const committee of policy.signerSets) {
    const committeeSet = new Set(committee.signers);
    const allInSet = spec.signers.every((s) => committeeSet.has(s));
    if (allInSet && spec.threshold >= committee.minThreshold) {
      return {
        pass: true,
        detail: `signers match committee "${committee.name}" (${spec.threshold}/${spec.signers.length})`,
      };
    }
  }
  return { pass: false, detail: "signers do not match any allow-listed signerSet or minThreshold" };
}

export async function assessMarket(
  market: DiligenceMarketInput,
  ctx: DiligenceContext,
): Promise<DiligenceVerdict> {
  const checks: DiligenceCheckResult[] = [];
  const { now, currentLedger, policy, revealedSpec } = ctx;

  // 1. Market status
  checks.push({
    id: "status_open",
    pass: market.status === "Open",
    detail: `market status is ${market.status}`,
  });

  // 2. Minimum time to close
  const secsToClose = market.closeTime - now;
  checks.push({
    id: "time_to_close",
    pass: secsToClose >= policy.minTimeToCloseSecs,
    detail: `time to close ${secsToClose}s (min ${policy.minTimeToCloseSecs}s)`,
  });

  // 3. Maximum close horizon
  checks.push({
    id: "close_horizon",
    pass: secsToClose <= policy.maxCloseHorizonSecs,
    detail: `close horizon ${secsToClose}s (max ${policy.maxCloseHorizonSecs}s)`,
  });

  // 4. Fee bps limit
  const maxFeeBps = policy.maxFeeBps ?? 500;
  checks.push({
    id: "fee_bps_limit",
    pass: market.feeBps >= 0 && market.feeBps <= maxFeeBps,
    detail: `fee_bps ${market.feeBps} (max ${maxFeeBps})`,
  });

  // 5. Spec revealed & not placeholder
  const normResHash = normalizeHex(market.resolutionHash);
  const isPlaceholder = normResHash === UNREVEALED_PLACEHOLDER_HASH;
  const specPresent =
    !isPlaceholder && (revealedSpec.kind === "price" || revealedSpec.kind === "signers");
  checks.push({
    id: "spec_revealed",
    pass: specPresent,
    detail: isPlaceholder
      ? "market uses unrevealed placeholder resolution_hash"
      : revealedSpec.kind === "archived"
        ? "resolver spec entry is archived or missing"
        : revealedSpec.kind === "none"
          ? "resolution spec has not been revealed in resolver storage"
          : `revealed ${revealedSpec.kind} spec present`,
  });

  let specHashHex: string | undefined;
  if (revealedSpec.kind === "price" || revealedSpec.kind === "signers") {
    // 6. Commitment match
    specHashHex = computeResolutionSpecHash(revealedSpec).toString("hex");
    const matches = specHashHex === normResHash;
    checks.push({
      id: "spec_commitment_match",
      pass: matches,
      detail: matches
        ? `recomputed spec hash matches ${normResHash}`
        : `recomputed spec hash ${specHashHex} != market resolution_hash ${normResHash}`,
    });

    // 7. Operator allow-list check
    const allow = checkAllowlist(revealedSpec, policy);
    checks.push({
      id: "allowlist_check",
      pass: allow.pass,
      detail: allow.detail,
    });

    // 8. Spec TTL health (~5s per ledger through closeTime + disputeWindow + margin)
    const disputeSecs =
      revealedSpec.kind === "signers" ? Number(revealedSpec.disputeWindow) : 0;
    const requiredSecs = Math.max(0, market.closeTime - now) + disputeSecs;
    const requiredLedgers =
      currentLedger +
      Math.ceil(requiredSecs / 5) +
      (policy.minSpecTtlMarginLedgers ?? 720);
    const liveUntil = revealedSpec.liveUntilLedger ?? 0;
    const ttlOk = liveUntil >= requiredLedgers;
    checks.push({
      id: "spec_ttl_health",
      pass: ttlOk,
      detail: `spec liveUntilLedger=${liveUntil}, required=${requiredLedgers}`,
    });
  } else {
    checks.push(
      {
        id: "spec_commitment_match",
        pass: false,
        detail: "cannot verify commitment without revealed spec",
      },
      {
        id: "allowlist_check",
        pass: false,
        detail: "cannot check allow-list without revealed spec",
      },
      {
        id: "spec_ttl_health",
        pass: false,
        detail: "cannot verify TTL without revealed spec",
      },
    );
  }

  // 9. Metadata fetch & hash verification
  let verifiedQuestion: string | undefined;
  const resolvedUrl = resolveMetadataUrl(market.metaUri, policy);
  if (!resolvedUrl.ok) {
    checks.push({
      id: "metadata_hash_match",
      pass: false,
      detail: resolvedUrl.reason,
    });
  } else {
    try {
      const rawBytes = await ctx.fetchMetadataBytes(resolvedUrl.url, policy.metadataMaxBytes);
      if (rawBytes.byteLength > policy.metadataMaxBytes) {
        checks.push({
          id: "metadata_hash_match",
          pass: false,
          detail: `metadata size ${rawBytes.byteLength} exceeds max ${policy.metadataMaxBytes}`,
        });
      } else {
        const actualQHash = createHash("sha256").update(rawBytes).digest("hex");
        const expectedQHash = normalizeHex(market.questionHash);
        if (actualQHash !== expectedQHash) {
          checks.push({
            id: "metadata_hash_match",
            pass: false,
            detail: `metadata sha256 ${actualQHash} != question_hash ${expectedQHash}`,
          });
        } else {
          // Parse safely stripping __proto__
          const text = Buffer.from(rawBytes).toString("utf8");
          try {
            const parsed = JSON.parse(text, (k, v) => (k === "__proto__" ? undefined : v)) as Record<
              string,
              unknown
            >;
            verifiedQuestion =
              typeof parsed.question === "string" ? parsed.question : text.trim();
          } catch {
            verifiedQuestion = text.trim();
          }
          checks.push({
            id: "metadata_hash_match",
            pass: true,
            detail: `verified question_hash ${actualQHash}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        id: "metadata_hash_match",
        pass: false,
        detail: `metadata fetch failed: ${(err as Error).message}`,
      });
    }
  }

  const pass = checks.every((c) => c.pass);
  const specKind =
    revealedSpec.kind === "price" || revealedSpec.kind === "signers"
      ? revealedSpec.kind
      : "none";

  return {
    marketId: String(market.marketId),
    pass,
    checkedAtLedger: currentLedger,
    checks,
    specKind,
    specHash: specHashHex,
    verifiedQuestion,
  };
}
