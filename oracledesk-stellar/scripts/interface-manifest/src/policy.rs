use crate::{
    diff::{Class, Report},
    Manifest,
};
use semver::Version;
use std::{path::Path, process::Command};
pub fn required_version(old: &Version, class: Class) -> Version {
    match class {
        Class::Breaking if old.major == 0 => Version::new(0, old.minor + 1, 0),
        Class::Breaking => Version::new(old.major + 1, 0, 0),
        Class::Additive => Version::new(old.major, old.minor, old.patch + 1),
        Class::Cosmetic => old.clone(),
    }
}
pub fn validate(
    report: &Report,
    old: &Version,
    new: &Version,
    changelog: &str,
) -> Result<(), String> {
    let required = required_version(old, report.classification);
    if new < &required || !new.pre.is_empty() {
        return Err(format!(
            "{}: {:?} change ({}) requires version >= {}, found {}",
            report.contract,
            report.classification,
            report
                .changes
                .iter()
                .filter(|c| c.class == report.classification)
                .map(|c| c.item.as_str())
                .collect::<Vec<_>>()
                .join("; "),
            required,
            new
        ));
    }
    if new != old {
        let heading = format!("## {new}");
        let mut body = String::new();
        let mut inside = false;
        for line in changelog.lines() {
            if line.starts_with("## ") {
                if inside {
                    break;
                }
                inside = line.trim() == heading;
            } else if inside {
                body.push_str(line);
                body.push('\n');
            }
        }
        if body.trim().is_empty() {
            return Err(format!(
                "{}: missing nonempty CHANGELOG.md heading {heading}",
                report.contract
            ));
        }
        for c in &report.changes {
            if c.class == Class::Breaking && !body.contains(&c.item) {
                return Err(format!(
                    "{}: {heading} must list breaking item verbatim: {}",
                    report.contract, c.item
                ));
            }
        }
    }
    Ok(())
}
fn git_file(base: &str, path: &str) -> Result<Option<Vec<u8>>, Box<dyn std::error::Error>> {
    let out = Command::new("git")
        .args(["show", &format!("{base}:{path}")])
        .output()?;
    Ok(out.status.success().then_some(out.stdout))
}
pub fn check(pkg: &Path, base: &str) -> Result<String, Box<dyn std::error::Error>> {
    if !Command::new("git")
        .args(["rev-parse", "--verify", &format!("{base}^{{commit}}")])
        .output()?
        .status
        .success()
    {
        return Err(format!("Base ref does not exist: {base}").into());
    }
    let root = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "--show-toplevel"])
            .output()?
            .stdout,
    )?;
    let full = pkg.canonicalize()?;
    let rel = full.strip_prefix(root.trim())?.to_string_lossy();
    let new: Manifest = serde_json::from_slice(&std::fs::read(full.join("interface.json"))?)?;
    let new_pkg: serde_json::Value =
        serde_json::from_slice(&std::fs::read(full.join("package.json"))?)?;
    let b = Version::parse(new_pkg["version"].as_str().ok_or("Missing version")?)?;
    let changelog = std::fs::read_to_string(full.join("CHANGELOG.md")).unwrap_or_default();
    let Some(bytes) = git_file(base, &format!("{rel}/interface.json"))? else {
        let initial = Report {
            contract: new.contract.clone(),
            classification: Class::Additive,
            changes: vec![],
        };
        validate(&initial, &Version::new(0, 0, 0), &b, &changelog)?;
        return Ok(format!("{}: initial ({b})", new.contract));
    };
    let old: Manifest = serde_json::from_slice(&bytes)?;
    if old.schema != new.schema || old.contract != new.contract {
        return Err("Manifest schema/contract mismatch".into());
    }
    let old_pkg: serde_json::Value = serde_json::from_slice(
        &git_file(base, &format!("{rel}/package.json"))?.ok_or("Missing base package.json")?,
    )?;
    let a = Version::parse(old_pkg["version"].as_str().ok_or("Missing old version")?)?;
    let report = crate::diff::diff(&old, &new);
    validate(&report, &a, &b, &changelog)?;
    Ok(report.text())
}
