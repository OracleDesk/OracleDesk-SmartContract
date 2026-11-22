#!/usr/bin/env node
/**
 * Supply-chain npm audit gate across all OracleDesk TypeScript packages (#126).
 *
 * - Runs `npm audit --omit=dev --json` for each package directory (or root workspace).
 * - Deduplicates advisories across packages (avoids repeat reports from `file:` bindings).
 * - Fails on any `high` or `critical` production advisory not covered by an
 *   unexpired entry in `security/npm-audit-allowlist.json`.
 * - Fails if any allowlist entry is expired or malformed.
 * - Ignores dev-only advisories (reported only when present).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const DEFAULT_PACKAGE_DIRS = [
  "x402",
  "agents",
  "packages/bindings/market-core",
  "packages/bindings/resolver",
  "packages/bindings/treasury",
  "packages/bindings/reasoning-registry",
  "packages/bindings/timelock",
  "packages/bindings/router",
  "scripts/governance",
];

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/**
 * Extract normalized production advisories from `npm audit --omit=dev --json` output.
 */
export function parseAuditReport(reportJson, sourceDir) {
  const findings = [];
  const vulns = reportJson?.vulnerabilities ?? {};
  for (const [pkgName, info] of Object.entries(vulns)) {
    const viaList = Array.isArray(info?.via) ? info.via : [];
    for (const via of viaList) {
      if (!via || typeof via !== "object") continue;
      const severity = String(via.severity ?? info.severity ?? "low").toLowerCase();
      const url = String(via.url ?? "");
      const ghsaMatch = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
      const id = ghsaMatch ? ghsaMatch[0].toUpperCase() : String(via.source ?? via.title ?? pkgName);
      findings.push({
        id,
        package: String(via.name ?? pkgName),
        severity,
        title: String(via.title ?? "Unknown advisory"),
        url,
        devOnly: Boolean(info.isDirect === false && info.dev === true) || Boolean(info.dev === true),
        sources: [sourceDir],
      });
    }
  }
  return findings;
}

/**
 * Deduplicate findings by `(id, package)` while merging source directories.
 */
export function deduplicateFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = `${f.id}::${f.package}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...f, sources: [...new Set(f.sources)] });
    } else {
      existing.sources = [...new Set([...existing.sources, ...f.sources])];
      existing.devOnly = existing.devOnly && f.devOnly;
    }
  }
  return Array.from(map.values());
}

/**
 * Evaluate findings against the allowlist and current date (`YYYY-MM-DD`).
 */
export function evaluateAuditGate(findings, allowlistEntries, todayIso = new Date().toISOString().slice(0, 10)) {
  const expiredEntries = [];
  const activeAllowlist = new Map();

  for (const entry of allowlistEntries) {
    if (!entry?.id || !entry?.package || !entry?.reason || !entry?.expires) {
      expiredEntries.push({
        id: String(entry?.id ?? "UNKNOWN"),
        package: String(entry?.package ?? "UNKNOWN"),
        reason: "Malformed allowlist entry (requires id, package, reason, expires)",
      });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || entry.expires < todayIso) {
      expiredEntries.push({
        id: entry.id,
        package: entry.package,
        expires: entry.expires,
        reason: `Allowlist entry expired on ${entry.expires} (today: ${todayIso})`,
      });
      continue;
    }
    activeAllowlist.set(`${entry.id.toUpperCase()}::${entry.package}`, entry);
  }

  const deduped = deduplicateFindings(findings);
  const blocked = [];
  const allowlisted = [];
  const ignoredDevOnly = [];

  for (const finding of deduped) {
    if (finding.devOnly) {
      ignoredDevOnly.push(finding);
      continue;
    }
    if (!BLOCKING_SEVERITIES.has(finding.severity)) {
      continue;
    }
    const key = `${finding.id.toUpperCase()}::${finding.package}`;
    if (activeAllowlist.has(key)) {
      allowlisted.push({ finding, entry: activeAllowlist.get(key) });
    } else {
      blocked.push(finding);
    }
  }

  return {
    ok: expiredEntries.length === 0 && blocked.length === 0,
    blocked,
    expiredEntries,
    allowlisted,
    ignoredDevOnly,
  };
}

function runNpmAudit(dir, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, report: JSON.parse(stdout) };
    } catch (err) {
      if (err?.stdout) {
        try {
          const parsed = JSON.parse(String(err.stdout));
          if (parsed && !parsed.error) {
            return { ok: true, report: parsed };
          }
          lastErr = new Error(parsed?.error?.summary ?? "npm audit error");
        } catch {
          lastErr = err;
        }
      } else {
        lastErr = err;
      }
    }
  }
  return { ok: false, error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}

function main() {
  const allowlistPath = process.env.NPM_AUDIT_ALLOWLIST
    ? resolve(process.env.NPM_AUDIT_ALLOWLIST)
    : join(ROOT, "security/npm-audit-allowlist.json");
  const allowlist = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, "utf8")).entries ?? []
    : [];
  const strictNetwork = process.env.NPM_AUDIT_STRICT_NETWORK === "1";

  const dirsToScan = existsSync(join(ROOT, "package-lock.json"))
    ? ["."]
    : DEFAULT_PACKAGE_DIRS.filter((d) => existsSync(join(ROOT, d, "package-lock.json")));

  const allFindings = [];
  const networkWarnings = [];

  for (const rel of dirsToScan) {
    const abs = join(ROOT, rel);
    const res = runNpmAudit(abs);
    if (!res.ok) {
      networkWarnings.push({ dir: rel, error: res.error });
      continue;
    }
    allFindings.push(...parseAuditReport(res.report, rel));
  }

  if (networkWarnings.length > 0) {
    for (const w of networkWarnings) {
      console.warn(`WARNING: npm audit failed for ${w.dir}: ${w.error}`);
    }
    if (strictNetwork) {
      console.error("FAIL: strict network mode enabled (scheduled run) and npm audit could not reach registry.");
      process.exit(1);
    }
  }

  const result = evaluateAuditGate(allFindings, allowlist);
  if (result.expiredEntries.length > 0) {
    console.error("FAIL: expired or invalid npm audit allowlist entries:");
    for (const e of result.expiredEntries) {
      console.error(`  - ${e.id} (${e.package}): ${e.reason}`);
    }
  }
  if (result.blocked.length > 0) {
    console.error("FAIL: unlisted high/critical production advisories found:");
    for (const b of result.blocked) {
      console.error(
        `  - [${b.severity}] ${b.id} in ${b.package}: ${b.title} (packages: ${b.sources.join(", ")})`
      );
    }
  }
  if (!result.ok) {
    process.exit(1);
  }
  console.log(
    `OK: npm audit gate passed across ${dirsToScan.length} lockfile(s) (${result.allowlisted.length} allowlisted, ${result.ignoredDevOnly.length} dev-only ignored).`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
