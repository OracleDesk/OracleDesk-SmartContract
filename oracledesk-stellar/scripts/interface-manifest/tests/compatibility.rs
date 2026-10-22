use interface_manifest::{
    diff::{diff, Class},
    hash_closure,
    policy::{required_version, validate},
    Definition, Manifest,
};
use semver::Version;
use serde_json::{json, Value};
fn def(kind: &str, spec: Value) -> Definition {
    Definition {
        kind: kind.into(),
        spec,
    }
}
fn function() -> Definition {
    def(
        "function_v0",
        json!({"name":"f","doc":"","inputs":[{"name":"a","type_":"u64","doc":""}],"outputs":["u64"]}),
    )
}
fn pair() -> (Manifest, Manifest) {
    let mut a = Manifest::empty("test");
    a.functions.insert("f".into(), function());
    (a.clone(), a)
}
#[test]
fn fn_removed_is_breaking() {
    let (a, mut b) = pair();
    b.functions.clear();
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn fn_added_is_additive() {
    let (a, mut b) = pair();
    b.functions.insert("g".into(), function());
    assert_eq!(diff(&a, &b).classification, Class::Additive);
}
#[test]
fn arg_renamed_is_breaking() {
    let (a, mut b) = pair();
    b.functions.get_mut("f").unwrap().spec["inputs"][0]["name"] = json!("renamed");
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn arguments_and_outputs_are_wire_contracts() {
    for key in ["retype", "reorder", "add", "remove", "output"] {
        let (a, mut b) = pair();
        let f = &mut b.functions.get_mut("f").unwrap().spec;
        match key {
            "retype" => f["inputs"][0]["type_"] = json!("u32"),
            "reorder" => {
                f["inputs"] = json!([{"name":"b","type_":"u64"},{"name":"a","type_":"u64"}])
            }
            "add" => f["inputs"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":"b","type_":"u64"})),
            "remove" => f["inputs"] = json!([]),
            _ => f["outputs"] = json!(["u32"]),
        }
        assert_eq!(diff(&a, &b).classification, Class::Breaking, "{key}");
    }
}
fn typed(kind: &str, spec: Value) -> (Manifest, Manifest) {
    let mut a = Manifest::empty("test");
    a.types.insert("T".into(), def(kind, spec));
    (a.clone(), a)
}
#[test]
fn struct_field_added_is_breaking() {
    let (a, mut b) = typed(
        "udt_struct_v0",
        json!({"fields":[{"name":"a","type_":"u64"}]}),
    );
    b.types.get_mut("T").unwrap().spec["fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"b","type_":"u64"}));
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn tuple_positions_matter() {
    let (a, mut b) = typed(
        "udt_struct_v0",
        json!({"fields":[{"name":"0","type_":"u64"},{"name":"1","type_":"u32"}]}),
    );
    b.types.get_mut("T").unwrap().spec["fields"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn union_variant_appended_is_additive_with_warning() {
    let (a, mut b) = typed("udt_union_v0", json!({"cases":[{"void_v0":{"name":"A"}}]}));
    b.types.get_mut("T").unwrap().spec["cases"]
        .as_array_mut()
        .unwrap()
        .push(json!({"tuple_v0":{"name":"B","type_":["u64"]}}));
    let r = diff(&a, &b);
    assert_eq!(r.classification, Class::Additive);
    assert!(r.changes[0]
        .warning
        .as_ref()
        .unwrap()
        .contains("consumer_exhaustiveness"));
}
#[test]
fn union_removal_and_retype_break() {
    for replacement in [
        json!([]),
        json!([{"tuple_v0":{"name":"A","type_":["u32"]}}]),
    ] {
        let (a, mut b) = typed(
            "udt_union_v0",
            json!({"cases":[{"tuple_v0":{"name":"A","type_":["u64"]}}]}),
        );
        b.types.get_mut("T").unwrap().spec["cases"] = replacement;
        assert_eq!(diff(&a, &b).classification, Class::Breaking);
    }
}
fn errors() -> (Manifest, Manifest) {
    let mut a = Manifest::empty("test");
    a.errors.insert(
        "Error".into(),
        def(
            "udt_error_enum_v0",
            json!({"cases":[{"name":"Oops","value":1}]}),
        ),
    );
    (a.clone(), a)
}
#[test]
fn error_code_changed_is_breaking() {
    let (a, mut b) = errors();
    b.errors.get_mut("Error").unwrap().spec["cases"][0]["value"] = json!(2);
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn error_renamed_same_code_warns() {
    let (a, mut b) = errors();
    b.errors.get_mut("Error").unwrap().spec["cases"][0]["name"] = json!("Renamed");
    let r = diff(&a, &b);
    assert_eq!(r.classification, Class::Additive);
    assert!(r.changes[0].warning.is_some());
}
#[test]
fn error_added_and_removed() {
    let (a, mut b) = errors();
    b.errors.get_mut("Error").unwrap().spec["cases"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"More","value":2}));
    assert_eq!(diff(&a, &b).classification, Class::Additive);
    assert_eq!(diff(&b, &a).classification, Class::Breaking);
}
#[test]
fn integer_enum_numeric_changes_break() {
    let (a, mut b) = typed("udt_enum_v0", json!({"cases":[{"name":"A","value":1}]}));
    b.types.get_mut("T").unwrap().spec["cases"][0]["value"] = json!(3);
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn doc_only_change_is_cosmetic() {
    let (a, mut b) = pair();
    b.functions.get_mut("f").unwrap().spec["doc"] = json!("new docs");
    assert_eq!(diff(&a, &b).classification, Class::Cosmetic);
}
#[test]
fn hash_critical_closure_includes_oracle_asset() {
    let mut m = Manifest::empty("resolver");
    for (n, v) in [
        (
            "ResolutionSpec",
            json!({"tuple":{"value_types":[{"udt":{"name":"PriceConfig"}}]}}),
        ),
        (
            "PriceConfig",
            json!({"vec":{"element_type":{"udt":{"name":"OracleAsset"}}}}),
        ),
        ("OracleAsset", json!({})),
    ] {
        m.types.insert(n.into(), def("udt_struct_v0", v));
    }
    m.hash_critical = hash_closure(&m, &["ResolutionSpec".into()]);
    assert!(m.hash_critical.contains("OracleAsset"));
    let mut n = m.clone();
    n.types.get_mut("OracleAsset").unwrap().spec = json!({"new":true});
    let r = diff(&m, &n);
    assert!(r.changes[0].adr0001);
    assert_eq!(r.classification, Class::Breaking);
}
#[test]
fn event_field_change_is_breaking() {
    let mut a = Manifest::empty("test");
    a.events.insert("Trade".into(),def("event_v0",json!({"prefix_topics":["trade"],"params":[{"name":"amount","type_":"i128","location":"data"}]})));
    let mut b = a.clone();
    b.events.get_mut("Trade").unwrap().spec["params"][0]["location"] = json!("topic_list");
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
#[test]
fn constructor_is_deploy_affecting() {
    let (mut a, _) = pair();
    let f = a.functions.remove("f").unwrap();
    a.functions.insert("__constructor".into(), f);
    let mut b = a.clone();
    b.functions.get_mut("__constructor").unwrap().spec["outputs"] = json!([]);
    let r = diff(&a, &b);
    assert_eq!(r.classification, Class::Additive);
    assert!(r.changes[0].deploy_affecting);
}
#[test]
fn bump_and_changelog_enforced() {
    let (a, mut b) = pair();
    b.functions.clear();
    let r = diff(&a, &b);
    let old = Version::new(0, 1, 0);
    assert!(
        validate(&r, &old, &Version::new(0, 1, 3), "## 0.1.3\nremoved")
            .unwrap_err()
            .contains("requires version >= 0.2.0")
    );
    assert!(validate(&r, &old, &Version::new(0, 2, 0), "## 0.2.0\nunrelated").is_err());
    assert!(validate(
        &r,
        &old,
        &Version::new(0, 2, 0),
        "## 0.2.0\n- fn f: removed\n"
    )
    .is_ok());
    assert_eq!(
        required_version(&Version::new(1, 2, 3), Class::Breaking),
        Version::new(2, 0, 0)
    );
    assert_eq!(
        required_version(&old, Class::Additive),
        Version::new(0, 1, 1)
    );
}
#[test]
fn named_struct_xdr_independent_of_source_field_order() {
    use soroban_sdk::{contracttype, xdr::ToXdr, Env, IntoVal, Val};
    #[contracttype]
    #[derive(Clone)]
    struct AB {
        a: u32,
        b: u64,
    }
    #[contracttype]
    #[derive(Clone)]
    struct BA {
        b: u64,
        a: u32,
    }
    let env = Env::default();
    let a: Val = AB { a: 1, b: 2 }.into_val(&env);
    let b: Val = BA { b: 2, a: 1 }.into_val(&env);
    assert_eq!(a.to_xdr(&env), b.to_xdr(&env));
}
#[test]
fn golden_committed_wasms_are_deterministic() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (name, path) in [
        ("market-core", "contracts/resolver/market_core.wasm"),
        ("resolver", "contracts/router/resolver.wasm"),
        (
            "reasoning-registry",
            "contracts/router/reasoning_registry.wasm",
        ),
    ] {
        let wasm = std::fs::read(root.join(path)).unwrap();
        let a = interface_manifest::canonical(&interface_manifest::extract(&wasm, name).unwrap())
            .unwrap();
        let b = interface_manifest::canonical(&interface_manifest::extract(&wasm, name).unwrap())
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(
            a,
            std::fs::read_to_string(root.join(format!("packages/bindings/{name}/interface.json")))
                .unwrap()
        );
    }
}

#[test]
fn cli_rejects_missing_bump_and_missing_breaking_changelog() {
    use std::{fs, process::Command};
    let repo = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let o = Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.email", "fixture@example.invalid"]);
    git(&["config", "user.name", "Fixture"]);
    let pkg = repo.path().join("packages/bindings/test");
    fs::create_dir_all(&pkg).unwrap();
    let (a, mut b) = pair();
    fs::write(
        pkg.join("interface.json"),
        interface_manifest::canonical(&a).unwrap(),
    )
    .unwrap();
    fs::write(pkg.join("package.json"), "{\"version\":\"0.1.0\"}").unwrap();
    fs::write(pkg.join("CHANGELOG.md"), "## 0.1.0\nInitial\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "baseline"]);
    b.functions.clear();
    fs::write(
        pkg.join("interface.json"),
        interface_manifest::canonical(&b).unwrap(),
    )
    .unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_interface-manifest"))
            .args([
                "check",
                "--pkg-dir",
                "packages/bindings/test",
                "--base-ref",
                "HEAD",
            ])
            .current_dir(repo.path())
            .output()
            .unwrap()
    };
    let result = run();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("requires version >= 0.2.0, found 0.1.0")
    );
    fs::write(pkg.join("package.json"), "{\"version\":\"0.2.0\"}").unwrap();
    fs::write(pkg.join("CHANGELOG.md"), "## 0.2.0\nUnrelated\n").unwrap();
    assert!(!run().status.success());
    fs::write(pkg.join("CHANGELOG.md"), "## 0.2.0\n- fn f: removed\n").unwrap();
    assert!(run().status.success());
}
#[test]
fn inherited_type_is_attributed_once_and_does_not_accumulate_bumps() {
    let (mut a, mut b) = typed(
        "udt_struct_v0",
        json!({"fields":[{"name":"a","type_":"u64"}]}),
    );
    a.type_origins.insert("T".into(), "market-core".into());
    b.type_origins = a.type_origins.clone();
    b.types.get_mut("T").unwrap().spec["fields"] = json!([]);
    let r = diff(&a, &b);
    assert_eq!(r.changes.len(), 1);
    assert_eq!(r.changes[0].defining_contract, "market-core");
    assert_eq!(
        required_version(&Version::new(0, 1, 0), r.classification),
        Version::new(0, 2, 0)
    );
}
#[test]
fn all_built_contracts_match_manifests() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for name in [
        "market-core",
        "resolver",
        "treasury",
        "reasoning-registry",
        "timelock",
        "router",
    ] {
        let wasm = std::fs::read(root.join(format!(
            "target/wasm32v1-none/release/{}.wasm",
            name.replace('-', "_")
        )))
        .expect("run make build before golden tests");
        let a = interface_manifest::canonical(&interface_manifest::extract(&wasm, name).unwrap())
            .unwrap();
        assert_eq!(
            a,
            interface_manifest::canonical(&interface_manifest::extract(&wasm, name).unwrap())
                .unwrap()
        );
        assert_eq!(
            a,
            std::fs::read_to_string(root.join(format!("packages/bindings/{name}/interface.json")))
                .unwrap()
        );
    }
}

#[test]
fn hash_critical_union_addition_is_breaking_but_docs_are_cosmetic() {
    let (mut a, mut b) = typed(
        "udt_union_v0",
        json!({"doc":"old","cases":[{"void_v0":{"name":"A"}}]}),
    );
    a.hash_critical.insert("T".into());
    b.hash_critical = a.hash_critical.clone();
    b.types.get_mut("T").unwrap().spec["doc"] = json!("new docs");
    assert_eq!(diff(&a, &b).classification, Class::Cosmetic);
    b.types.get_mut("T").unwrap().spec["cases"]
        .as_array_mut()
        .unwrap()
        .push(json!({"void_v0":{"name":"B"}}));
    let report = diff(&a, &b);
    assert_eq!(report.classification, Class::Breaking);
    assert!(report.changes[0].adr0001);
}
#[test]
fn docs_whitespace_is_normalized_at_extraction() {
    use stellar_xdr::{Limits, ScSpecEntry, ScSpecFunctionV0, WriteXdr};
    fn wasm(doc: &str) -> Vec<u8> {
        let entry = ScSpecEntry::FunctionV0(ScSpecFunctionV0 {
            doc: doc.try_into().unwrap(),
            name: "f".try_into().unwrap(),
            ..Default::default()
        });
        let mut payload = vec![14];
        payload.extend(b"contractspecv0");
        payload.extend(entry.to_xdr(Limits::none()).unwrap());
        assert!(payload.len() < 128);
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        wasm.extend([0, payload.len() as u8]);
        wasm.extend(payload);
        wasm
    }
    let a = interface_manifest::extract(&wasm("hello   world\nmore"), "test").unwrap();
    let b = interface_manifest::extract(&wasm("hello world more"), "test").unwrap();
    assert_eq!(a, b);
}

#[test]
fn named_struct_field_removed_renamed_or_retyped_is_breaking() {
    for fields in [
        json!([]),
        json!([{"name":"renamed","type_":"u64"}]),
        json!([{"name":"a","type_":"u32"}]),
    ] {
        let (a, mut b) = typed(
            "udt_struct_v0",
            json!({"fields":[{"name":"a","type_":"u64"}]}),
        );
        b.types.get_mut("T").unwrap().spec["fields"] = fields;
        assert_eq!(diff(&a, &b).classification, Class::Breaking);
    }
}
#[test]
fn integer_enum_new_code_additive_removed_case_breaking() {
    let (a, mut b) = typed("udt_enum_v0", json!({"cases":[{"name":"A","value":1}]}));
    b.types.get_mut("T").unwrap().spec["cases"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"B","value":2}));
    assert_eq!(diff(&a, &b).classification, Class::Additive);
    assert_eq!(diff(&b, &a).classification, Class::Breaking);
}
#[test]
fn event_topic_and_data_type_changes_are_breaking() {
    let mut a = Manifest::empty("test");
    a.events.insert("Trade".into(),def("event_v0",json!({"prefix_topics":["trade"],"params":[{"name":"amount","type_":"i128","location":"data"}]})));
    let mut b = a.clone();
    b.events.get_mut("Trade").unwrap().spec["prefix_topics"] = json!(["trade2"]);
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
    let mut b = a.clone();
    b.events.get_mut("Trade").unwrap().spec["params"][0]["type_"] = json!("u64");
    assert_eq!(diff(&a, &b).classification, Class::Breaking);
}
