//! All geometry is in metres after load (SPEC §4, TASKS T13): thresholds
//! mean the same in mm and m models, and a mm file clashes correctly
//! against a metre file. Fixtures `units-m.ifc` / `units-mm.ifc` hold the
//! same scene: a 0.2 m slab and ducts 3 mm in, 20 mm in and 40 mm above.

use clash::ifclite_narrow::NarrowPhase;
use clash::{DetectOptions, DetectionResult, NarrowConfig, clash_detect_with_options};
use std::collections::BTreeMap;
use std::path::PathBuf;

const SHALLOW: &str = "0DUCT00000000000SHALLOW";
const DEEP: &str = "0DUCT0000000000000DEEP0";
const NEAR: &str = "0DUCT0000000000000NEAR0";

fn fixture(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("models").join(name);
    p.to_string_lossy().into_owned()
}

/// Ducts from `ducts` against the slab from `slab`.
fn run(ducts: &str, slab: &str, tol: f64, min_pen: f64, phase: NarrowPhase) -> DetectionResult {
    let config = format!(
        r#"[{{ "name": "DUCTxSLAB",
              "a": [{{ "file": {d:?}, "selector": "IfcDuctSegment", "mode": "i" }}],
              "b": [{{ "file": {s:?}, "selector": "IfcSlab", "mode": "i" }}] }}]"#,
        d = fixture(ducts),
        s = fixture(slab)
    );
    let options =
        DetectOptions { narrow: NarrowConfig { phase, report_touch: false }, ..Default::default() };
    clash_detect_with_options(&config, tol, min_pen, &None, &None, &options).unwrap()
}

/// Clashing duct → depth (hard) or gap (clearance), metres.
fn ducts(r: &DetectionResult) -> BTreeMap<String, f64> {
    r.clashes
        .iter()
        .map(|c| (c.guid_a.clone(), c.depth_metres.or(c.gap_metres).unwrap()))
        .collect()
}

fn names(r: &DetectionResult) -> Vec<String> {
    ducts(r).into_keys().collect()
}

#[test]
fn test_min_depth_means_millimetres_in_a_mm_model() {
    for phase in [NarrowPhase::Parry, NarrowPhase::Ifclite] {
        // 5 mm: the 3 mm duct is too shallow, the 20 mm one stays.
        let r = run("units-mm.ifc", "units-mm.ifc", 0.0, 0.005, phase);
        assert_eq!(names(&r), vec![DEEP], "{phase:?}");
        assert!((ducts(&r)[DEEP] - 0.020).abs() < 1e-6, "{phase:?}: depth in metres");
        // 1 mm: both.
        let r = run("units-mm.ifc", "units-mm.ifc", 0.0, 0.001, phase);
        assert_eq!(names(&r), vec![DEEP, SHALLOW], "{phase:?}");
    }
}

#[test]
fn test_clearance_means_millimetres_in_a_mm_model() {
    for phase in [NarrowPhase::Parry, NarrowPhase::Ifclite] {
        // The NEAR duct is 40 mm above the slab.
        let at_50 = run("units-mm.ifc", "units-mm.ifc", 0.05, 0.005, phase);
        assert_eq!(names(&at_50), vec![DEEP, NEAR, SHALLOW], "{phase:?}");
        assert!((ducts(&at_50)[NEAR] - 0.040).abs() < 1e-6, "{phase:?}: gap in metres");
        let at_30 = run("units-mm.ifc", "units-mm.ifc", 0.03, 0.005, phase);
        assert_eq!(names(&at_30), vec![DEEP, SHALLOW], "{phase:?}");
    }
}

#[test]
fn test_mixed_units_clash_like_metres() {
    // Ducts in mm against the slab in m = everything in m, in both modes
    // and both narrow phases; positions agree too.
    for phase in [NarrowPhase::Parry, NarrowPhase::Ifclite] {
        for (tol, min) in [(0.0, 0.001), (0.05, 0.005)] {
            let metres = run("units-m.ifc", "units-m.ifc", tol, min, phase);
            let mixed = run("units-mm.ifc", "units-m.ifc", tol, min, phase);
            assert_eq!(names(&mixed), names(&metres), "{phase:?} tol {tol}");
            for (guid, v) in ducts(&metres) {
                assert!((ducts(&mixed)[&guid] - v).abs() < 1e-6, "{phase:?} {guid}");
            }
            for (m, x) in metres.clashes.iter().zip(&mixed.clashes) {
                for k in 0..3 {
                    assert!((m.position[k] - x.position[k]).abs() < 1e-6);
                }
            }
            assert!(mixed.warnings.is_empty(), "same place, no misalignment warning");
        }
    }
}

#[test]
fn test_translation_is_metres_in_a_mm_model() {
    // Lift the mm ducts by 1 m: nothing reaches the slab any more.
    let config = format!(
        r#"[{{ "name": "DUCTxSLAB",
              "a": [{{ "file": {f:?}, "selector": "IfcDuctSegment", "mode": "i",
                       "translation": [0, 0, 1] }}],
              "b": [{{ "file": {f:?}, "selector": "IfcSlab", "mode": "i" }}] }}]"#,
        f = fixture("units-mm.ifc")
    );
    let options = DetectOptions::default();
    let r = clash_detect_with_options(&config, 0.0, 0.001, &None, &None, &options).unwrap();
    assert!(r.clashes.is_empty());
}
