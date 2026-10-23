# OracleDesk Market Metadata Schema v1 (`oracledesk.market-metadata/1`)

## Overview

`Market.question_hash` commits a prediction market to the exact UTF-8 byte sequence of its off-chain question and resolution criteria metadata JSON document (`meta_uri`). Any client, indexer, backend, or agent can fetch the bytes at `meta_uri`, verify `sha256(bytes) == Market.question_hash`, and confirm that `resolution.resolution_hash == Market.resolution_hash`.

## Schema v1

```json
{
  "schema": "oracledesk.market-metadata/1",
  "question": "Will XLM close above $0.20 on 2026-12-31?",
  "description": "Resolves according to the Reflector XLM/USD feed at market close.",
  "category": "Crypto",
  "close_time": 1798675200,
  "resolution": {
    "mode": "price",
    "criteria": "Resolves YES if Reflector XLM/USD price at close_time is strictly above $0.20 (2000000 in 7-decimal units).",
    "spec": {
      "oracle": "CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP",
      "asset": "XLM",
      "threshold": "2000000",
      "comparison": "Gt"
    },
    "resolution_hash": "a3f5c8e1d9b047261839405162738495061728394a5b6c7d8e9f001122334455"
  },
  "sources": [
    {
      "name": "Reflector Oracle",
      "url": "https://reflector.network"
    }
  ],
  "created_by": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "language": "en"
}
```

### Field Rules & Size Limits

| Field | Type | Required | Constraints |
|---|---|---|---|
| `schema` | `string` | Yes | Exact literal `"oracledesk.market-metadata/1"`. |
| `question` | `string` | Yes | Non-empty after trim, `<= 280` Unicode code points (after NFC). |
| `description` | `string` | Optional | `<= 4000` Unicode code points (after NFC). |
| `category` | `string` | Yes | One of `"Sports"`, `"Crypto"`, `"Geopolitics"`, `"Culture"`, `"Macro"`, `"Other"`. |
| `close_time` | `integer` | Yes | Positive safe integer (`> 0`), matching on-chain `Market.close_time`. |
| `resolution.mode` | `string` | Yes | `"price"` or `"signers"`. |
| `resolution.criteria` | `string` | Yes | Non-empty after trim, `<= 4000` Unicode code points (after NFC). |
| `resolution.spec` | `object` | Yes | JSON mirror of the committed `ResolutionSpec` (all big amounts encoded as decimal strings). |
| `resolution.resolution_hash` | `string` | Yes | 64-char lowercase hex SHA-256 of XDR(`ResolutionSpec`), matching on-chain `Market.resolution_hash`. |
| `sources` | `array` | Yes | `0..10` entries of `{ "name": string, "url": string }`. |
| `created_by` | `string` | Optional | Stellar `G...` or `C...` strkey of the creator. |
| `language` | `string` | Optional | BCP-47 language tag (e.g., `"en"`). |

## Canonical Encoding (RFC 8785 JCS + Unicode NFC)

To guarantee byte-for-byte reproducibility across TypeScript, Python, and Rust:

1. **Unicode NFC Pre-Step**: Every string value and object key is normalized using Unicode Normalization Form C (`NFC`) prior to validation and serialization.
2. **Integer-Only Numbers**: All numeric values in the metadata document must be exact integers (`Number.isSafeInteger` in JS; `int` and not `bool`/`float` in Python). Fixed-point token or oracle amounts inside `resolution.spec` must be encoded as decimal strings. Floating-point numbers are rejected with `MetadataError`.
3. **RFC 8785 JSON Canonicalization Scheme (JCS)**:
   - UTF-8 encoding with no BOM and no insignificant whitespace.
   - Object properties sorted lexicographically by the **UTF-16 code unit** sequence of their NFC-normalized keys (matching ES2015+/RFC 8785 Section 3.2.3). Note that Python's `json.dumps(sort_keys=True)` sorts by Unicode code point, which differs for astral-plane characters (`U+10000`+) vs `U+E000..U+FFFF`; `model/market_metadata.py` therefore sorts keys explicitly by `.encode("utf-16-be")`.
   - Strings escaped per RFC 8785 (`\b`, `\t`, `\n`, `\f`, `\r`, `\"`, `\\`, and `\u00xx` with lowercase hex for other control characters `U+0000..U+001F`; all other characters emitted as literal UTF-8).
4. **Why `agents/core/trace.ts` `canonicalize` is Separate**:
   `agents/core/trace.ts` defines the frozen reasoning-trace canonicalizer used for `ReasoningRegistry` trace hashes. Changing it would alter historical trace hashes. Market metadata uses RFC 8785 JCS + NFC as an explicitly versioned cross-language standard (`oracledesk.market-metadata/1`).
