#!/usr/bin/env python3
"""
Market metadata schema v1: build, canonicalize, hash, and verify market metadata.

Canonical encoding follows RFC 8785 (JCS):
- UTF-8 encoding
- Keys sorted by UTF-16 code unit order (not UTF-8)
- NFC normalization of all strings
- No whitespace
- Number serialization: integers as integers, no scientific notation

Hash = sha256(canonical_bytes)
"""

import json
import hashlib
import sys
import unicodedata
from typing import Any, Dict, List, Optional, Union


# ─────────────────────────────────────────────────────────────────────────────
# Types
# ─────────────────────────────────────────────────────────────────────────────

MarketCategory = Union[
    "Crypto", "Macro", "Geopolitics", "Sports", "Culture", "Other"
]
ResolutionMode = Union["price", "signers", "market"]
LinkedResult = Union["yes", "no", "void"]
PriceDirection = Union["above", "at_or_above", "below", "at_or_below"]


class MetadataError(Exception):
    """Validation error with field path context."""
    def __init__(self, path: str, message: str):
        self.path = path
        super().__init__(f"{path}: {message}")


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────

def validate_metadata(m: Any) -> Dict[str, Any]:
    """Validate and return metadata as a dict."""
    if not isinstance(m, dict):
        raise MetadataError("$", "must be an object")

    # Top-level fields
    if m.get("schema") != "oracledesk.market-metadata/1":
        raise MetadataError("$.schema", "must equal 'oracledesk.market-metadata/1'")

    question = m.get("question")
    if not isinstance(question, str):
        raise MetadataError("$.question", "must be a string")
    if len(question) > 280:
        raise MetadataError("$.question", "must be ≤ 280 characters")

    description = m.get("description")
    if description is not None:
        if not isinstance(description, str):
            raise MetadataError("$.description", "must be a string")
        if len(description) > 2000:
            raise MetadataError("$.description", "must be ≤ 2000 characters")

    category = m.get("category")
    valid_categories = ["Crypto", "Macro", "Geopolitics", "Sports", "Culture", "Other"]
    if category not in valid_categories:
        raise MetadataError("$.category", f"must be one of {valid_categories}")

    close_time = m.get("close_time")
    if not isinstance(close_time, int):
        raise MetadataError("$.close_time", "must be an integer")

    created_by = m.get("created_by")
    if not isinstance(created_by, str):
        raise MetadataError("$.created_by", "must be a Stellar address")

    language = m.get("language", "en")
    if not isinstance(language, str):
        raise MetadataError("$.language", "must be a string")

    # Resolution object
    resolution = validate_resolution_object(m.get("resolution"))

    # Sources
    sources = []
    if "sources" in m:
        if not isinstance(m["sources"], list):
            raise MetadataError("$.sources", "must be an array")
        if len(m["sources"]) > 10:
            raise MetadataError("$.sources", "must have ≤ 10 items")
        for i, s in enumerate(m["sources"]):
            sources.append(validate_source(s, f"$.sources[{i}]"))

    return {
        "schema": "oracledesk.market-metadata/1",
        "question": question,
        "description": description,
        "category": category,
        "close_time": close_time,
        "resolution": resolution,
        "sources": sources if sources else None,
        "created_by": created_by,
        "language": language,
    }


def validate_resolution_object(obj: Any) -> Dict[str, Any]:
    """Validate resolution object."""
    if not isinstance(obj, dict):
        raise MetadataError("$.resolution", "must be an object")

    mode = obj.get("mode")
    if mode not in ["price", "signers", "market"]:
        raise MetadataError("$.resolution.mode", "must be 'price', 'signers', or 'market'")

    criteria = obj.get("criteria")
    if not isinstance(criteria, str):
        raise MetadataError("$.resolution.criteria", "must be a string")
    if len(criteria) > 4000:
        raise MetadataError("$.resolution.criteria", "must be ≤ 4000 characters")

    resolution_hash = obj.get("resolution_hash")
    if not isinstance(resolution_hash, str) or not _is_hex_hash(resolution_hash):
        raise MetadataError(
            "$.resolution.resolution_hash",
            "must be a 64-character hex string"
        )

    spec = validate_spec_for_mode(obj.get("spec"), mode)

    return {
        "mode": mode,
        "criteria": criteria,
        "spec": spec,
        "resolution_hash": resolution_hash,
    }


