#!/usr/bin/env python3
"""Helpers for scripts/coverage.sh. Standard library only.

    coverage-tools.py rust-filter RAW OUT      repo-relative paths, test modules removed
    coverage-tools.py ts-rebase   PKG IN OUT   prefix a TS package's SF: paths with PKG/
    coverage-tools.py merge       OUT IN...    concatenate lcov files
    coverage-tools.py summary     LCOV         per-package table (markdown)
    coverage-tools.py html        LCOV OUTDIR  dependency-free HTML report
    coverage-tools.py --self-test

Package = the first matching prefix in PACKAGES (shared with coverage-gate.py).
"""

import html
import os
import re
import sys

# Longest-prefix first is not needed: prefixes are disjoint.
PACKAGES = {
    "market-core": "contracts/market-core/",
    "resolver": "contracts/resolver/",
    "treasury": "contracts/treasury/",
    "reasoning-registry": "contracts/reasoning-registry/",
    "router": "contracts/router/",
    "timelock": "contracts/timelock/",
    "x402": "x402/",
    "agents": "agents/",
}


def package_of(path):
    for name, prefix in PACKAGES.items():
        if path.startswith(prefix):
            return name
    return None


# ---------------------------------------------------------------------------
# lcov parsing / writing
# ---------------------------------------------------------------------------


def parse_lcov(text):
    """-> {path: {"DA": {line: hits}, "BRDA": [(line, block, branch, taken)],
    "FN": {name: line}, "FNDA": {name: hits}}}. Records for one file merge."""
    files = {}
    cur = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("SF:"):
            cur = files.setdefault(line[3:], {"DA": {}, "BRDA": [], "FN": {}, "FNDA": {}})
        elif line == "end_of_record":
            cur = None
        elif cur is None:
            continue
        elif line.startswith("DA:"):
            n, hits = line[3:].split(",")[:2]
            n, hits = int(n), int(hits)
            cur["DA"][n] = cur["DA"].get(n, 0) + hits
        elif line.startswith("BRDA:"):
            a, b, c, d = line[5:].split(",")
            cur["BRDA"].append((int(a), b, c, 0 if d == "-" else int(d)))
        elif line.startswith("FN:"):
            n, name = line[3:].split(",", 1)
            cur["FN"][name] = int(n)
        elif line.startswith("FNDA:"):
            hits, name = line[5:].split(",", 1)
            cur["FNDA"][name] = cur["FNDA"].get(name, 0) + int(hits)
    return files


def write_lcov(files):
    out = []
    for path in sorted(files):
        f = files[path]
        out.append("TN:")
        out.append(f"SF:{path}")
        for name, n in sorted(f["FN"].items(), key=lambda kv: kv[1]):
            out.append(f"FN:{n},{name}")
        for name in f["FN"]:
            out.append(f"FNDA:{f['FNDA'].get(name, 0)},{name}")
        out.append(f"FNF:{len(f['FN'])}")
        out.append(f"FNH:{sum(1 for n in f['FN'] if f['FNDA'].get(n, 0) > 0)}")
        for a, b, c, d in f["BRDA"]:
            out.append(f"BRDA:{a},{b},{c},{d if d else '-'}")
        out.append(f"BRF:{len(f['BRDA'])}")
        out.append(f"BRH:{sum(1 for x in f['BRDA'] if x[3] > 0)}")
        for n in sorted(f["DA"]):
            out.append(f"DA:{n},{f['DA'][n]}")
        out.append(f"LF:{len(f['DA'])}")
        out.append(f"LH:{sum(1 for h in f['DA'].values() if h > 0)}")
        out.append("end_of_record")
    return "\n".join(out) + "\n"


def line_stats(files):
    """-> {package: (lines_hit, lines_found)}"""
    stats = {}
    for path, f in files.items():
        pkg = package_of(path)
        if pkg is None:
            continue
        hit, found = stats.get(pkg, (0, 0))
        stats[pkg] = (
            hit + sum(1 for h in f["DA"].values() if h > 0),
            found + len(f["DA"]),
        )
    return stats


# ---------------------------------------------------------------------------
# Rust: repo-relative paths, inline test modules removed
# ---------------------------------------------------------------------------


def test_module_start(source_lines):
    """1-based line of the first `#[cfg(test)]` that gates a *module*.

    Every contract keeps its inline tests in trailing `#[cfg(test)] mod ...`
    blocks (plus helpers gated the same way), so everything from there to the
    end of the file is test code. A `#[cfg(test)]` on another kind of item
    (e.g. `extern crate std;`) is not a boundary."""
    for i, line in enumerate(source_lines):
        if line.strip() != "#[cfg(test)]":
            continue
        for nxt in source_lines[i + 1 : i + 4]:
            s = nxt.strip()
            if s.startswith("#[") or not s:
                continue
            if re.match(r"(pub(\([a-z]+\))? )?mod \w+", s):
                return i + 1
            break
    return None


def rust_filter(raw_text, root):
    files = parse_lcov(raw_text)
    out = {}
    for path, f in files.items():
        rel = os.path.relpath(path, root) if os.path.isabs(path) else path
        if rel.startswith("..") or not rel.startswith("contracts/"):
            continue
        try:
            with open(os.path.join(root, rel), encoding="utf-8") as fh:
                cut = test_module_start(fh.read().splitlines())
        except OSError:
            cut = None
        if cut is not None:
            f["DA"] = {n: h for n, h in f["DA"].items() if n < cut}
            f["BRDA"] = [b for b in f["BRDA"] if b[0] < cut]
            f["FN"] = {k: v for k, v in f["FN"].items() if v < cut}
            f["FNDA"] = {k: v for k, v in f["FNDA"].items() if k in f["FN"]}
        if f["DA"]:
            out[rel] = f
    return write_lcov(out)


