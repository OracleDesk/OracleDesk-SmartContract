# Market Metadata Schema and Canonicalization

This document defines the versioned market metadata JSON schema, canonical byte encoding, and verification mechanisms. It ensures that question text, resolution criteria, and other metadata can be verifiably committed to on-chain via `Market.question_hash` and `Market.meta_uri`.

## Motivation

A prediction market is only as trustworthy as its question. `Market.question_hash` exists so that "a client can prove the text it shows is the text that was committed" (ADR 0001). In practice:

- No schema defines the off-chain metadata structure
- No canonical encoding is specified
- Multiple code paths create markets with inconsistent hashing
- Frontends, backends, indexers, and agents cannot verify question text matches the commitment
- Resolution criteria text (how `ResolutionSpec` applies) is not committed anywhere

This creates a gap: a malicious or careless creator could show users one wording while committing to another. This document closes that gap.

## Schema v1

The canonical market metadata is a versioned JSON object conforming to this schema:

```json
{
  "schema": "oracledesk.market-metadata/1",
  "question": "Will XLM close above $0.20 on 2026-12-31?",
  "description": "Optional longer explanation of the market question.",
  "category": "Crypto",
  "close_time": 1798675200,
  "resolution": {
    "mode": "price" | "signers" | "market",
    "criteria": "Resolves YES if Reflector XLM/USD price at close_time is strictly above 0.20 ...",
    "spec": {
      "reflector": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      "asset": "native",
      "threshold": 20,
      "direction": "above",
      "max_staleness": 3600
    },
    "resolution_hash": "abc123def456..."
  },
  "sources": [
    { "name": "Reflector XLM/USD", "url": "https://reflector.example.com" }
  ],
  "created_by": "GBRPYHIL2CI3WHZDTOOQFC6EB4LEGTRQ2YC4RMWTREQG5CUSTOMERNONCE",
  "language": "en"
}
```

## Field Definitions and Constraints

### Top-Level Fields

| Field | Type | Required | Constraint | Purpose |
|-------|------|----------|-----------|---------|
| `schema` | string | Yes | Must equal `"oracledesk.market-metadata/1"` | Schema versioning for future evolution |
| `question` | string | Yes | ≤ 280 characters, NFC-normalized | The market question traders are answering |
| `description` | string | No | ≤ 2000 characters | Longer explanation of question context |
| `category` | string | Yes | One of: Crypto, Macro, Geopolitics, Sports, Culture, Other | Market categorization matching `Category` enum |
| `close_time` | integer | Yes | UNIX timestamp, ≥ now | When the market stops accepting trades |
| `resolution` | object | Yes | Nested structure below | How the market will be resolved |
| `sources` | array | No | ≤ 10 objects, each ≤ 500 chars total | References for resolution (oracles, data sources) |
| `created_by` | string | Yes | Valid Stellar G-address | Creator's public key (for auditing) |
| `language` | string | No | ISO 639-1 code, default `"en"` | Language of question and description |

### Resolution Object Fields

| Field | Type | Required | Constraint | Purpose |
|-------|------|----------|-----------|---------|
| `mode` | string | Yes | One of: `"price"`, `"signers"`, `"market"` | Resolution type (extends `ResolutionSpec` enum) |
| `criteria` | string | Yes | ≤ 4000 characters | Human-readable explanation of how spec applies |
| `spec` | object | Yes | Schema matches the `mode` | The on-chain `ResolutionSpec` fields as JSON |
| `resolution_hash` | string | Yes | 64 hex characters (sha256) | XDR hash of the committed `ResolutionSpec` |

The `spec` object structure depends on `mode`:

**Mode: `"price"`**
```json
{
  "reflector": "C-address of Reflector oracle",
  "asset": "native | <SEP-41 contract address>",
  "threshold": <integer>,
  "direction": "above" | "at_or_above" | "below" | "at_or_below",
  "max_staleness": <seconds>
}
```

**Mode: `"signers"`**
```json
{
  "signers": ["GADDRESS1", "GADDRESS2", ...],
  "threshold": <min required signatures>,
  "dispute_window": <seconds after resolution proposed>
}
```

**Mode: `"market"`**
```json
{
  "source_market_id": <u64>,
  "on_yes": "yes" | "no" | "void",
  "on_no": "yes" | "no" | "void",
  "on_void": "yes" | "no" | "void",
  "max_wait": <seconds after this market's close_time>
}
```

## Canonical Encoding and Hashing

The commitment hash is `question_hash = sha256(canonical_bytes)`, where `canonical_bytes` are computed as follows:

1. **NFC Normalization**: All string fields are normalized to Unicode NFC form (composition of combining characters)
   - Example: `é` (e + acute) becomes the single precomposed character
   - Applied to: `question`, `description`, `criteria`, source names
   - Prevents collisions from different Unicode representations

2. **JSON Canonicalization**: RFC 8785 (JCS) encoding with the following rules:
   - UTF-8 character encoding
   - Keys sorted lexicographically by **UTF-16 code unit order** (not UTF-8)
     - Most keys sort the same way in both, but astral-plane characters differ
   - ECMAScript number serialization (no leading zeros, no `+` sign)
   - No insignificant whitespace (no spaces after `:` or `,`)

