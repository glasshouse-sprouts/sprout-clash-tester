//! Elements whose geometry can't be read are counted and warned about
//! (docs/HOW-IT-WORKS.md#geometry-that-cant-be-read). Fixture: one good
//! slab, two elements with a Body that gives no mesh (a broken
//! extrusion, a Body that is only a line), a roof without any
//! representation and a 2D annotation.

use clash::clash_detect_with_config;
use clash::ifc_adapter::load_ifc_file;
use std::path::PathBuf;

const BROKEN_EXTRUSION: &str = "0PROXY0000000000BROKEN1";
const LINE_BODY: &str = "0BEAM00000000000BROKEN2";

fn model(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/models")
        .join(name)
}

fn self_check(file: &PathBuf) -> String {
    format!(
        r#"[{{ "name": "all", "a": [{{ "file": {f:?}, "selector": "*", "mode": "i" }}],
                              "b": [{{ "file": {f:?}, "selector": "*", "mode": "i" }}] }}]"#,
        f = file.to_string_lossy()
    )
}

#[test]
fn test_broken_body_counted_containers_and_annotations_not() {
    let loaded = load_ifc_file(model("geometry-failed.ifc")).unwrap();
    let mut failed: Vec<_> = loaded
        .geometry_failed
        .iter()
        .map(|f| (f.guid.as_str(), f.ifc_type.as_str()))
        .collect();
    failed.sort();
    // The roof (no representation) and the annotation (2D only) are not
    // geometry that failed; only the two broken bodies are.
    assert_eq!(
        failed,
        vec![
            (LINE_BODY, "IFCBEAM"),
            (BROKEN_EXTRUSION, "IFCBUILDINGELEMENTPROXY")
        ]
    );
    // The good slab still loads; the broken ones are not checked.
    let guids: Vec<_> = loaded
        .elements
        .iter()
        .map(|e| e.metadata.guid.as_str())
        .collect();
    assert_eq!(guids, vec!["0SLAB00000000000000GOOD"]);
}

#[test]
fn test_geometry_failed_warning_names_the_elements() {
    let file = model("geometry-failed.ifc");
    let result = clash_detect_with_config(&self_check(&file), 0.0, 0.005, &None, &None).unwrap();
    let warning = result
        .warnings
        .iter()
        .find(|w| w.kind == "geometry_failed")
        .expect("expected a geometry_failed warning");
    assert!(
        warning
            .message
            .starts_with("2 element(s) in geometry-failed.ifc"),
        "{}",
        warning.message
    );
    assert!(warning.message.contains(BROKEN_EXTRUSION) && warning.message.contains(LINE_BODY));
    assert!(warning.message.contains("IFCBUILDINGELEMENTPROXY"));
    assert_eq!(warning.files, vec!["geometry-failed.ifc".to_string()]);
}

#[test]
fn test_clean_models_have_no_geometry_failed() {
    for name in [
        "Building-Architecture.ifc",
        "Building-Hvac.ifc",
        "Building-Structural.ifc",
    ] {
        let loaded = load_ifc_file(model(name)).unwrap();
        assert!(
            loaded.geometry_failed.is_empty(),
            "{name}: {:?}",
            loaded.geometry_failed
        );
    }
    // FZK-Haus has 14 IfcAnnotation plan symbols with curves only: not
    // bodies, so not failures.
    let fzk = load_ifc_file(model("AC20-FZK-Haus.ifc")).unwrap();
    assert!(fzk.geometry_failed.is_empty(), "{:?}", fzk.geometry_failed);
}
