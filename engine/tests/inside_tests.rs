//! Elements fully inside another (docs/HOW-IT-WORKS.md#elements-fully-inside):
//! reported as mode `inside` when the rule asks for it, in both narrow
//! phases, through the same filters as other clashes.

use clash::bcf_reporter::{BcfTopic, ClashInfo};
use clash::ifc_adapter::{IfcElement, IfcMetadata};
use clash::ifclite_narrow::NarrowPhase;
use clash::{ClashSet, NarrowConfig, RelatedPairs, RuleCounts, clash_detect_rule};
use parry3d_f64::math::Vector;
use parry3d_f64::shape::TriMesh;
use std::collections::{HashMap, HashSet};

const BOX_TRIANGLES: [[u32; 3]; 12] = [
    [0, 2, 1],
    [1, 2, 3],
    [4, 5, 6],
    [5, 7, 6], // z faces
    [0, 1, 4],
    [1, 5, 4],
    [2, 6, 3],
    [3, 6, 7], // y faces
    [0, 4, 2],
    [2, 4, 6],
    [1, 3, 5],
    [3, 7, 5], // x faces
];

/// Axis-aligned box element in metres; `open` leaves the top face out.
fn cube_with(guid: &str, min: [f64; 3], max: [f64; 3], open: bool) -> IfcElement {
    let corner = |i: usize| {
        Vector::new(
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        )
    };
    let skip = if open { 2 } else { 0 }; // the two z-max triangles
    let indices: Vec<[u32; 3]> = BOX_TRIANGLES
        .iter()
        .enumerate()
        .filter(|(i, _)| !(*i >= 2 && *i < 2 + skip))
        .map(|(_, t)| *t)
        .collect();
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
        mesh: TriMesh::new((0..8).map(corner).collect(), indices).unwrap(),
    }
}

fn cube(guid: &str, min: [f64; 3], max: [f64; 3]) -> IfcElement {
    cube_with(guid, min, max, false)
}

/// A 4 × 4 × 0.3 m slab.
fn slab() -> IfcElement {
    cube("SLAB", [0.0, 0.0, 0.0], [4.0, 4.0, 0.3])
}

/// A 0.1 m pipe lying completely inside the slab.
fn pipe_inside() -> IfcElement {
    cube("PIPE", [1.0, 1.0, 0.1], [3.0, 1.1, 0.2])
}

fn narrow(phase: NarrowPhase, report_inside: bool) -> NarrowConfig {
    NarrowConfig {
        phase,
        report_inside,
        ..NarrowConfig::default()
    }
}

fn run(
    a: &[IfcElement],
    b: &[IfcElement],
    tolerance: f64,
    min_depth: f64,
    related: Option<&RelatedPairs>,
    n: NarrowConfig,
) -> (Vec<ClashInfo>, RuleCounts) {
    let (_, infos, counts) =
        clash_detect_rule(a, b, tolerance, min_depth, &None, &None, "R", related, n).unwrap();
    (infos, counts)
}

const PHASES: [NarrowPhase; 2] = [NarrowPhase::Parry, NarrowPhase::Ifclite];

#[test]
fn test_box_inside_box_is_found_when_on_and_not_when_off() {
    for phase in PHASES {
        let (on, _) = run(
            &[pipe_inside()],
            &[slab()],
            0.0,
            0.005,
            None,
            narrow(phase, true),
        );
        assert_eq!(on.len(), 1, "{phase:?}");
        let hit = &on[0];
        assert_eq!(hit.mode, "inside");
        assert!(
            (hit.depth_metres.unwrap() - 0.1).abs() < 1e-9,
            "inner's smallest side"
        );
        assert_eq!(hit.gap_metres, None);
        assert_eq!(
            hit.description,
            "[R] Fully inside between IFCBUILDINGELEMENTPROXY (PIPE) and \
             IFCBUILDINGELEMENTPROXY (SLAB): PIPE is inside SLAB"
        );
        // Off behaves as v0.1.0: parry misses the pair, ifc-lite calls it a
        // hard clash.
        let (off, _) = run(
            &[pipe_inside()],
            &[slab()],
            0.0,
            0.005,
            None,
            narrow(phase, false),
        );
        let modes: Vec<_> = off.iter().map(|c| c.mode.as_str()).collect();
        let v010 = match phase {
            NarrowPhase::Parry => vec![],
            NarrowPhase::Ifclite => vec!["intersection"],
        };
        assert_eq!(modes, v010, "{phase:?}");
    }
}

#[test]
fn test_outer_element_on_side_a_is_found_too() {
    let (infos, _) = run(
        &[slab()],
        &[pipe_inside()],
        0.0,
        0.005,
        None,
        narrow(NarrowPhase::Parry, true),
    );
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].guid_a, "SLAB");
    assert!(
        infos[0].description.ends_with(": PIPE is inside SLAB"),
        "{}",
        infos[0].description
    );
}

#[test]
fn test_bcf_topic_says_fully_inside() {
    let (infos, _) = run(
        &[pipe_inside()],
        &[slab()],
        0.0,
        0.005,
        None,
        narrow(NarrowPhase::Parry, true),
    );
    let topic = BcfTopic::from_clash(3, &infos[0]);
    assert_eq!(topic.title, "3 - Fully inside: PIPE and SLAB");
    assert!(topic.description.contains("Fully inside between"));
}

