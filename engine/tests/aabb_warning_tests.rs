//! Tests for the AABB-overlap sanity warning.
//!
//! When two source files have non-overlapping bounding boxes the engine
//! emits a structured `no_aabb_overlap` warning. This catches silent
//! zero-clash results caused by mis-aligned models.

use clash::clash_detect_with_config;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("models");
    p.push(name);
    p
}

#[test]
fn test_aabb_overlap_no_warning_when_files_overlap() {
    // HVAC + Structural live in the same coordinate space → no warning.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let json = format!(
        r#"[
            {{
                "name": "HVACxSTR",
                "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "*", "mode": "i" }}]
            }}
        ]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None).unwrap();
    assert!(
        result
            .warnings
            .iter()
            .all(|w| w.kind != "no_aabb_overlap"),
        "Unexpected no_aabb_overlap warning: {:?}",
        result.warnings
    );
}

#[test]
fn test_placement_mismatch_warning_when_files_far_apart() {
    // 50 m translation puts side B's centre way outside side A's centre,
    // even though both files are similar in extent. This is the
    // "different export origin" diagnostic — distinct from
    // `no_aabb_overlap` which only fires when the bounding boxes don't
    // overlap at all.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let json = format!(
        r#"[
            {{
                "name": "HVACxSTR",
                "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "*", "mode": "i", "translation": [50, 0, 0] }}]
            }}
        ]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None).unwrap();

    let warning = result
        .warnings
        .iter()
        .find(|w| w.kind == "placement_mismatch")
        .expect("Expected a placement_mismatch warning when files are far apart");

    // Message should describe the groups, and list both filenames.
    assert!(warning.message.contains("placement groups"));
    assert!(warning.message.contains("Building-Hvac.ifc"));
    assert!(warning.message.contains("Building-Structural.ifc"));
    // Both files are in the `files` field so consumers can recover the
    // full list without re-parsing the message.
    assert_eq!(warning.files.len(), 2);
}

#[test]
fn test_placement_mismatch_not_fired_for_aligned_files() {
    // Same setup but no translation → one cluster → no
    // placement_mismatch warning.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let json = format!(
        r#"[
            {{
                "name": "HVACxSTR",
                "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "*", "mode": "i" }}]
            }}
        ]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None).unwrap();
    assert!(
        result.warnings.iter().all(|w| w.kind != "placement_mismatch"),
        "Aligned files should not trigger placement_mismatch: {:?}",
        result.warnings
    );
}

#[test]
fn test_aabb_overlap_warning_when_files_disjoint() {
    // Translate one file far away → bounding boxes disjoint → warning.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let json = format!(
        r#"[
            {{
                "name": "HVACxSTR",
                "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "*", "mode": "i", "translation": [500, 0, 0] }}]
            }}
        ]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None).unwrap();

    let warning = result
        .warnings
        .iter()
        .find(|w| w.kind == "no_aabb_overlap")
        .expect("Expected a no_aabb_overlap warning, got none");

    // The message should mention both filenames so the user knows which
    // pair of files is suspicious.
    assert!(
        warning.message.contains("Building-Hvac.ifc")
            && warning.message.contains("Building-Structural.ifc"),
        "Warning message missing filenames: {}",
        warning.message
    );
}

#[test]
fn test_placement_uses_whole_file_box_not_selected_subset() {
    // Regression: the placement boxes used to be built from the elements
    // a rule *selects*. With the HVACxSTR preset on these two aligned
    // models, the ducts' box and the beams' box have centres far apart,
    // and the run said the files sit in two placement groups. The boxes
    // now cover every loaded element of the file, so aligned models
    // give no placement warning whatever the rule selects.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let json = format!(
        r#"[
            {{
                "name": "HVACxSTR",
                "a": [{{ "file": {:?}, "selector": "IfcDuct*|IfcAirTerminal*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "IfcBeam*|IfcColumn*", "mode": "i" }}]
            }}
        ]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let result = clash_detect_with_config(&json, 0.0, 0.005, &None, &None).unwrap();
    assert!(
        result
            .warnings
            .iter()
            .all(|w| w.kind != "placement_mismatch" && w.kind != "no_aabb_overlap"),
        "Aligned files should not get a placement warning: {:?}",
        result.warnings
    );
}