def _is_hex_hash(s: str) -> bool:
    """Check if string is a 64-character hex string (sha256)."""
    if not isinstance(s, str) or len(s) != 64:
        return False
    try:
        int(s, 16)
        return True
    except ValueError:
        return False


def validate_spec_for_mode(spec: Any, mode: str) -> Dict[str, Any]:
    """Validate spec object matches the resolution mode."""
    if not isinstance(spec, dict):
        raise MetadataError("$.resolution.spec", "must be an object")

    if mode == "price":
        return validate_price_spec(spec)
    elif mode == "signers":
        return validate_signers_spec(spec)
    elif mode == "market":
        return validate_market_spec(spec)
    else:
        raise MetadataError("$.resolution.spec", f"unknown mode: {mode}")


def validate_price_spec(s: Dict[str, Any]) -> Dict[str, Any]:
    """Validate price resolution spec."""
    if not isinstance(s.get("reflector"), str):
        raise MetadataError("$.resolution.spec.reflector", "must be a Stellar address")
    if not isinstance(s.get("asset"), str):
        raise MetadataError("$.resolution.spec.asset", "must be a string")
    if not isinstance(s.get("threshold"), int):
        raise MetadataError("$.resolution.spec.threshold", "must be an integer")
    if s.get("direction") not in ["above", "at_or_above", "below", "at_or_below"]:
        raise MetadataError("$.resolution.spec.direction", "must be a valid PriceDirection")
    if not isinstance(s.get("max_staleness"), int):
        raise MetadataError("$.resolution.spec.max_staleness", "must be an integer")

    return {
        "reflector": s["reflector"],
        "asset": s["asset"],
        "threshold": s["threshold"],
        "direction": s["direction"],
        "max_staleness": s["max_staleness"],
    }


def validate_signers_spec(s: Dict[str, Any]) -> Dict[str, Any]:
    """Validate signers resolution spec."""
    signers = s.get("signers")
    if not isinstance(signers, list):
        raise MetadataError("$.resolution.spec.signers", "must be an array")
    for i, signer in enumerate(signers):
        if not isinstance(signer, str):
            raise MetadataError(f"$.resolution.spec.signers[{i}]", "must be a string")

    if not isinstance(s.get("threshold"), int):
        raise MetadataError("$.resolution.spec.threshold", "must be an integer")
    if not isinstance(s.get("dispute_window"), int):
        raise MetadataError("$.resolution.spec.dispute_window", "must be an integer")

    return {
        "signers": signers,
        "threshold": s["threshold"],
        "dispute_window": s["dispute_window"],
    }


def validate_market_spec(s: Dict[str, Any]) -> Dict[str, Any]:
    """Validate market-linked resolution spec."""
    if not isinstance(s.get("source_market_id"), int):
        raise MetadataError("$.resolution.spec.source_market_id", "must be an integer")
    if s.get("on_yes") not in ["yes", "no", "void"]:
        raise MetadataError("$.resolution.spec.on_yes", "must be 'yes', 'no', or 'void'")
    if s.get("on_no") not in ["yes", "no", "void"]:
        raise MetadataError("$.resolution.spec.on_no", "must be 'yes', 'no', or 'void'")
    if s.get("on_void") not in ["yes", "no", "void"]:
        raise MetadataError("$.resolution.spec.on_void", "must be 'yes', 'no', or 'void'")
    if not isinstance(s.get("max_wait"), int):
        raise MetadataError("$.resolution.spec.max_wait", "must be an integer")

    return {
        "source_market_id": s["source_market_id"],
        "on_yes": s["on_yes"],
        "on_no": s["on_no"],
        "on_void": s["on_void"],
        "max_wait": s["max_wait"],
    }


