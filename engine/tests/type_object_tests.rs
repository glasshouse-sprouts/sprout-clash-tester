//! IFC2X3 MEP occurrences classified by their type object
//! (docs/PROJECT-FILE.md#ifc2x3-type-objects). Fixture: a beam with four generic `IfcFlow*` boxes
//! standing through it — duct segment, pipe segment and duct fitting
//! typed by type objects, plus one flow segment without a type object.

use clash::ifc_adapter::load_ifc_file;
use clash::{DetectionResult, clash_detect_with_config};
use std::collections::HashMap;
use std::path::PathBuf;

const DUCT: &str = "0DUCTSEG0000000002X3MEP";
const PIPE: &str = "0PIPESEG0000000002X3MEP";
const FITTING: &str = "0DUCTFIT0000000002X3MEP";
const UNTYPED: &str = "0UNTYPED0000000002X3MEP";

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/models/ifc2x3-mep-types.ifc")
}

/// Side A / side B selectors of a shipped preset, read from `presets/`
/// so the test follows the preset files.
fn preset_selectors(name: &str) -> (String, String) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../presets")
        .join(format!("{name}.json"));
    let preset: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let side = |k: &str| preset[k]["selector"].as_str().unwrap().to_string();
    (side("sideA"), side("sideB"))
}

fn run(a: &str, b: &str) -> DetectionResult {
    let f = fixture();
    let config = format!(
        r#"[{{ "name": "R",
              "a": [{{ "file": {f:?}, "selector": {a:?}, "mode": "i" }}],
              "b": [{{ "file": {f:?}, "selector": {b:?}, "mode": "i" }}] }}]"#,
        f = f.to_string_lossy()
    );
    clash_detect_with_config(&config, 0.0, 0.005, &None, &None).unwrap()
}

fn guids_a(r: &DetectionResult) -> Vec<&str> {
    let mut g: Vec<&str> = r.clashes.iter().map(|c| c.guid_a.as_str()).collect();
    g.sort();
    g
}

#[test]
fn test_occurrences_get_type_class_and_predefined_type() {
    let loaded = load_ifc_file(fixture()).unwrap();
    let by_guid: HashMap<&str, _> =
        loaded.elements.iter().map(|e| (e.metadata.guid.as_str(), &e.metadata)).collect();
    let class = |g: &str| by_guid[g].type_class.as_deref();
    let predefined = |g: &str| by_guid[g].predefined_type.as_deref();
    assert_eq!(class(DUCT), Some("IfcDuctSegment"));
    assert_eq!(class(PIPE), Some("IfcPipeSegment"));
    assert_eq!(class(FITTING), Some("IfcDuctFitting"));
    assert_eq!(class(UNTYPED), None);
    assert_eq!(class("0BEAM00000000000002X3MEP"), None);
    assert_eq!(predefined(DUCT), Some("RIGIDSEGMENT"));
    assert_eq!(predefined(PIPE), None, "NOTDEFINED counts as none");
    assert_eq!(predefined(FITTING), Some("BEND"));
    assert_eq!(by_guid[DUCT].ifc_type, "IFCFLOWSEGMENT", "occurrence class kept");
    assert_eq!(loaded.untyped_generic, 1);
}

#[test]
fn test_hvac_preset_finds_ifc2x3_ducts() {
    let (a, b) = preset_selectors("HVACxSTR");
    let r = run(&a, &b);
    assert_eq!(guids_a(&r), vec![FITTING, DUCT]);
    let duct = r.clashes.iter().find(|c| c.guid_a == DUCT).unwrap();
    assert_eq!(duct.type_class_a.as_deref(), Some("IfcDuctSegment"));
    assert_eq!(duct.predefined_type_a.as_deref(), Some("RIGIDSEGMENT"));
    assert_eq!(duct.type_class_b, None, "the beam is no generic occurrence");
}

#[test]
fn test_mep_preset_still_matches_by_occurrence_class() {
    // MEPxSTR lists IfcFlowSegment* / IfcFlowFitting* itself (the old
    // IFC2X3 stop-gap), so it keeps catching every generic flow element,
    // ducts included — matching is "type class OR occurrence class".
    let (a, b) = preset_selectors("MEPxSTR");
    let r = run(&a, &b);
    assert_eq!(guids_a(&r), vec![FITTING, DUCT, PIPE, UNTYPED]);
    let r = run("IfcPipe*", &b);
    assert_eq!(guids_a(&r), vec![PIPE]);
}

#[test]
fn test_explicit_occurrence_selector_still_works() {
    let r = run("IfcFlowSegment", "IfcBeam");
    assert_eq!(guids_a(&r), vec![DUCT, PIPE, UNTYPED]);
}

#[test]
fn test_untyped_generic_elements_are_reported() {
    let r = run("IfcDuct*", "IfcBeam");
    let w: Vec<_> = r.warnings.iter().filter(|w| w.kind == "untyped_generic_mep").collect();
    assert_eq!(w.len(), 1, "one warning per file");
    assert_eq!(w[0].files, vec!["ifc2x3-mep-types.ifc"]);
    assert!(w[0].message.contains("1 generic MEP element(s) without a type object"));
}

/// A type object that is itself generic (`IfcFlowSegmentType` → class
/// `IfcFlowSegment`) doesn't classify the element either, so it counts
/// as unclassified and is warned about — not silently left generic.
#[test]
fn test_generic_type_object_counts_as_unclassified() {
    let text = std::fs::read_to_string(fixture()).unwrap();
    let extra = "#90=IFCFLOWSEGMENT('0GENTYPED000000002X3MEP',$,'Generically typed',$,$,#7,#55,$);\n\
                 #91=IFCFLOWSEGMENTTYPE('0FLOWSEGTYPE00002X3MEP0',$,'Generic',$,$,$,$,$,$,.NOTDEFINED.);\n\
                 #92=IFCRELDEFINESBYTYPE('0RELTYPEGEN00002X3MEP00',$,$,$,(#90),#91);\n";
    let data_end = text.rfind("ENDSEC;").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("generic-type.ifc");
    std::fs::write(&path, format!("{}{}{}", &text[..data_end], extra, &text[data_end..])).unwrap();

    let loaded = load_ifc_file(&path).unwrap();
    let el = loaded.elements.iter().find(|e| e.metadata.guid == "0GENTYPED000000002X3MEP");
    assert_eq!(el.unwrap().metadata.type_class.as_deref(), Some("IfcFlowSegment"));
    assert_eq!(loaded.untyped_generic, 2, "the untyped segment and the generically typed one");
}
