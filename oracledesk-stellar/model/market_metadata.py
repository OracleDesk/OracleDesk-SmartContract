"""Reference implementation of OracleDesk Market Metadata Schema v1
(`oracledesk.market-metadata/1`) using only the Python standard library.

Implements:
- Unicode NFC normalization on all keys and string values
- Schema v1 validation (`MetadataError` with field path)
- RFC 8785 JSON Canonicalization Scheme (JCS) with UTF-16 code unit key sorting
- `metadata_hash` / `verify_metadata` / `check_against_market`
- CLI: `python3 model/market_metadata.py hash <file.json>`
- Self-tests & golden vector verification when executed directly:
      python3 model/market_metadata.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

SCHEMA_V1 = "oracledesk.market-metadata/1"
VALID_CATEGORIES = frozenset({"Sports", "Crypto", "Geopolitics", "Culture", "Macro", "Other"})
VALID_MODES = frozenset({"price", "signers"})
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_SAFE_INT = 9_007_199_254_740_991


class MetadataError(Exception):
    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.reason = message


def normalize_nfc(value: Any, path: str = "$") -> Any:
    """Recursively NFC-normalize all strings and object keys, rejecting floats."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, float):
        raise MetadataError(path, "floating-point numbers are not allowed; use integers or decimal strings")
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INT:
            raise MetadataError(path, "integer exceeds IEEE-754 safe integer range; use a decimal string")
        return value
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [normalize_nfc(item, f"{path}[{ idx }]") for idx, item in enumerate(value)]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise MetadataError(path, "object keys must be strings")
            nk = unicodedata.normalize("NFC", k)
            out[nk] = normalize_nfc(v, f"{path}.{nk}")
        return out
    raise MetadataError(path, f"unsupported JSON type {type(value).__name__}")


def validate_metadata(raw: Any) -> dict[str, Any]:
    """Validate and NFC-normalize a MarketMetadataV1 object."""
    m = normalize_nfc(raw, "$")
    if not isinstance(m, dict):
        raise MetadataError("$", "metadata must be a JSON object")

    allowed_top = {
        "schema",
        "question",
        "description",
        "category",
        "close_time",
        "resolution",
        "sources",
        "created_by",
        "language",
    }
    for k in m:
        if k not in allowed_top:
            raise MetadataError(f"$.{k}", "unknown field in MarketMetadataV1")

    if m.get("schema") != SCHEMA_V1:
        raise MetadataError("$.schema", f"expected {SCHEMA_V1!r}")

    q = m.get("question")
    if not isinstance(q, str) or not q.strip():
        raise MetadataError("$.question", "must be a non-empty string")
    if len(q) > 280:
        raise MetadataError("$.question", f"exceeds 280 chars ({len(q)})")

    if "description" in m and m["description"] is not None:
        desc = m["description"]
        if not isinstance(desc, str):
            raise MetadataError("$.description", "must be a string")
        if len(desc) > 4000:
            raise MetadataError("$.description", f"exceeds 4000 chars ({len(desc)})")

    cat = m.get("category")
    if not isinstance(cat, str) or cat not in VALID_CATEGORIES:
        raise MetadataError("$.category", f"must be one of {sorted(VALID_CATEGORIES)}")

    ct = m.get("close_time")
    if isinstance(ct, bool) or not isinstance(ct, int) or ct <= 0:
        raise MetadataError("$.close_time", "must be a positive integer")

    res = m.get("resolution")
    if not isinstance(res, dict):
        raise MetadataError("$.resolution", "must be an object")
    for rk in res:
        if rk not in {"mode", "criteria", "spec", "resolution_hash"}:
            raise MetadataError(f"$.resolution.{rk}", "unknown field in resolution")

    mode = res.get("mode")
    if not isinstance(mode, str) or mode not in VALID_MODES:
        raise MetadataError("$.resolution.mode", "must be 'price' or 'signers'")

    criteria = res.get("criteria")
    if not isinstance(criteria, str) or not criteria.strip():
        raise MetadataError("$.resolution.criteria", "must be a non-empty string")
    if len(criteria) > 4000:
        raise MetadataError("$.resolution.criteria", f"exceeds 4000 chars ({len(criteria)})")

    spec = res.get("spec")
    if not isinstance(spec, dict) or len(spec) == 0:
        raise MetadataError("$.resolution.spec", "must be a non-empty object")

    rhash = res.get("resolution_hash")
    if not isinstance(rhash, str) or not HEX64_RE.match(rhash):
        raise MetadataError("$.resolution.resolution_hash", "must be a 64-char lowercase hex sha256 string")

    sources = m.get("sources")
    if not isinstance(sources, list):
        raise MetadataError("$.sources", "must be an array")
    if len(sources) > 10:
        raise MetadataError("$.sources", f"exceeds max 10 sources ({len(sources)})")
    for idx, src in enumerate(sources):
        spath = f"$.sources[{idx}]"
        if not isinstance(src, dict):
            raise MetadataError(spath, "must be an object")
        for sk in src:
            if sk not in {"name", "url"}:
                raise MetadataError(f"{spath}.{sk}", "unknown field in source")
        if not isinstance(src.get("name"), str) or not src["name"].strip():
            raise MetadataError(f"{spath}.name", "must be a non-empty string")
        if not isinstance(src.get("url"), str) or not src["url"].strip():
            raise MetadataError(f"{spath}.url", "must be a non-empty string")

    if "created_by" in m and m["created_by"] is not None:
        cb = m["created_by"]
        if not isinstance(cb, str) or not cb.strip():
            raise MetadataError("$.created_by", "must be a non-empty string")

    if "language" in m and m["language"] is not None:
        lang = m["language"]
        if not isinstance(lang, str) or not lang.strip():
            raise MetadataError("$.language", "must be a non-empty string")

    return m


