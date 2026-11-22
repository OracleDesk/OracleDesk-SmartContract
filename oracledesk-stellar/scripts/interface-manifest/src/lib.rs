pub mod diff;
pub mod policy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Values contain decoded, tagged XDR spec types (never opaque base64).
/// Keeping XDR's type tags preserves all present and future primitive distinctions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Definition {
    pub kind: String,
    pub spec: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub schema: u32,
    pub contract: String,
    pub functions: BTreeMap<String, Definition>,
    pub types: BTreeMap<String, Definition>,
    pub errors: BTreeMap<String, Definition>,
    pub events: BTreeMap<String, Definition>,
    #[serde(default)]
    pub type_origins: BTreeMap<String, String>,
    pub hash_critical: BTreeSet<String>,
}
impl Manifest {
    pub fn empty(contract: &str) -> Self {
        Self {
            schema: 1,
            contract: contract.into(),
            functions: BTreeMap::new(),
            types: BTreeMap::new(),
            errors: BTreeMap::new(),
            events: BTreeMap::new(),
            type_origins: BTreeMap::new(),
            hash_critical: BTreeSet::new(),
        }
    }
}
fn normalize(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if k == "doc" {
                    // XDR StringM serde uses escaped byte strings, not UTF-8
                    // strings. Decode before normalizing newlines/tabs/Unicode.
                    let doc: stellar_xdr::StringM<1024> = serde_json::from_value(v.clone())
                        .expect("doc was serialized from an XDR StringM");
                    *v = Value::String(
                        doc.to_utf8_string_lossy()
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                } else {
                    normalize(v);
                }
            }
        }
        Value::Array(a) => {
            for v in a {
                normalize(v);
            }
        }
        _ => {}
    }
}
pub fn refs(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Object(m) => {
            if let Some(n) = m
                .get("udt")
                .and_then(|u| u.get("name"))
                .and_then(Value::as_str)
            {
                out.insert(n.to_string());
            }
            for v in m.values() {
                refs(v, out);
            }
        }
        Value::Array(a) => {
            for v in a {
                refs(v, out);
            }
        }
        _ => {}
    }
}
pub fn hash_closure(m: &Manifest, roots: &[String]) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut pending = roots.to_vec();
    while let Some(n) = pending.pop() {
        if !m.types.contains_key(&n) || !seen.insert(n.clone()) {
            continue;
        }
        let mut r = BTreeSet::new();
        refs(&m.types[&n].spec, &mut r);
        pending.extend(r);
    }
    seen
}
pub fn extract(wasm: &[u8], contract: &str) -> Result<Manifest, Box<dyn std::error::Error>> {
    let mut m = Manifest::empty(contract);
    for entry in soroban_spec::read::from_wasm(wasm)? {
        let serialized = serde_json::to_value(entry)?;
        let (kind, spec) = serialized
            .as_object()
            .ok_or("Invalid spec entry")?
            .iter()
            .next()
            .ok_or("Empty spec entry")?;
        let mut spec = spec.clone();
        normalize(&mut spec);
        // Named structs are symbol-keyed maps; tuple structs use numeric field names.
        if kind == "udt_struct_v0" {
            if let Some(fields) = spec.get_mut("fields").and_then(Value::as_array_mut) {
                if fields.iter().all(|f| {
                    f["name"]
                        .as_str()
                        .is_some_and(|n| n.parse::<usize>().is_err())
                }) {
                    fields.sort_by_key(|f| f["name"].as_str().unwrap_or("").to_string());
                }
            }
        }
        // Union discriminants and enum/error codes do not depend on source order.
        if matches!(
            kind.as_str(),
            "udt_union_v0" | "udt_enum_v0" | "udt_error_enum_v0"
        ) {
            if let Some(cases) = spec.get_mut("cases").and_then(Value::as_array_mut) {
                cases.sort_by_key(|v| {
                    let case = v.get("name").and_then(Value::as_str).or_else(|| {
                        v.as_object()
                            .and_then(|m| m.values().next())
                            .and_then(|c| c.get("name"))
                            .and_then(Value::as_str)
                    });
                    case.unwrap_or("").to_string()
                });
            }
        }
        let name = spec["name"]
            .as_str()
            .ok_or("Missing spec name")?
            .to_string();
        let target = match kind.as_str() {
            "function_v0" => &mut m.functions,
            "udt_error_enum_v0" => &mut m.errors,
            "event_v0" => &mut m.events,
            _ => &mut m.types,
        };
        let definition = Definition {
            kind: kind.clone(),
            spec,
        };
        if let Some(old) = target.insert(name.clone(), definition.clone()) {
            if old != definition {
                return Err(format!("Conflicting definition: {name}").into());
            }
        }
    }
    let imports: BTreeMap<String, BTreeMap<String, Vec<String>>> =
        toml::from_str(include_str!("../imports.toml"))?;
    if let Some(contracts) = imports.get(contract) {
        for (origin, names) in contracts {
            for name in names {
                if m.types.contains_key(name) {
                    m.type_origins.insert(name.clone(), origin.clone());
                }
            }
        }
    }
    let roots: BTreeMap<String, Vec<String>> = toml::from_str(include_str!("../roots.toml"))?;
    m.hash_critical = hash_closure(&m, roots.get(contract).map(Vec::as_slice).unwrap_or(&[]));
    Ok(m)
}
pub fn canonical(m: &Manifest) -> Result<String, serde_json::Error> {
    Ok(format!("{}\n", serde_json::to_string_pretty(m)?))
}
