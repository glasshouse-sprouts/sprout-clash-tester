//! The ifc-lite narrow phase behind `--narrow-phase ifclite`
//! (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase): same rule pipeline as parry, touch is never a
//! clash unless asked for, box estimates need parry to confirm a surface
//! crossing, and survey coordinates don't lose precision.

use clash::ifc_adapter::{IfcElement, IfcMetadata};
use clash::ifclite_narrow::{NarrowPhase, Outcome, Verdict, classify};
use clash::{DetectOptions, NarrowConfig, RuleCounts, clash_detect_rule, clash_detect_with_options};
use ifc_lite_clash::{ClashStatus, DistanceKind};
use parry3d_f64::math::Vector;
use parry3d_f64::shape::TriMesh;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Axis-aligned box element, metres (as every mesh is after load).
fn cube(guid: &str, min: [f64; 3], max: [f64; 3]) -> IfcElement {
    let c = |i: usize| {
        Vector::new(
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        )
    };
    let vertices = (0..8).map(c).collect();
    let indices = vec![
        [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], // z faces
        [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], // y faces
        [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5], // x faces
    ];
    IfcElement {
        metadata: IfcMetadata {
            guid: guid.to_string(),
            ifc_type: "IFCBUILDINGELEMENTPROXY".to_string(),
            discipline: "General".to_string(),
            properties: HashMap::new(),
            length_unit: "metre".to_string(),
            source_file: "boxes.ifc".to_string(),
            type_class: None,
            predefined_type: None,
        },
        mesh: TriMesh::new(vertices, indices).unwrap(),
    }
}

/// A at the origin, B overlapping it by 0.1 m, C touching it face to face.
/// Metres, shifted by `offset` metres.
fn scene(offset: [f64; 3]) -> (Vec<IfcElement>, Vec<IfcElement>) {
    let b = |guid: &str, min: [f64; 3], max: [f64; 3]| {
        let at = |p: [f64; 3]| [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
        cube(guid, at(min), at(max))
    };
    let a = vec![b("A", [0.0; 3], [1.0; 3])];
    let others = vec![
        b("B_OVERLAP", [0.9, 0.0, 0.0], [1.9, 1.0, 1.0]),
        b("C_TOUCH", [0.0, 1.0, 0.0], [1.0, 2.0, 1.0]),
    ];
    (a, others)
}

type Clashes = Vec<clash::bcf_reporter::ClashInfo>;

fn run(a: &[IfcElement], b: &[IfcElement], narrow: NarrowConfig) -> (Clashes, RuleCounts) {
    let (_, infos, counts) =
        clash_detect_rule(a, b, 0.0, 0.005, &None, &None, "R", None, narrow).unwrap();
    (infos, counts)
}

const IFCLITE: NarrowConfig = NarrowConfig { phase: NarrowPhase::Ifclite, report_touch: false };

#[test]
fn test_touch_is_counted_not_a_clash() {
    let (a, b) = scene([0.0; 3]);
    let (infos, counts) = run(&a, &b, IFCLITE);
    assert_eq!(infos.iter().map(|c| c.guid_b.as_str()).collect::<Vec<_>>(), vec!["B_OVERLAP"]);
    assert_eq!(counts.touch, 1);
    let hit = &infos[0];
    assert_eq!(hit.status.as_deref(), Some("hard"));
    assert_eq!(hit.distance_kind.as_deref(), Some("mesh"), "box × box depth is exact");
    assert!((hit.depth_metres.unwrap() - 0.1).abs() < 1e-6);
}

#[test]
fn test_report_touch_lists_touching_pairs() {
    let (a, b) = scene([0.0; 3]);
    let (infos, counts) = run(&a, &b, NarrowConfig { report_touch: true, ..IFCLITE });
    let statuses: HashSet<_> =
        infos.iter().map(|c| (c.guid_b.as_str(), c.status.as_deref())).collect();
    assert_eq!(statuses, HashSet::from([("B_OVERLAP", Some("hard")), ("C_TOUCH", Some("touch"))]));
    assert_eq!(counts.touch, 1);
    // A listed touch says what it is, in the description and BCF title.
    let touch = infos.iter().find(|c| c.guid_b == "C_TOUCH").unwrap();
    assert!(touch.description.starts_with("[R] Touch between "), "{}", touch.description);
    let topic = clash::bcf_reporter::BcfTopic::from_clash(2, touch);
    assert!(topic.title.starts_with("2 - Touch between "), "{}", topic.title);
}

#[test]
fn test_survey_coordinates_give_the_same_clashes() {
    // Danish UTM-like coordinates: at 6.17e6 m an f32 step is 0.5 m, far
    // too coarse unless the engine shifts to a local origin first.
    let (a0, b0) = scene([0.0; 3]);
    let (a1, b1) = scene([720_000.0, 6_170_000.0, 40.0]);
    let (near, near_counts) = run(&a0, &b0, IFCLITE);
    let (far, far_counts) = run(&a1, &b1, IFCLITE);
    assert_eq!(near_counts, far_counts);
    assert_eq!(near.len(), far.len());
    for (n, f) in near.iter().zip(&far) {
        assert_eq!(n.guid_b, f.guid_b);
        assert!((n.depth_metres.unwrap() - f.depth_metres.unwrap()).abs() < 1e-3);
        // Contact point comes back in world metres.
        assert!((f.position[1] - (n.position[1] + 6_170_000.0)).abs() < 1e-2);
    }
}

#[test]
fn test_self_check_mode_counts_each_pair_once() {
    // Same elements on both sides: ifc-lite's self mode. Pairs: A × B
    // overlap, A × C touch, B × C touch along an edge strip — each once.
    let (a, b) = scene([0.0; 3]);
    let all: Vec<IfcElement> = a.iter().chain(&b).cloned().collect();
    let (infos, counts) = run(&all, &all, IFCLITE);
    let pairs: Vec<_> = infos.iter().map(|c| (c.guid_a.as_str(), c.guid_b.as_str())).collect();
    assert_eq!(pairs, vec![("A", "B_OVERLAP")]);
    assert_eq!(counts.touch, 2);
}

fn verdict(status: ClashStatus, kind: DistanceKind, distance: f64) -> Verdict {
    Verdict { status, distance, kind, point: [0.0; 3] }
}

#[test]
fn test_box_estimate_needs_parry_to_confirm() {
    let v = verdict(ClashStatus::Hard, DistanceKind::Estimate, 0.05);
    let unconfirmed = classify(Some(&v), false, 0.005, || Ok(false)).unwrap();
    assert_eq!(unconfirmed, Outcome::Unconfirmed(v));
    assert_eq!(classify(Some(&v), false, 0.005, || Ok(true)).unwrap(), Outcome::Clash(v));
    // A measured depth never asks parry.
    let m = verdict(ClashStatus::Hard, DistanceKind::Mesh, 0.05);
    let asked = classify(Some(&m), false, 0.005, || panic!("parry consulted")).unwrap();
    assert_eq!(asked, Outcome::Clash(m));
    // Shallower than the minimum penetration: nothing.
    let shallow = verdict(ClashStatus::Hard, DistanceKind::Mesh, 0.001);
    assert_eq!(classify(Some(&shallow), false, 0.005, || Ok(true)).unwrap(), Outcome::Nothing);
}

#[test]
fn test_clearance_mode_reports_overlap_as_zero_gap() {
    let v = verdict(ClashStatus::Hard, DistanceKind::Mesh, 0.05);
    let Outcome::Clash(c) = classify(Some(&v), true, 0.005, || Ok(true)).unwrap() else {
        panic!("clearance hit expected");
    };
    assert_eq!(c.distance, 0.0);
}

#[test]
fn test_fixture_gives_the_same_clashes_in_both_phases() {
    let ifc = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/models/opening-cut.ifc");
    let config = format!(
        r#"[{{ "name": "DUCTxWALL",
              "a": [{{ "file": {f:?}, "selector": "IfcDuctSegment", "mode": "i" }}],
              "b": [{{ "file": {f:?}, "selector": "IfcWall", "mode": "i" }}] }}]"#,
        f = ifc.to_string_lossy()
    );
    let guids = |phase: NarrowPhase| {
        let narrow = NarrowConfig { phase, report_touch: false };
        let options = DetectOptions { narrow, ..Default::default() };
        let r = clash_detect_with_options(&config, 0.0, 0.005, &None, &None, &options).unwrap();
        r.clashes.iter().map(|c| (c.guid_a.clone(), c.guid_b.clone())).collect::<Vec<_>>()
    };
    assert_eq!(guids(NarrowPhase::Parry), guids(NarrowPhase::Ifclite));
    assert_eq!(guids(NarrowPhase::Ifclite).len(), 1);
}

