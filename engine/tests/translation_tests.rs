//! Tests for the per-file `translation` extension.
//!
//! `SelectionGroup.translation` is an optional `[dx, dy, dz]` (metres)
//! applied to every mesh loaded from `file` before clash detection.
//! Default behaviour (None / [0, 0, 0]) MUST be identical to the old
//! engine — we're additive, not breaking.

use clash::clash_detect_with_config;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("models");
    p.push(name);
    p
}

/// Builds the smallest realistic clash-set JSON: one rule, one file on
/// each side, no selector. Optionally injects a translation on the B side.
fn config_hvac_vs_struct(translation_b: Option<[f64; 3]>) -> String {
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let tb = match translation_b {
        None => "null".to_string(),
        Some(t) => format!("[{}, {}, {}]", t[0], t[1], t[2]),
    };
    format!(
        r#"[
            {{
                "name": "HVACxSTR",
                "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "*", "mode": "i", "translation": {} }}]
            }}
        ]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy(),
        tb
    )
}

#[test]
fn test_translation_field_is_optional() {
    // Missing field → still deserialises. Engine treats it as no translation.
    let json = config_hvac_vs_struct(None);
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None)
        .expect("config without translation should be accepted");
    // No assertion on clash count — just that it runs and returns warnings array.
    println!("Translation field optional: {} clashes", result.clashes.len());
    // No misalignment, so no warning expected.
    assert!(
        !result.warnings.iter().any(|w| w.kind == "no_aabb_overlap"),
        "Did not expect a no_aabb_overlap warning here: {:?}",
        result.warnings
    );
}

#[test]
fn test_translation_zero_is_noop() {
    // [0, 0, 0] must produce identical results to "no translation".
    let none = config_hvac_vs_struct(None);
    let zero = config_hvac_vs_struct(Some([0.0, 0.0, 0.0]));
    let r_none = clash_detect_with_config(&none, 0.1, 0.005, &None, &None).unwrap();
    let r_zero = clash_detect_with_config(&zero, 0.1, 0.005, &None, &None).unwrap();
    assert_eq!(
        r_none.clashes.len(),
        r_zero.clashes.len(),
        "Zero translation should be a no-op (same clash count)"
    );
}

#[test]
fn test_translation_separates_files() {
    // Translate side B by 100 m → the two files no longer overlap in space.
    // Expectations:
    //   1. The clash count drops to (essentially) zero.
    //   2. A no_aabb_overlap warning is emitted, mentioning both files.
    let json = config_hvac_vs_struct(Some([100.0, 0.0, 0.0]));
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None).unwrap();

    assert!(
        result.clashes.is_empty(),
        "After translating one file 100 m away, no clashes should remain. Got {}",
        result.clashes.len()
    );

    let warning = result
        .warnings
        .iter()
        .find(|w| w.kind == "no_aabb_overlap")
        .expect("Expected a no_aabb_overlap warning when files are separated");
    assert_eq!(warning.files.len(), 2);
    assert!(
        warning
            .files
            .iter()
            .any(|f| f.contains("Building-Hvac.ifc"))
    );
    assert!(
        warning
            .files
            .iter()
            .any(|f| f.contains("Building-Structural.ifc"))
    );
}
