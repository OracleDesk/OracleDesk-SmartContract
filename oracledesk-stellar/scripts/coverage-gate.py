#!/usr/bin/env python3
"""Coverage gate: per-package minimums and a no-decrease rule against a base.

    coverage-gate.py [--lcov coverage/lcov.info] [--thresholds coverage/thresholds.json]
                     [--base PATH-TO-BASE-lcov.info] [--max-drop 0.5]
    coverage-gate.py --self-test

Fails (exit 1) when
  * a package's line coverage is below its minimum in thresholds.json, or
  * (with --base) a package's line coverage dropped by more than --max-drop
    percentage points versus the base report, or
  * a package listed in thresholds.json has no coverage data at all.

Without --base (the first run, or no base artifact yet) the delta check is
skipped with a notice. Standard library only; package prefixes are shared
with coverage-tools.py.
"""

import argparse
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("coverage_tools", os.path.join(HERE, "coverage-tools.py"))
tools = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tools)


def percentages(lcov_text):
    return {pkg: tools.pct(h, f) for pkg, (h, f) in tools.line_stats(tools.parse_lcov(lcov_text)).items()}


def evaluate(current, thresholds, base, max_drop):
    """-> (rows, failures). `current`/`base` map package -> percent."""
    rows, failures = [], []
    for pkg in tools.PACKAGES:
        if pkg not in current and pkg not in thresholds:
            continue
        cur = current.get(pkg)
        minimum = thresholds.get(pkg)
        prev = base.get(pkg) if base is not None else None
        status = []
        if cur is None:
            failures.append(f"{pkg}: no coverage data (listed in thresholds.json)")
            status.append("NO DATA")
        else:
            if minimum is not None and cur < minimum:
                failures.append(f"{pkg}: {cur:.1f}% is below the minimum {minimum}%")
                status.append("BELOW MIN")
            if prev is not None and prev - cur > max_drop:
                failures.append(f"{pkg}: dropped {prev - cur:.2f} points ({prev:.1f}% -> {cur:.1f}%), limit {max_drop}")
                status.append("DROPPED")
        rows.append((pkg, cur, minimum, prev, ", ".join(status) or "ok"))
    return rows, failures


def render(rows):
    out = ["| package | line coverage | minimum | base | status |", "|---|---:|---:|---:|---|"]
    for pkg, cur, minimum, prev, status in rows:
        f = lambda v: "-" if v is None else f"{v:.1f}%" if isinstance(v, float) else f"{v}%"
        out.append(f"| {pkg} | {f(cur)} | {f(minimum)} | {f(prev)} | {status} |")
    return "\n".join(out)


def self_test():
    def lcov(pkg_prefix, hit, found):
        das = "\n".join(f"DA:{i},{1 if i <= hit else 0}" for i in range(1, found + 1))
        return f"SF:{pkg_prefix}a.rs\n{das}\nend_of_record\n"

    good = percentages(lcov("contracts/resolver/", 80, 100) + lcov("agents/", 70, 100))
    assert round(good["resolver"]) == 80 and round(good["agents"]) == 70, good
    thresholds = {"resolver": 75, "agents": 65}

    # pass
    rows, fails = evaluate(good, thresholds, None, 0.5)
    assert not fails and all(r[4] == "ok" for r in rows), (rows, fails)
    # below minimum
    low = percentages(lcov("contracts/resolver/", 74, 100) + lcov("agents/", 70, 100))
    _, fails = evaluate(low, thresholds, None, 0.5)
    assert len(fails) == 1 and "resolver" in fails[0] and "below the minimum" in fails[0], fails
    # drop versus base beyond the limit, and exactly at the limit
    base = {"resolver": 80.0, "agents": 70.0}
    _, fails = evaluate(percentages(lcov("contracts/resolver/", 79, 100) + lcov("agents/", 70, 100)), {}, base, 0.5)
    assert len(fails) == 1 and "dropped 1.00" in fails[0], fails
    _, fails = evaluate({"resolver": 79.5, "agents": 70.0}, {}, base, 0.5)
    assert not fails, fails
    # a package with a threshold but no data fails
    _, fails = evaluate({"agents": 70.0}, {"resolver": 10}, None, 0.5)
    assert fails and "no coverage data" in fails[0], fails
    # end to end through files, including a missing base
    with tempfile.TemporaryDirectory() as d:
        cur_p, th_p = os.path.join(d, "lcov.info"), os.path.join(d, "t.json")
        open(cur_p, "w").write(lcov("contracts/resolver/", 80, 100))
        json.dump({"resolver": 75}, open(th_p, "w"))
        assert run(argparse.Namespace(lcov=cur_p, thresholds=th_p, base=os.path.join(d, "missing"), max_drop=0.5)) == 0
        assert run(argparse.Namespace(lcov=cur_p, thresholds=th_p, base=None, max_drop=0.5)) == 0
        json.dump({"resolver": 90}, open(th_p, "w"))
        assert run(argparse.Namespace(lcov=cur_p, thresholds=th_p, base=None, max_drop=0.5)) == 1
    print("coverage-gate self-test ok")
    return 0


def run(args):
    current = percentages(open(args.lcov, encoding="utf-8").read())
    thresholds = {}
    if args.thresholds and os.path.exists(args.thresholds):
        thresholds = {k: v for k, v in json.load(open(args.thresholds)).items() if not k.startswith("_")}
    base = None
    if args.base:
        if os.path.exists(args.base):
            base = percentages(open(args.base, encoding="utf-8").read())
        else:
            print(f"notice: base report {args.base} not found; skipping the no-decrease check (first run?)")
    rows, failures = evaluate(current, thresholds, base, args.max_drop)
    print(render(rows))
    if failures:
        print("\ncoverage gate FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\ncoverage gate passed")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lcov", default="coverage/lcov.info")
    ap.add_argument("--thresholds", default="coverage/thresholds.json")
    ap.add_argument("--base", help="lcov.info of the base branch")
    ap.add_argument("--max-drop", type=float, default=0.5, help="allowed drop in percentage points")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    sys.exit(self_test() if args.self_test else run(args))


if __name__ == "__main__":
    main()