3. **Value encoding rules**:
   - `null` → `null`
   - Booleans → `true` or `false`
   - Numbers → decimal representation (integers stay integers, no `.0` suffix)
   - Strings → JSON string (quoted, with `\` escapes for special chars)
   - Arrays → `[item, item, ...]` (sorted by JCS, not custom order — order preserved)
   - Objects → `{"key":value,...}` (keys sorted)

4. **Resulting bytes** are UTF-8 encoded and hashed with SHA-256

### Example

Input metadata (after validation):
```json
{
  "schema": "oracledesk.market-metadata/1",
  "question": "Will XLM close above $0.20 on 2026-12-31?",
  "category": "Crypto",
  "close_time": 1798675200,
  "created_by": "GBRPYHIL2CI3...",
  "language": "en",
  "resolution": {
    "criteria": "Reflector XLM/USD at close time, threshold 0.20",
    "mode": "price",
    "resolution_hash": "abc123...",
    "spec": {
      "asset": "native",
      "direction": "above",
      "max_staleness": 3600,
      "reflector": "CAAAAAAA...",
      "threshold": 20
    }
  },
  "sources": [
    { "name": "Reflector", "url": "https://reflector.example.com" }
  ]
}
```

Canonical encoding (JCS):
```
{"category":"Crypto","close_time":1798675200,"created_by":"GBRPYHIL2CI3...","language":"en","question":"Will XLM close above $0.20 on 2026-12-31?","resolution":{"criteria":"Reflector XLM/USD at close time, threshold 0.20","mode":"price","resolution_hash":"abc123...","spec":{"asset":"native","direction":"above","max_staleness":3600,"reflector":"CAAAAAAA...","threshold":20}},"sources":[{"name":"Reflector","url":"https://reflector.example.com"}]}
```

Then: `question_hash = sha256(canonical_bytes)` (in hex)

## Verification

### Client-Side Verification (`agents/core/metadata.ts`)

```typescript
// 1. Fetch metadata from meta_uri (IPFS, etc.)
const metadataBytes = await fetch(metadata.meta_uri);

// 2. Verify bytes match the commitment
const computedHash = verifyMetadata(metadataBytes, market.question_hash);

// 3. Verify against on-chain market fields
checkAgainstMarket(metadata, {
  question_hash: market.question_hash,
  resolution_hash: market.resolution_hash,
  close_time: market.close_time,
  category: market.category
});

// 4. Display question and resolution criteria
console.log(metadata.question);
console.log(metadata.resolution.criteria);
```

### Server-Side Verification (`scripts/verify-market.sh`)

```bash
./scripts/verify-market.sh <market_id>
# Fetches market metadata from on-chain meta_uri
# Verifies question_hash and resolution_hash
# Prints OK or FAIL with diagnostics
```

### Verification Guarantees

- **question_hash** commits to the entire metadata JSON (not just the question field)
  - Traders can verify the full context, sources, and resolution criteria
- **resolution_hash** is independently verified against the on-chain `ResolutionSpec` XDR
  - Prevents discrepancy between human-readable criteria and committed spec
- Non-canonical encodings are rejected (hash does not match)
  - Prevents subtle attacks via whitespace, key ordering, or Unicode normalization

## Edge Cases and Legacy Handling

### Existing Markets Without Metadata

Markets created before this schema existed may have:
- `meta_uri` not pointing to valid metadata
- `question_hash` that does not follow this scheme
- No resolution criteria committed on-chain

**Handling**: Tooling reports these as `legacy/unverifiable` rather than failing. Users must trust the creator or the resolver's attestation. New markets must conform.

### Character Encoding Issues

- **Non-ASCII in questions**: Properly NFC-normalized before hashing; frontends must do the same
- **Emoji and surrogate pairs**: UTF-16 sorting in JCS handles correctly (not UTF-8 byte order)
- **Right-to-left text**: Stored as-is; display is the frontend's responsibility

### Price Thresholds with Decimals

The `spec` object uses integers (e.g., `threshold: 20` for $0.20 with 2 decimals). The decimal interpretation is documented in `criteria` and stored separately in the on-chain `PriceConfig.threshold_decimals` field (if using scaled price mode from issue #26).

## References and Standards

- **RFC 8785**: JSON Canonicalization Scheme (JCS) — https://tools.ietf.org/html/rfc8785
- **Unicode TR15**: Unicode Normalization Forms — https://unicode.org/reports/tr15/
- **Stellar SEP-40**: Anchored Assets — Defines asset format
- **ADR 0001**: Resolution commitment — https://github.com/OracleDesk/OracleDesk-SmartContract/blob/develop/docs/adr/0001-resolution-commitment.md

## Implementation References

- **TypeScript library**: `agents/core/metadata.ts` — Build, hash, verify metadata
- **Python library**: `model/market_metadata.py` — Reference implementation, CLI tool
- **Golden vectors**: `docs/market-metadata-vectors.json` — Test cases for canonicalization consistency
- **Market creation**: `agents/bin/market-maker.ts` — Uses metadata library to build and commit
- **Seed script**: `scripts/seed-market.sh` — Command-line market creation with metadata
- **Verification script**: `scripts/verify-market.sh` — End-to-end verification of seeded markets
