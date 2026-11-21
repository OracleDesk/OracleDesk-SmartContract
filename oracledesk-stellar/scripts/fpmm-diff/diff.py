#!/usr/bin/env python3
"""Differential tester for OracleDesk's three FPMM implementations.

Compares, over JSON lines:

* Rust   -- contracts/market-core/src/math.rs, through `fpmm-oracle`
* Python -- model/fpmm_model.py, in-process
* TS     -- agents/core/fpmm.ts, through `ts-oracle.ts`

The generator is boundary-aware (fee/BPS edges, MAX_SETS +/- 1, divisibility
classes, negative inputs, exact-share round-trips), results and errors are
normalised, and the first mismatch is greedily shrunk before it is reported.
The deprecated inverse functions are compared Python-vs-TS only; Rust exposes
the canonical `calc_sell_shares` instead.

Usage:
    cargo build --manifest-path scripts/fpmm-diff/oracle/Cargo.toml --release
    python3 scripts/fpmm-diff/diff.py --seed 1 --count 50000

Set `--append` to append a found mismatch to scripts/fpmm-diff/vectors.jsonl.
`--self-test` monkeypatches Python's mul_div_ceil to floor and asserts the
harness finds and shrinks the resulting disagreement.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "model"
sys.path.insert(0, str(MODEL_DIR))
import fpmm_model as model  # noqa: E402

VECTORS = ROOT / "scripts" / "fpmm-diff" / "vectors.jsonl"
ORACLE_BIN = ROOT / "scripts" / "fpmm-diff" / "oracle" / "target" / "release" / "fpmm-oracle"
I128_MIN = -(1 << 127)
I128_MAX = (1 << 127) - 1
BPS = 10_000
MAX_SETS = 1_000_000_000_000_000
MIN_SEED = 100 * 10_000_000
FEES = [0, 1, 999, 1000, 1001, 9998, 9999, 10000]
PROBS = [99, 100, 101, 4999, 5000, 5001, 9899, 9900, 9901]
BOUNDARIES = [0, 1, 2, 3, 5, 10, 99, 100, 101, 999, 1000, 1001, 5000, 9900, 10_000,
              MIN_SEED - 1, MIN_SEED, MIN_SEED + 1, MAX_SETS - 1, MAX_SETS, MAX_SETS + 1]
# Kept separate so the >95% "no overflow skip" budget is easy to satisfy; the
# integer-overflow divergence rule is still exercised on ~2% of cases.
HUGE = [I128_MAX - 1, I128_MAX, I128_MIN, I128_MIN + 1]

# fn -> (python implementation, expected result field names)
PY_FUNCS: dict[str, Callable[[list[Any]], Any]] = {
    "mul_div_floor": lambda a: {"value": model.mul_div_floor(int(a[0]), int(a[1]), int(a[2]))},
    "mul_div_ceil": lambda a: {"value": model.mul_div_ceil(int(a[0]), int(a[1]), int(a[2]))},
    "price_yes_bps": lambda a: {"value": model.price_yes_bps(int(a[0]), int(a[1]))},
    "seed_reserves": lambda a: {
        "reserve_yes": model.seed_reserves(int(a[0]), int(a[1])).reserve_yes,
        "reserve_no": model.seed_reserves(int(a[0]), int(a[1])).reserve_no,
        "creator_yes": model.seed_reserves(int(a[0]), int(a[1])).creator_yes,
        "creator_no": model.seed_reserves(int(a[0]), int(a[1])).creator_no,
    },
    "calc_buy": lambda a: _buy_dict(model.calc_buy(int(a[0]), int(a[1]), int(a[2]), int(a[3]))),
    "calc_sell": lambda a: _sell_dict(model.calc_sell(int(a[0]), int(a[1]), int(a[2]), int(a[3]))),
    "settle_value": lambda a: {"value": model.settle_value(str(a[0]), int(a[1]), int(a[2]))},
    "price_after": lambda a: {
        "value": model.price_after(_truth(a[0]), int(a[1]), int(a[2]))
    },
    "buy_within_limit": lambda a: {
        "value": model.buy_within_limit(int(a[0]), int(a[1]), int(a[2]))
    },
    "sell_within_limit": lambda a: {
        "value": model.sell_within_limit(int(a[0]), int(a[1]), int(a[2]))
    },
    "calc_sell_shares": lambda a: _sell_shares_dict(
        model.calc_sell_shares(int(a[0]), int(a[1]), int(a[2]), int(a[3]))
    ),
    "split_fee": lambda a: dict(
        zip(("protocol", "lp"), model.split_fee(int(a[0]), int(a[1])))
    ),
    "settle_upper": lambda a: {"value": model.settle_upper(str(a[0]), int(a[1]), int(a[2]))},
    "merge_max": lambda a: {"value": model.merge_max(int(a[0]), int(a[1]))},
    "isqrt": lambda a: {"value": model.isqrt(int(a[0]))},
    # Deprecated off-chain inverse: compared Python-vs-TS only (INVERSE_FNS).
    "gross_for_shares": lambda a: {
        "gross": model.gross_for_shares(int(a[0]), int(a[1]), int(a[2]), int(a[3]))
    },
    "collateral_out_for_shares": lambda a: {
        "collateral_out": model.collateral_out_for_shares(
            int(a[0]), int(a[1]), int(a[2]), int(a[3])
        )
    },
}

INVERSE_FNS = {"gross_for_shares", "collateral_out_for_shares"}


def _truth(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("true", "1", "yes")


def _buy_dict(q: Any) -> dict[str, int]:
    return {
        "shares_out": q.shares_out,
        "fee": q.fee,
        "net": q.net,
        "new_reserve_bought": q.new_reserve_bought,
        "new_reserve_other": q.new_reserve_other,
    }


def _sell_dict(q: Any) -> dict[str, int]:
    return {
        "shares_in": q.shares_in,
        "fee": q.fee,
        "gross": q.gross,
        "new_reserve_sold": q.new_reserve_sold,
        "new_reserve_other": q.new_reserve_other,
    }


def _sell_shares_dict(q: Any) -> dict[str, int]:
    return {
        "collateral_out": q.collateral_out,
        "fee": q.fee,
        "gross": q.gross,
        "new_reserve_sold": q.new_reserve_sold,
        "new_reserve_other": q.new_reserve_other,
    }


def canonical(fn: str, value: Any) -> dict[str, Any]:
    """{"ok": {field: decimal-string}} or {"err": Kind}."""
    if isinstance(value, dict) and "err" in value:
        return {"err": value["err"]}
    if isinstance(value, dict) and "ok" in value:
        value = value["ok"]
    out: dict[str, str] = {}
    for k, v in value.items():
        if isinstance(v, bool):
            out[k] = "true" if v else "false"
        else:
            out[k] = str(v)
    return {"ok": out}


def python_result(fn: str, args: list[Any]) -> dict[str, Any]:
    try:
        return canonical(fn, PY_FUNCS[fn](args))
    except model.MathError as exc:
        msg = str(exc)
        kind = "InsufficientLiquidity" if msg == "insufficient liquidity" else "InvalidInput"
        return {"err": kind}
    except (ValueError, OverflowError):
        return {"err": "InvalidInput"}
    except Exception as exc:  # pragma: no cover - defensive
        return {"err": f"PythonError:{exc}"}


# ---------------------------------------------------------------------------
# i128 overflow model
# ---------------------------------------------------------------------------

class TooBig(Exception):
    pass


def _ck(v: int) -> int:
    if v < I128_MIN or v > I128_MAX:
        raise TooBig
    return v


def _add(a: int, b: int) -> int:
    return _ck(a + b)


def _sub(a: int, b: int) -> int:
    return _ck(a - b)


def _mul(a: int, b: int) -> int:
    return _ck(a * b)


def _ceil_div(a: int, b: int) -> int:
    q, r = divmod(a, b)
    return q + (1 if r else 0)


def expected_rust_error(fn: str, a: list[Any]) -> str | None:
    """The error math.rs must return *before* any value comparison, or None.

    Python/TS use unbounded integers. When Rust's checked i128 arithmetic
    overflows, the driver expects `Overflow` there and treats a Python/TS
    success as the documented, expected divergence. Early `InvalidInput` /
    `InsufficientLiquidity` branches are modelled too, because they run
    before the arithmetic that would otherwise overflow.
    """
    try:
        if fn in ("mul_div_floor", "mul_div_ceil"):
            x, y, z = int(a[0]), int(a[1]), int(a[2])
            if x < 0 or y < 0 or z <= 0:
                return "InvalidInput"
            _mul(x, y)
            return None
        if fn in ("price_yes_bps", "price_after"):
            if fn == "price_after":
                x, y = int(a[1]), int(a[2])
            else:
                x, y = int(a[0]), int(a[1])
            total = _add(x, y)
            if total <= 0:
                return "InsufficientLiquidity"
            _mul(y, BPS)
            return None
        if fn == "seed_reserves":
            seed, p = int(a[0]), int(a[1])
            if seed <= 0 or p < 100 or p > 9900:
                return "InvalidInput"
            _mul(seed, BPS - p if p >= 5000 else p)
            return None
        if fn == "calc_buy":
            rb, ro, amt, fee = map(int, a)
            if amt <= 0 or rb <= 0 or ro <= 0:
                return "InvalidInput"
            fee_v = _ceil_div(_mul(amt, fee), BPS)
            net = amt - fee_v
            if net <= 0:
                return "InvalidInput"
            no = _add(ro, net)
            nb = _ceil_div(_mul(rb, ro), no)
            shares = _add(_add(rb, net), 0) - nb
            if shares <= 0:
                return "InvalidInput"
            return None
        if fn == "calc_sell":
            rs, ro, out, fee = map(int, a)
            if out <= 0 or rs <= 0 or ro <= 0 or fee >= BPS:
                return "InvalidInput"
            gross = _ceil_div(_mul(out, BPS), BPS - fee)
            if gross >= ro:
                return "InsufficientLiquidity"
            no = ro - gross
            ns = _ceil_div(_mul(rs, ro), no)
            shares = _add(ns, gross) - rs
            if shares <= 0:
                return "InvalidInput"
            return None
        if fn == "calc_sell_shares":
            rs, ro, sh, fee = map(int, a)
            if sh <= 0 or rs <= 0 or ro <= 0 or fee >= BPS:
                return "InvalidInput"
            b = _add(_add(rs, sh), ro)
            disc = _mul(b, b) - _mul(4, _mul(ro, sh))
            if disc < 0:
                return "InsufficientLiquidity"
            x = (b - model.isqrt(disc)) // 2
            while x > 0 and (rs + sh - x) * (ro - x) < rs * ro:
                x -= 1
            if x == 0 or x >= ro:
                return "InsufficientLiquidity"
            if model.mul_div_floor(x, BPS - fee, BPS) <= 0:
                return "InvalidInput"
            return None
        if fn == "split_fee":
            fee, share = map(int, a)
            if fee < 0 or share > BPS:
                return "InvalidInput"
            _mul(fee, share)
            return None
        if fn in ("settle_value", "settle_upper"):
            if str(a[0]) not in ("yes", "no", "void"):
                return "InvalidInput"
            _add(int(a[1]), int(a[2]))
            return None
        if fn == "merge_max":
            return "InvalidInput" if int(a[0]) < 0 or int(a[1]) < 0 else None
        if fn == "isqrt":
            return "InvalidInput" if int(a[0]) < 0 else None
        if fn in ("buy_within_limit", "sell_within_limit"):
            x, y, z = int(a[0]), int(a[1]), int(a[2])
            if x < 0 or y <= 0:
                return "InvalidInput"
            _mul(x, BPS)
            _mul(y, z)
            return None
        return None
    except TooBig:
        return "Overflow"
    except (model.MathError, ValueError, ZeroDivisionError):
        return None


# ---------------------------------------------------------------------------
# Subprocess oracles
# ---------------------------------------------------------------------------

class Oracle:
    def __init__(self, cmd: list[str], cwd: Path):
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def ask_batch(self, reqs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        assert self.proc.stdin and self.proc.stdout
        for req in reqs:
            self.proc.stdin.write(json.dumps(req, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()
        out = []
        for _ in reqs:
            line = self.proc.stdout.readline()
            if not line:
                err = self.proc.stderr.read() if self.proc.stderr else ""
                raise RuntimeError(f"oracle exited early: {err}")
            out.append(json.loads(line))
        return out

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover
                self.proc.kill()


def ts_command() -> list[str]:
    local = ROOT / "agents" / "node_modules" / ".bin" / "tsx"
    if local.exists():
        return [str(local), "scripts/fpmm-diff/ts-oracle.ts"]
    return ["npx", "--yes", "tsx", "scripts/fpmm-diff/ts-oracle.ts"]


class Harness:
    def __init__(self, build: bool = False):
        if build or not ORACLE_BIN.exists():
            subprocess.run(
                [
                    "cargo",
                    "build",
                    "--release",
                    "--manifest-path",
                    "scripts/fpmm-diff/oracle/Cargo.toml",
                ],
                cwd=str(ROOT),
                check=True,
            )
        self.rust = Oracle([str(ORACLE_BIN)], ROOT)
        self.ts = Oracle(ts_command(), ROOT)
        self.next_id = 0

    def close(self) -> None:
        self.rust.close()
        self.ts.close()

    def rust_results(self, cases: list[tuple[str, list[Any]]]) -> list[dict[str, Any]]:
        reqs = []
        for fn, args in cases:
            self.next_id += 1
            reqs.append({"id": self.next_id, "fn": fn, "args": _json_args(args)})
        responses = self.rust.ask_batch(reqs)
        out = []
        for r in responses:
            if "fatal" in r:
                out.append({"err": "Fatal:" + str(r["fatal"])})
            elif "err" in r:
                out.append({"err": r["err"]})
            else:
                out.append({"ok": {k: str(v) for k, v in r["ok"].items()}})
        return out

    def ts_results(self, cases: list[tuple[str, list[Any]]]) -> list[dict[str, Any]]:
        reqs = []
        for fn, args in cases:
            self.next_id += 1
            reqs.append({"id": self.next_id, "fn": fn, "args": _json_args(args)})
        responses = self.ts.ask_batch(reqs)
        out = []
        for r in responses:
            if "fatal" in r:
                out.append({"err": "Fatal:" + str(r["fatal"])})
            elif "err" in r:
                out.append({"err": r["err"]})
            else:
                out.append({"ok": {k: str(v) for k, v in r["ok"].items()}})
        return out

    def check_batch(self, cases: list[tuple[str, list[Any]]]) -> list[tuple[int, list[str]]]:
        rust = self.rust_results(cases)
        ts = self.ts_results(cases)
        problems: list[tuple[int, list[str]]] = []
        for i, ((fn, args), r, t) in enumerate(zip(cases, rust, ts)):
            p = python_result(fn, args)
            msgs: list[str] = []
            if p != t:
                msgs.append(f"python={p} ts={t}")
            if fn in INVERSE_FNS:
                # The deprecated inverse has no Rust counterpart any more.
                # Compare Python/TS exactly, then cross-check the Python result
                # against the real on-chain calc_sell with the existing
                # one-share rounding tolerance.
                msgs.extend(self._cross_check_sell(fn, args, p))
            else:
                expected_err = expected_rust_error(fn, args)
                if expected_err:
                    if r != {"err": expected_err}:
                        msgs.append(f"expected Rust {expected_err}, got {r}")
                else:
                    if r != p:
                        msgs.append(f"rust={r} python={p}")
                    if r != t:
                        msgs.append(f"rust={r} ts={t}")
                if fn == "calc_sell_shares":
                    msgs.extend(self._cross_check_sell(fn, args, p))
                    if "ok" in p and "ok" in r:
                        k0 = int(args[0]) * int(args[1])
                        k1 = int(r["ok"]["new_reserve_sold"]) * int(r["ok"]["new_reserve_other"])
                        if k1 < k0:
                            msgs.append(f"calc_sell_shares decreased k: {k1} < {k0}")
            if msgs:
                problems.append((i, msgs))
        return problems

    def _cross_check_sell(self, fn: str, args: list[Any], p: dict[str, Any]) -> list[str]:
        """Check a share-quote against the forward on-chain `calc_sell`."""
        if "ok" not in p:
            return []
        target = int(args[2])
        fee = int(args[3])
        if fn == "gross_for_shares":
            coll = model.mul_div_floor(int(p["ok"]["gross"]), BPS - fee, BPS)
        else:
            coll = int(p["ok"]["collateral_out"])
        if coll <= 0:
            return []
        back = self.rust_results([("calc_sell", [args[0], args[1], str(coll), fee])])[0]
        msgs: list[str] = []
        if "ok" in back and int(back["ok"]["shares_in"]) > target + 1:
            msgs.append(
                f"sell cross-check: calc_sell({args[0]},{args[1]},{coll},{fee})"
                f" used {back['ok']['shares_in']} shares > target {target}+1"
            )
        if "err" in back:
            msgs.append(f"sell cross-check: Rust calc_sell={back}")
        return msgs

    def check_one(self, case: tuple[str, list[Any]]) -> list[str]:
        problems = self.check_batch([case])
        return problems[0][1] if problems else []


def _json_args(args: list[Any]) -> list[Any]:
    return [a if isinstance(a, (bool, int)) else str(a) for a in args]


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------

def log_uniform(rng: random.Random, lo_exp: int = 0, hi_exp: int = 18) -> int:
    exp = rng.randint(lo_exp, hi_exp)
    return rng.randint(1, 10) * (10 ** exp) // 10 if exp else rng.randint(0, 9)


def pick(rng: random.Random, values: list[int]) -> int:
    return rng.choice(values)


def maybe_huge(rng: random.Random, args: list[Any], indices: list[int]) -> list[Any]:
    if rng.random() < 0.02:
        i = rng.choice(indices)
        args[i] = str(rng.choice(HUGE))
    return args


def gen_case(rng: random.Random, klass: str | None = None) -> tuple[str, list[Any], str]:
    kinds = [
        "mul_div",
        "price",
        "seed",
        "calc_buy",
        "calc_sell",
        "sell_shares",
        "split_fee",
        "settle",
        "settle_upper",
        "merge_max",
        "inverse",
        "limit",
    ]
    klass = klass or rng.choice(kinds)
    if klass == "mul_div":
        fn = rng.choice(["mul_div_floor", "mul_div_ceil"])
        mode = rng.random()
        if mode < 0.25:
            a, b = rng.choice(BOUNDARIES), rng.choice(BOUNDARIES)
            c = rng.choice([1, 2, 3, 7, 10, 1000, 10_000, MAX_SETS])
        elif mode < 0.5:
            c = rng.choice([1, 2, 3, 7, 10, 1000])
            q = log_uniform(rng, 0, 15)
            a, b = q * c + rng.choice([0, c - 1]), rng.choice([1, 2, 3])
        else:
            a, b, c = log_uniform(rng), log_uniform(rng), log_uniform(rng, 1, 12)
            if c == 0:
                c = 1
        if rng.random() < 0.05:
            a = -a
        return fn, maybe_huge(rng, [str(a), str(b), str(c)], [0, 1]), klass
    if klass == "price":
        a = pick(rng, BOUNDARIES) or 1
        b = pick(rng, BOUNDARIES) or 1
        if rng.random() < 0.2:
            b = 0
        if rng.random() < 0.05:
            a = -a
        return "price_yes_bps", maybe_huge(rng, [str(a), str(b)], [0, 1]), klass
    if klass == "seed":
        s = pick(rng, BOUNDARIES) or 1
        p = rng.choice(PROBS)
        return "seed_reserves", [str(s), str(p)], klass
    if klass in ("calc_buy", "calc_sell"):
        rs = pick(rng, BOUNDARIES) or 1
        ro = pick(rng, BOUNDARIES) or 1
        if rng.random() < 0.5:
            amt = log_uniform(rng, 0, 15) or 1
        else:
            amt = rng.randint(1, max(1, ro // 2))
        fee = rng.choice(FEES)
        return klass, maybe_huge(rng, [str(rs), str(ro), str(amt), str(fee)], [0, 1, 2]), klass
    if klass == "settle":
        kind = rng.choice(["yes", "no", "void"])
        return "settle_value", [kind, str(log_uniform(rng, 0, 15)), str(log_uniform(rng, 0, 15))], klass
    if klass == "sell_shares":
        rs = pick(rng, BOUNDARIES) or 1
        ro = pick(rng, BOUNDARIES) or 1
        fee = rng.choice(FEES[:7])
        # Tiny share counts exercise the collateral-floors-to-zero branch;
        # targets derived from a forward sell exercise the real round trip.
        if rng.random() < 0.2:
            sh = rng.choice([1, 2, 3, 5, 10])
        else:
            sh = None
            if fee < BPS:
                for _ in range(20):
                    try:
                        out = rng.randint(1, max(1, ro // 4))
                        sh = model.calc_sell(rs, ro, out, fee).shares_in
                        break
                    except model.MathError:
                        rs = pick(rng, BOUNDARIES) or 1
                        ro = pick(rng, BOUNDARIES) or 1
            if sh is None:
                sh = log_uniform(rng, 0, 15) or 1
        # Occasionally probe the MAX_SETS boundary headroom.
        if rng.random() < 0.05:
            rs = ro = MAX_SETS
            sh = MAX_SETS // 2 if rng.random() < 0.5 else sh
        return "calc_sell_shares", maybe_huge(
            rng, [str(rs), str(ro), str(sh), str(fee)], [0, 1, 2]
        ), klass
    if klass == "split_fee":
        fee = log_uniform(rng, 0, 15)
        share = rng.choice([0, 1, 3333, 5000, 9999, BPS, BPS + 1])
        if rng.random() < 0.05:
            fee = -fee
        return "split_fee", [str(fee), str(share)], klass
    if klass == "settle_upper":
        kind = rng.choice(["yes", "no", "void"])
        return "settle_upper", [kind, str(log_uniform(rng, 0, 15)), str(log_uniform(rng, 0, 15))], klass
    if klass == "merge_max":
        a, b = log_uniform(rng), log_uniform(rng)
        if rng.random() < 0.1:
            a = -a
        return "merge_max", [str(a), str(b)], klass
    if klass == "inverse":
        fn = rng.choice(["gross_for_shares", "collateral_out_for_shares"])
        rs = pick(rng, BOUNDARIES) or 1
        ro = pick(rng, BOUNDARIES) or 1
        fee = rng.choice(FEES[:6])
        # Derive the share target from a real forward sell, matching the
        # documented round-trip property (the quadratic ignores rounding).
        sh = None
        if fee < BPS:
            for _ in range(20):
                try:
                    out = rng.randint(1, max(1, ro // 4))
                    sh = model.calc_sell(rs, ro, out, fee).shares_in
                    break
                except model.MathError:
                    rs = pick(rng, BOUNDARIES) or 1
                    ro = pick(rng, BOUNDARIES) or 1
        if sh is None:
            sh = log_uniform(rng, 0, 15) or 1
        return fn, [str(rs), str(ro), str(sh), str(fee)], klass
    if klass == "limit":
        fn = rng.choice(["buy_within_limit", "sell_within_limit", "price_after"])
        if fn == "price_after":
            return fn, [rng.choice([True, False]), str(log_uniform(rng)), str(log_uniform(rng))], klass
        return fn, [str(log_uniform(rng)), str(log_uniform(rng) or 1), str(rng.choice(FEES))], klass
    raise AssertionError(klass)


# ---------------------------------------------------------------------------
# Shrinking
# ---------------------------------------------------------------------------

def shrink(harness: Harness, fn: str, args: list[Any], max_steps: int = 80) -> list[Any]:
    current = list(args)
    boundaries = [0, 1, 2, 3, 5, 10, 99, 100, 101, 999, 1000, 10_000, MIN_SEED, MAX_SETS]
    for _ in range(max_steps):
        improved = False
        for i, value in enumerate(current):
            if isinstance(value, str) and str(value) in ("yes", "no", "void"):
                continue
            if isinstance(value, bool):
                continue
            try:
                n = int(value)
            except (TypeError, ValueError):
                continue
            candidates = [0, 1, n // 2, n - 1, n + 1]
            candidates += [b for b in boundaries if abs(b - n) < abs(n)]
            candidates = sorted({c for c in candidates if c >= 0 and c < n}, key=lambda c: (c, c))
            for cand in candidates[:12]:
                trial = list(current)
                trial[i] = str(cand)
                if trial == current:
                    continue
                if harness.check_one((fn, trial)):
                    current = trial
                    improved = True
                    break
            if improved:
                break
        if not improved:
            break
    return current


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def replay_vectors(harness: Harness) -> int:
    if not VECTORS.exists():
        print(f"warning: no vectors at {VECTORS}")
        return 0
    cases = []
    expected = []
    for line_no, line in enumerate(VECTORS.read_text().splitlines(), 1):
        if not line.strip():
            continue
        v = json.loads(line)
        cases.append((v["fn"], list(v["args"])))
        expected.append((line_no, v))
    rust = harness.rust_results(cases)
    ts = harness.ts_results(cases)
    failures = 0
    for (fn, args), r, t, (line_no, v) in zip(cases, rust, ts, expected):
        p = python_result(fn, args)
        want = {"ok": {k: str(x) for k, x in v["ok"].items()}} if "ok" in v else {"err": v["err"]}
        if not (p == want == t == r):
            failures += 1
            print(f"VECTOR line {line_no} ({fn} {args}) mismatch")
            print(f"  expected={want}")
            print(f"  python={p} ts={t} rust={r}")
    print(f"replayed {len(cases)} vectors, {failures} failure(s)")
    return failures


def append_vector(fn: str, args: list[Any], result: dict[str, Any]) -> None:
    entry: dict[str, Any] = {"fn": fn, "args": [str(a) for a in args]}
    entry.update(result)
    with VECTORS.open("a") as fh:
        fh.write(json.dumps(entry, separators=(",", ":"), sort_keys=True) + "\n")


def run_self_test(harness: Harness, seed: int) -> int:
    """Inject a deliberate bug and assert the harness catches + shrinks it."""
    original = model.mul_div_ceil
    model.mul_div_ceil = lambda a, b, c: (a * b) // c  # bug: floor instead of ceil
    try:
        rng = random.Random(seed)
        mismatches = []
        for _ in range(300):
            fn, args, _ = gen_case(rng, "mul_div")
            if fn == "mul_div_ceil":
                if harness.check_one((fn, args)):
                    mismatches.append((fn, args))
                    break
        if not mismatches:
            print("self-test FAILED: injected floor/ceil bug was not detected")
            return 1
        fn, args = mismatches[0]
        shrunk = shrink(harness, fn, args)
        print(f"self-test found mismatch for {fn} {args}, shrunk to {shrunk}")
        # The shrunk case must still disagree.
        if not harness.check_one((fn, shrunk)):
            print("self-test FAILED: shrunk case no longer disagrees")
            return 1
        print("self-test passed")
        return 0
    finally:
        model.mul_div_ceil = original


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="1", help="integer seed or 'random'")
    ap.add_argument("--count", type=int, default=50_000)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--append", action="store_true", help="append mismatches to vectors.jsonl")
    ap.add_argument("--no-build", action="store_true")
    args = ap.parse_args()

    seed = random.SystemRandom().randrange(1 << 32) if args.seed == "random" else int(args.seed)
    print(f"fpmm-diff seed={seed} count={args.count}")

    try:
        harness = Harness(build=not args.no_build)
    except FileNotFoundError as exc:
        print(f"failed to start an oracle: {exc}", file=sys.stderr)
        return 2

    try:
        failures = replay_vectors(harness)
        if failures:
            return 1
        if args.self_test:
            return run_self_test(harness, seed)

        rng = random.Random(seed)
        class_counts: dict[str, int] = {}
        mismatches = 0
        expected_overflow = 0
        batch: list[tuple[str, list[Any]]] = []
        batch_meta: list[tuple[str, list[Any], str]] = []

        def flush() -> int:
            nonlocal mismatches, expected_overflow
            if not batch:
                return 0
            problems = harness.check_batch(batch)
            problem_map = dict(problems)
            found = 0
            for i, (fn, a) in enumerate(batch):
                if expected_rust_error(fn, a) == "Overflow":
                    expected_overflow += 1
                if i in problem_map:
                    found += 1
                    if found == 1:
                        print(f"\nMISMATCH {fn} {a}")
                        for msg in problem_map[i]:
                            print(f"  {msg}")
                        shrunk = shrink(harness, fn, a)
                        print(f"  shrunk: {fn} {shrunk}")
                        py = python_result(fn, shrunk)
                        if args.append:
                            append_vector(fn, shrunk, py)
                            print(f"  appended to {VECTORS.relative_to(ROOT)}")
            batch.clear()
            batch_meta.clear()
            return found

        total = args.count
        for i in range(total):
            fn, a, klass = gen_case(rng)
            class_counts[klass] = class_counts.get(klass, 0) + 1
            batch.append((fn, a))
            batch_meta.append((fn, a, klass))
            if len(batch) >= 1000:
                mismatches += flush()
                print(f"\r{i + 1}/{total} comparisons", end="", flush=True)
        mismatches += flush()
        print()
        print("classes: " + ", ".join(f"{k}={v}" for k, v in sorted(class_counts.items())))
        print(f"compared {total} cases, expected i128 overflows={expected_overflow}, mismatches={mismatches}")
        if expected_overflow > total * 0.05:
            print(
                f"FAIL: {expected_overflow}/{total} cases overflowed i128 "
                "(>5% skipped weakens the comparison)",
                file=sys.stderr,
            )
            return 1
        if mismatches:
            return 1
        print("fpmm-diff: all implementations agree")
        return 0
    finally:
        harness.close()


if __name__ == "__main__":
    raise SystemExit(main())