#[test]
fn test_pipe_through_slab_is_still_a_normal_clash() {
    let through = cube("PIPE", [1.0, 1.0, -0.5], [1.1, 1.1, 0.8]);
    for phase in PHASES {
        let (infos, _) = run(
            std::slice::from_ref(&through),
            &[slab()],
            0.0,
            0.005,
            None,
            narrow(phase, true),
        );
        assert_eq!(infos.len(), 1, "{phase:?}");
        assert_eq!(infos[0].mode, "intersection", "{phase:?}");
    }
}

#[test]
fn test_touching_boxes_are_not_inside() {
    // Side by side, and flush on the slab's top face.
    let beside = cube("BESIDE", [4.0, 0.0, 0.0], [5.0, 1.0, 0.3]);
    let on_top = cube("ON_TOP", [1.0, 1.0, 0.3], [2.0, 2.0, 0.5]);
    for phase in PHASES {
        let (infos, _) = run(
            &[beside.clone(), on_top.clone()],
            &[slab()],
            0.0,
            0.005,
            None,
            narrow(phase, true),
        );
        assert!(
            infos.iter().all(|c| c.mode != "inside"),
            "{phase:?}: {infos:?}"
        );
    }
}

#[test]
fn test_element_in_the_hollow_of_another_is_not_inside() {
    // One outer element made of two slabs 2 m apart (a closed mesh in two
    // parts): the pipe between them is within its box but not its mesh.
    let lower = cube("X", [0.0, 0.0, 0.0], [4.0, 4.0, 0.3]).mesh;
    let upper = cube("X", [0.0, 0.0, 2.0], [4.0, 4.0, 2.3]).mesh;
    let mut vertices = lower.vertices().to_vec();
    vertices.extend_from_slice(upper.vertices());
    let mut indices = lower.indices().to_vec();
    indices.extend(upper.indices().iter().map(|t| t.map(|i| i + 8)));
    let mut two_slabs = slab();
    two_slabs.mesh = TriMesh::new(vertices, indices).unwrap();
    let between = cube("PIPE", [1.0, 1.0, 1.0], [3.0, 1.1, 1.1]);
    for phase in PHASES {
        let (infos, _) = run(
            std::slice::from_ref(&between),
            std::slice::from_ref(&two_slabs),
            0.0,
            0.005,
            None,
            narrow(phase, true),
        );
        assert!(infos.is_empty(), "{phase:?}: {infos:?}");
    }
}

#[test]
fn test_open_outer_mesh_is_skipped_and_counted() {
    let open_slab = cube_with("SLAB", [0.0, 0.0, 0.0], [4.0, 4.0, 0.3], true);
    let (infos, counts) = run(
        &[pipe_inside()],
        &[open_slab],
        0.0,
        0.005,
        None,
        narrow(NarrowPhase::Parry, true),
    );
    assert!(infos.is_empty());
    assert_eq!(counts.inside_open_mesh, 1);
}

#[test]
fn test_min_depth_applies_to_the_inner_element() {
    let thin = cube("THIN", [1.0, 1.0, 0.1], [3.0, 1.003, 0.2]); // 3 mm
    let (infos, _) = run(
        &[thin],
        &[slab()],
        0.0,
        0.005,
        None,
        narrow(NarrowPhase::Parry, true),
    );
    assert!(infos.is_empty(), "3 mm < 5 mm minimum depth");
}

#[test]
fn test_relation_skip_and_self_check_dedupe_apply() {
    let related: RelatedPairs = HashMap::from([(
        "boxes.ifc".to_string(),
        HashSet::from([("PIPE".to_string(), "SLAB".to_string())]),
    )]);
    let (infos, counts) = run(
        &[pipe_inside()],
        &[slab()],
        0.0,
        0.005,
        Some(&related),
        narrow(NarrowPhase::Parry, true),
    );
    assert!(infos.is_empty());
    assert_eq!(counts.skipped_by_relations, 1);

    // Self check: both elements on both sides, the pair reported once.
    let all = vec![slab(), pipe_inside()];
    let (infos, _) = run(
        &all,
        &all,
        0.0,
        0.005,
        None,
        narrow(NarrowPhase::Parry, true),
    );
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].mode, "inside");
}

#[test]
fn test_clearance_mode_reports_inside_too() {
    // 0.1 m from the slab's faces: farther than a 5 cm clearance.
    let (infos, _) = run(
        &[pipe_inside()],
        &[slab()],
        0.05,
        0.005,
        None,
        narrow(NarrowPhase::Parry, true),
    );
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].mode, "inside");
    assert_eq!(infos[0].gap_metres, None);
}

#[test]
fn test_rule_option_defaults_to_on() {
    let rule: ClashSet = serde_json::from_str(r#"{ "name": "R", "a": [], "b": [] }"#).unwrap();
    assert!(rule.report_inside);
    let off: ClashSet =
        serde_json::from_str(r#"{ "name": "R", "a": [], "b": [], "report_inside": false }"#)
            .unwrap();
    assert!(!off.report_inside);
}
