use crate::{Definition, Manifest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    Cosmetic,
    Additive,
    Breaking,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub item: String,
    pub class: Class,
    pub adr0001: bool,
    pub deploy_affecting: bool,
    pub defining_contract: String,
    pub warning: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Report {
    pub contract: String,
    pub classification: Class,
    pub changes: Vec<Change>,
}
fn without_docs(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| k.as_str() != "doc")
                .map(|(k, v)| (k.clone(), without_docs(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(without_docs).collect()),
        _ => v.clone(),
    }
}
fn cases(d: &Definition) -> BTreeMap<String, Value> {
    d.spec["cases"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let c = if d.kind == "udt_union_v0" {
                c.as_object().unwrap().values().next().unwrap()
            } else {
                c
            };
            (c["name"].as_str().unwrap().to_string(), without_docs(c))
        })
        .collect()
}
fn classify(a: &Definition, b: &Definition) -> (Class, Option<String>) {
    if a.kind != b.kind {
        return (Class::Breaking, None);
    }
    if without_docs(&a.spec) == without_docs(&b.spec) {
        return (Class::Cosmetic, None);
    }
    if matches!(
        a.kind.as_str(),
        "udt_union_v0" | "udt_enum_v0" | "udt_error_enum_v0"
    ) {
        let x = cases(a);
        let y = cases(b);
        if x.iter().all(|(k, v)| y.get(k) == Some(v)) {
            return (
                Class::Additive,
                (a.kind == "udt_union_v0")
                    .then(|| "consumer_exhaustiveness: update exhaustive consumers".into()),
            );
        }
        if a.kind != "udt_union_v0" {
            let codes = |m: &BTreeMap<String, Value>| {
                m.values()
                    .map(|c| c["value"].as_u64().unwrap())
                    .collect::<BTreeSet<_>>()
            };
            if codes(&x).is_subset(&codes(&y))
                && x.iter()
                    .all(|(n, c)| y.get(n).is_none_or(|v| v["value"] == c["value"]))
            {
                return (
                    Class::Additive,
                    Some("renamed_code: generated TypeScript names/messages changed".into()),
                );
            }
        }
    }
    (Class::Breaking, None)
}
fn detail(section: &str, name: &str, a: &Definition, b: &Definition) -> String {
    if section == "fn" {
        if let (Some(x), Some(y)) = (a.spec["inputs"].as_array(), b.spec["inputs"].as_array()) {
            for (i, (x, y)) in x.iter().zip(y).enumerate() {
                if x["name"] != y["name"] {
                    return format!(
                        "fn {name}: arg {} renamed to {} at position {i}",
                        x["name"], y["name"]
                    );
                }
                if x["type_"] != y["type_"] {
                    return format!("fn {name}: arg {} retyped", x["name"]);
                }
            }
            if x.len() != y.len() {
                return format!("fn {name}: argument count changed");
            }
        }
        if a.spec["outputs"] != b.spec["outputs"] {
            return format!("fn {name}: return type changed");
        }
    }
    format!("{section} {name}: definition changed")
}
pub fn diff(old: &Manifest, new: &Manifest) -> Report {
    let mut changes = Vec::new();
    for (section, a, b) in [
        ("fn", &old.functions, &new.functions),
        ("type", &old.types, &new.types),
        ("error", &old.errors, &new.errors),
        ("event", &old.events, &new.events),
    ] {
        for name in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
            let (item, mut class, warning) = match (a.get(name), b.get(name)) {
                (Some(x), Some(y)) if x == y => continue,
                (Some(x), Some(y)) => {
                    let (c, w) = classify(x, y);
                    (detail(section, name, x, y), c, w)
                }
                (Some(_), None) => (format!("{section} {name}: removed"), Class::Breaking, None),
                (None, Some(_)) => (format!("{section} {name}: added"), Class::Additive, None),
                _ => unreachable!(),
            };
            let critical = section == "type"
                && (old.hash_critical.contains(name) || new.hash_critical.contains(name))
                && class != Class::Cosmetic;
            if critical {
                class = Class::Breaking;
            }
            let deploy_affecting = section == "fn" && name == "__constructor";
            if deploy_affecting && class == Class::Breaking {
                class = Class::Additive;
            }
            changes.push(Change {
                item,
                class,
                warning,
                adr0001: critical,
                deploy_affecting,
                defining_contract: new
                    .type_origins
                    .get(name)
                    .or_else(|| old.type_origins.get(name))
                    .cloned()
                    .unwrap_or_else(|| new.contract.clone()),
            });
        }
    }
    Report {
        contract: new.contract.clone(),
        classification: changes
            .iter()
            .map(|c| c.class)
            .max()
            .unwrap_or(Class::Cosmetic),
        changes,
    }
}
impl Report {
    pub fn text(&self) -> String {
        let mut s = format!("{}: {:?}\n", self.contract, self.classification);
        for c in &self.changes {
            s.push_str(&format!(
                "- {:?}: {}{}{}{}\n",
                c.class,
                c.item,
                if c.adr0001 {
                    " [ADR 0001: docs/adr/0001-resolution-commitment.md]"
                } else {
                    ""
                },
                if c.deploy_affecting {
                    " [deploy-affecting]"
                } else {
                    ""
                },
                c.warning
                    .as_ref()
                    .map(|w| format!(" [{w}]"))
                    .unwrap_or_default()
            ));
        }
        s
    }
}