/// A unit box and one neighbour beside it in +Y at `gap` metres (negative
/// = overlap), through the ifc-lite phase.
fn neighbour_at(gap: f64) -> (Clashes, RuleCounts) {
    let a = vec![cube("A", [0.0; 3], [1.0; 3])];
    let b = vec![cube("N", [0.0, 1.0 + gap, 0.0], [1.0, 2.0 + gap, 1.0])];
    run(&a, &b, IFCLITE)
}

#[test]
fn test_touch_band_is_one_millimetre() {
    assert_eq!(clash::ifclite_narrow::TOUCH_TOLERANCE_METRES, 0.001);
    let (infos, counts) = neighbour_at(0.0005);
    assert_eq!((infos.len(), counts.touch), (0, 1), "0.5 mm gap is a touch");
    let (infos, counts) = neighbour_at(0.0015);
    assert_eq!((infos.len(), counts.touch), (0, 0), "1.5 mm gap is clear");
    let (infos, counts) = neighbour_at(-0.0005);
    assert_eq!((infos.len(), counts.touch), (0, 1), "0.5 mm overlap is a touch");
}

#[test]
fn test_min_depth_is_at_least_in_both_phases() {
    assert!(clash::deep_enough(0.005, 0.005));
    assert!(!clash::deep_enough(0.0049, 0.005));
    let at_min = verdict(ClashStatus::Hard, DistanceKind::Mesh, 0.005);
    let kept = classify(Some(&at_min), false, 0.005, || Ok(true)).unwrap();
    assert_eq!(kept, Outcome::Clash(at_min));
    // Parry end to end: boxes overlapping by exactly 0.5 m (exact in
    // binary) against a 0.5 m minimum — kept (the rule used to be `>`).
    let a = vec![cube("A", [0.0; 3], [1.0; 3])];
    let b = vec![cube("B", [0.5, 0.0, 0.0], [1.5, 1.0, 1.0])];
    let parry = NarrowConfig { phase: NarrowPhase::Parry, report_touch: false };
    let at = |min: f64| {
        clash_detect_rule(&a, &b, 0.0, min, &None, &None, "R", None, parry).unwrap().1.len()
    };
    assert_eq!((at(0.5), at(0.5000001)), (1, 0));
}