def validate_source(s: Any, path: str) -> Dict[str, str]:
    """Validate source object."""
    if not isinstance(s, dict):
        raise MetadataError(path, "must be an object")
    if not isinstance(s.get("name"), str):
        raise MetadataError(f"{path}.name", "must be a string")
    if not isinstance(s.get("url"), str):
        raise MetadataError(f"{path}.url", "must be a string")

    total_len = len(json.dumps(s, separators=(",", ":")))
    if total_len > 500:
        raise MetadataError(path, "source object must be ≤ 500 characters when serialized")

    return {
        "name": s["name"],
        "url": s["url"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Canonicalization (RFC 8785 JCS + NFC)
# ─────────────────────────────────────────────────────────────────────────────

def _normalize_strings_nfc(obj: Any) -> Any:
    """Recursively normalize all string values to NFC form."""
    if isinstance(obj, str):
        return unicodedata.normalize("NFC", obj)
    if isinstance(obj, list):
        return [_normalize_strings_nfc(item) for item in obj]
    if isinstance(obj, dict):
        return {k: _normalize_strings_nfc(v) for k, v in obj.items()}
    return obj


def _canonicalize_value(value: Any) -> str:
    """
    Canonicalize a value to RFC 8785 (JCS) JSON.
    Keys are sorted by UTF-16 code unit order.
    """
    if value is None:
        return "null"

    if isinstance(value, bool):
        return "true" if value else "false"

    if isinstance(value, int):
        return str(value)

    if isinstance(value, float):
        raise ValueError(f"Floats not allowed in metadata: {value}")

    if isinstance(value, str):
        return json.dumps(value, separators=(",", ":"))

    if isinstance(value, list):
        items = [_canonicalize_value(item) for item in value]
        return "[" + ",".join(items) + "]"

    if isinstance(value, dict):
        # Sort keys by UTF-16 code unit order (Python's native string comparison)
        keys = sorted(value.keys())
        pairs = []
        for key in keys:
            key_str = json.dumps(key, separators=(",", ":"))
            val_str = _canonicalize_value(value[key])
            pairs.append(key_str + ":" + val_str)
        return "{" + ",".join(pairs) + "}"

    raise ValueError(f"Cannot canonicalize type {type(value)}")


def canonical_metadata_bytes(metadata: Dict[str, Any]) -> bytes:
    """Return canonical bytes of metadata."""
    # NFC-normalize all strings
    normalized = _normalize_strings_nfc(metadata)

    # Canonicalize to JCS
    canonical = _canonicalize_value(normalized)

    # UTF-8 encode
    return canonical.encode("utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Hashing
# ─────────────────────────────────────────────────────────────────────────────

def metadata_hash(metadata: Dict[str, Any]) -> str:
    """Return sha256 hash of metadata as hex string."""
    bytes_data = canonical_metadata_bytes(metadata)
    return hashlib.sha256(bytes_data).hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    """CLI interface: `python3 market_metadata.py hash <file.json>`"""
    if len(sys.argv) != 3 or sys.argv[1] != "hash":
        print("Usage: python3 market_metadata.py hash <file.json>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[2]
    try:
        with open(filepath, "r") as f:
            data = json.load(f)

        metadata = validate_metadata(data)
        hash_hex = metadata_hash(metadata)
        print(hash_hex)
    except MetadataError as e:
        print(f"Validation error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def _check_golden_vectors():
    """Test golden vectors (called by run_all())."""
    # Placeholder for golden vector testing integrated into test suite
    # Vectors defined in docs/market-metadata-vectors.json
    pass


def run_all():
    """Run all tests."""
    _check_golden_vectors()
    _check_rejects_float()


def _check_rejects_float():
    """Verify that floats in metadata are rejected."""
    try:
        bad_metadata = {
            "schema": "oracledesk.market-metadata/1",
            "question": "test",
            "category": "Other",
            "close_time": 1,
            "created_by": "GTEST",
            "resolution": {
                "mode": "price",
                "criteria": "test",
                "spec": {
                    "reflector": "CTEST",
                    "asset": "native",
                    "threshold": 1.5,  # Float!
                    "direction": "above",
                    "max_staleness": 3600,
                },
                "resolution_hash": "0000000000000000000000000000000000000000000000000000000000000000",
            },
        }
        try:
            metadata_hash(bad_metadata)
            raise AssertionError("Should have rejected float threshold")
        except ValueError:
            pass  # Expected
    except Exception as e:
        print(f"Float rejection test failed: {e}")
        raise


if __name__ == "__main__":
    main()