def _jcs_escape_str(s: str) -> str:
    out = ['"']
    for ch in s:
        code = ord(ch)
        if code == 0x08:
            out.append("\\b")
        elif code == 0x09:
            out.append("\\t")
        elif code == 0x0A:
            out.append("\\n")
        elif code == 0x0C:
            out.append("\\f")
        elif code == 0x0D:
            out.append("\\r")
        elif code == 0x22:
            out.append('\\"')
        elif code == 0x5C:
            out.append("\\\\")
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(k: str) -> bytes:
    """RFC 8785 Section 3.2.3 sorts object property names by UTF-16 code units."""
    return k.encode("utf-16-be")


def jcs_serialize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _jcs_escape_str(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs_serialize(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: _utf16_key(kv[0]))
        return "{" + ",".join(f"{_jcs_escape_str(k)}:{jcs_serialize(v)}" for k, v in items) + "}"
    raise TypeError(f"Unsupported JCS value: {value!r}")


def canonical_metadata_bytes(raw: Any) -> bytes:
    validated = validate_metadata(raw)
    return jcs_serialize(validated).encode("utf-8")


def metadata_hash(raw: Any) -> bytes:
    return hashlib.sha256(canonical_metadata_bytes(raw)).digest()


def metadata_hash_hex(raw: Any) -> str:
    return metadata_hash(raw).hex()


def verify_metadata(raw_bytes: bytes, question_hash_hex: str) -> dict[str, Any]:
    """Hash the received bytes first, then parse, validate, and confirm
    the received bytes were already in canonical JCS+NFC form."""
    expected = question_hash_hex.lower().removeprefix("0x")
    if not HEX64_RE.match(expected):
        raise MetadataError("$.question_hash", "expected 64-char lowercase hex sha256")
    actual_hash = hashlib.sha256(raw_bytes).hexdigest()
    if actual_hash != expected:
        raise MetadataError("$.question_hash", f"sha256 mismatch: got {actual_hash}, expected {expected}")
    try:
        text = raw_bytes.decode("utf-8")
        parsed = json.loads(
            text,
            parse_float=lambda s: (_ for _ in ()).throw(
                MetadataError("$", f"floating-point number {s!r} is not allowed")
            ),
        )
    except UnicodeDecodeError as exc:
        raise MetadataError("$", f"invalid UTF-8: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise MetadataError("$", f"invalid JSON: {exc}") from exc

    validated = validate_metadata(parsed)
    canonical = jcs_serialize(validated).encode("utf-8")
    if canonical != raw_bytes:
        raise MetadataError("$", "received bytes are not in canonical JCS+NFC form")
    return validated


def check_against_market(
    metadata: dict[str, Any],
    market: dict[str, Any],
    recomputed_resolution_hash: str | None = None,
) -> None:
    """Verify consistency between validated MarketMetadataV1 and on-chain Market fields."""
    validated = validate_metadata(metadata)
    m_qhash = str(market["question_hash"]).lower().removeprefix("0x")
    computed_qhash = metadata_hash_hex(validated)
    if computed_qhash != m_qhash:
        raise MetadataError("$.question_hash", f"metadata hash {computed_qhash} != market {m_qhash}")

    m_rhash = str(market["resolution_hash"]).lower().removeprefix("0x")
    meta_rhash = validated["resolution"]["resolution_hash"]
    if meta_rhash != m_rhash:
        raise MetadataError(
            "$.resolution.resolution_hash",
            f"metadata resolution_hash {meta_rhash} != market {m_rhash}",
        )
    if recomputed_resolution_hash is not None:
        norm_recomputed = recomputed_resolution_hash.lower().removeprefix("0x")
        if meta_rhash != norm_recomputed:
            raise MetadataError(
                "$.resolution.spec",
                f"re-hashed spec {norm_recomputed} != resolution_hash {meta_rhash}",
            )

    if int(market["close_time"]) != validated["close_time"]:
        raise MetadataError(
            "$.close_time",
            f"metadata close_time {validated['close_time']} != market {market['close_time']}",
        )
    if str(market["category"]) != validated["category"]:
        raise MetadataError(
            "$.category",
            f"metadata category {validated['category']!r} != market {market['category']!r}",
        )


def _check_golden_vectors() -> None:
    vectors_path = Path(__file__).resolve().parent.parent / "docs" / "market-metadata-vectors.json"
    vectors = json.loads(vectors_path.read_text(encoding="utf-8"))
    assert len(vectors) >= 4, "expected at least 4 golden vectors"
    for vec in vectors:
        name = vec["name"]
        cbytes = canonical_metadata_bytes(vec["input"])
        chex = cbytes.hex()
        hhex = metadata_hash_hex(vec["input"])
        assert chex == vec["canonical_hex"], f"{name}: canonical_hex mismatch"
        assert hhex == vec["sha256"], f"{name}: sha256 mismatch"
        verified = verify_metadata(cbytes, hhex)
        assert metadata_hash_hex(verified) == hhex


def _check_rejects_float_and_non_canonical() -> None:
    sample = {
        "schema": SCHEMA_V1,
        "question": "Will XLM close above $0.20?",
        "category": "Crypto",
        "close_time": 1798675200,
        "resolution": {
            "mode": "price",
            "criteria": "Reflector XLM/USD > 0.20",
            "spec": {"asset": "XLM", "threshold": 0.2},
            "resolution_hash": "a" * 64,
        },
        "sources": [{"name": "Reflector", "url": "https://reflector.network"}],
    }
    try:
        validate_metadata(sample)
        raise AssertionError("expected MetadataError on float")
    except MetadataError as exc:
        assert "$.resolution.spec.threshold" in exc.path

    valid = {
        **sample,
        "resolution": {
            **sample["resolution"],
            "spec": {"asset": "XLM", "threshold": "2000000"},
        },
    }
    cbytes = canonical_metadata_bytes(valid)
    pretty = json.dumps(valid, indent=2).encode("utf-8")
    pretty_hash = hashlib.sha256(pretty).hexdigest()
    try:
        verify_metadata(pretty, pretty_hash)
        raise AssertionError("expected verify_metadata to reject non-canonical whitespace")
    except MetadataError:
        pass
    assert verify_metadata(cbytes, hashlib.sha256(cbytes).hexdigest())["category"] == "Crypto"


def run_all() -> None:
    _check_golden_vectors()
    _check_rejects_float_and_non_canonical()
    print("market_metadata.py: all checks passed")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "hash":
        raw_obj = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        print(metadata_hash_hex(raw_obj))
    elif len(sys.argv) >= 3 and sys.argv[1] == "canonical":
        raw_obj = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        sys.stdout.buffer.write(canonical_metadata_bytes(raw_obj))
    else:
        run_all()