def ts_rebase(pkg, text):
    files = parse_lcov(text)
    return write_lcov({f"{pkg}/{p}": f for p, f in files.items()})


def merge(texts):
    merged = {}
    for t in texts:
        for path, f in parse_lcov(t).items():
            m = merged.setdefault(path, {"DA": {}, "BRDA": [], "FN": {}, "FNDA": {}})
            for n, h in f["DA"].items():
                m["DA"][n] = m["DA"].get(n, 0) + h
            m["BRDA"] += f["BRDA"]
            m["FN"].update(f["FN"])
            for k, v in f["FNDA"].items():
                m["FNDA"][k] = m["FNDA"].get(k, 0) + v
    return write_lcov(merged)


# ---------------------------------------------------------------------------
# reports
# ---------------------------------------------------------------------------


def pct(hit, found):
    return 100.0 * hit / found if found else 0.0


def summary(text):
    files = parse_lcov(text)
    stats = line_stats(files)
    lines = ["| package | lines hit | lines found | line coverage |", "|---|---:|---:|---:|"]
    th = tf = 0
    for name in PACKAGES:
        if name not in stats:
            continue
        h, f = stats[name]
        th, tf = th + h, tf + f
        lines.append(f"| {name} | {h} | {f} | {pct(h, f):.1f}% |")
    lines.append(f"| **all** | {th} | {tf} | {pct(th, tf):.1f}% |")
    return "\n".join(lines)


def html_report(text, outdir):
    files = parse_lcov(text)
    stats = line_stats(files)
    os.makedirs(outdir, exist_ok=True)
    rows = []
    for name in PACKAGES:
        if name in stats:
            h, f = stats[name]
            rows.append(f"<tr><td>{name}</td><td>{h}</td><td>{f}</td><td>{pct(h, f):.1f}%</td></tr>")
    detail = []
    for path in sorted(files):
        d = files[path]["DA"]
        h = sum(1 for v in d.values() if v > 0)
        missed = [n for n, v in sorted(d.items()) if v == 0]
        detail.append(
            f"<tr><td>{html.escape(path)}</td><td>{h}/{len(d)}</td><td>{pct(h, len(d)):.1f}%</td>"
            f"<td class='m'>{html.escape(_ranges(missed))}</td></tr>"
        )
    page = f"""<!doctype html><meta charset="utf-8"><title>OracleDesk coverage</title>
<style>body{{font:14px system-ui;margin:2rem;max-width:72rem}}table{{border-collapse:collapse;width:100%;margin:1rem 0}}
td,th{{border:1px solid #8884;padding:.3rem .6rem;text-align:left}}.m{{font:12px ui-monospace,monospace;word-break:break-all}}</style>
<h1>Coverage</h1><p>Line coverage from <code>coverage/lcov.info</code>. Rust excludes inline test modules.</p>
<h2>Packages</h2><table><tr><th>package</th><th>hit</th><th>found</th><th>line coverage</th></tr>{''.join(rows)}</table>
<h2>Files</h2><table><tr><th>file</th><th>hit/found</th><th>%</th><th>uncovered lines</th></tr>{''.join(detail)}</table>"""
    with open(os.path.join(outdir, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page)


def _ranges(nums):
    out, start, prev = [], None, None
    for n in nums:
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append(f"{start}" if start == prev else f"{start}-{prev}")
            start = prev = n
    if start is not None:
        out.append(f"{start}" if start == prev else f"{start}-{prev}")
    return ", ".join(out)


# ---------------------------------------------------------------------------


def self_test():
    src = ["extern crate std;", "#[cfg(test)]", "extern crate std;", "fn a() {}", "", "#[cfg(test)]", "mod test {", "}"]
    assert test_module_start(src) == 6, test_module_start(src)
    assert test_module_start(["fn a() {}"]) is None
    a = "SF:contracts/resolver/src/lib.rs\nFN:3,f\nFNDA:1,f\nDA:3,1\nDA:4,0\nBRDA:3,0,0,1\nBRDA:3,0,1,-\nend_of_record\n"
    b = "SF:contracts/resolver/src/lib.rs\nFN:3,f\nFNDA:2,f\nDA:3,0\nDA:4,5\nend_of_record\n"
    m = parse_lcov(merge([a, b]))["contracts/resolver/src/lib.rs"]
    assert m["DA"] == {3: 1, 4: 5} and m["FNDA"]["f"] == 3, m
    assert line_stats({"contracts/resolver/src/lib.rs": m}) == {"resolver": (2, 2)}
    assert line_stats(parse_lcov(a)) == {"resolver": (1, 2)}
    rebased = parse_lcov(ts_rebase("agents", "SF:core/fpmm.ts\nDA:1,1\nend_of_record\n"))
    assert list(rebased) == ["agents/core/fpmm.ts"]
    assert _ranges([1, 2, 3, 7, 9, 10]) == "1-3, 7, 9-10"
    print("coverage-tools self-test ok")


def main(argv):
    if argv[:1] == ["--self-test"]:
        return self_test()
    cmd, args = argv[0], argv[1:]
    read = lambda p: open(p, encoding="utf-8").read()
    write = lambda p, t: open(p, "w", encoding="utf-8").write(t)
    if cmd == "rust-filter":
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        write(args[1], rust_filter(read(args[0]), root))
    elif cmd == "ts-rebase":
        write(args[2], ts_rebase(args[0], read(args[1])))
    elif cmd == "merge":
        write(args[0], merge([read(p) for p in args[1:]]))
    elif cmd == "summary":
        print(summary(read(args[0])))
    elif cmd == "html":
        html_report(read(args[0]), args[1])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
