//! Self check: a model tested against itself (same file on both sides of
//! a rule) — finds internal clashes and double modelling. See docs/HOW-IT-WORKS.md#self-check.
//!
//! The engine must (1) never report an element clashing with itself and
//! (2) report each unordered element pair at most once. `aabb_match`
//! scores how alike two bounding boxes are (1.0 = identical) so the Node
//! side can flag likely double modelling.

use clash::{aabb_match, clash_detect_with_config, mesh_measure};
use parry3d_f64::bounding_volume::Aabb;
use parry3d_f64::math::Vector;
use parry3d_f64::shape::TriMesh;
use std::collections::HashSet;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("models");
    p.push(name);
    p
}

/// One rule with the same file on both sides.
fn self_check_config(file: &str) -> String {
    let f = fixture(file);
    format!(
        r#"[
            {{
                "name": "SELF",
                "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
                "b": [{{ "file": {:?}, "selector": "*", "mode": "i" }}]
            }}
        ]"#,
        f.to_string_lossy(),
        f.to_string_lossy()
    )
}

fn assert_clean_self_check(file: &str, tolerance: f64) {
    let json = self_check_config(file);
    let result = clash_detect_with_config(&json, tolerance, 0.005, &None, &None)
        .expect("self check should run");
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for c in &result.clashes {
        assert!(
            !(c.guid_a == c.guid_b && c.file_a == c.file_b),
            "element reported clashing with itself: {} in {}",
            c.guid_a,
            c.file_a
        );
        let a = format!("{}#{}", c.file_a, c.guid_a);
        let b = format!("{}#{}", c.file_b, c.guid_b);
        let key = if a < b { (a, b) } else { (b, a) };
        assert!(seen.insert(key.clone()), "pair reported twice: {:?}", key);
        if let Some(m) = c.aabb_match {
            assert!((0.0..=1.0).contains(&m), "aabb_match out of range: {}", m);
        }
    }
    println!(
        "self check {} (tolerance {}): {} clash(es), all unique, none self",
        file,
        tolerance,
        result.clashes.len()
    );
}

#[test]
fn test_self_check_structural_intersection() {
    assert_clean_self_check("Building-Structural.ifc", 0.0);
}

#[test]
fn test_self_check_hvac_intersection() {
    assert_clean_self_check("Building-Hvac.ifc", 0.0);
}

#[test]
fn test_self_check_clearance_mode() {
    // Clearance mode skips the AABB broad phase, so the self/mirror skip
    // must still hold on that path.
    assert_clean_self_check("Building-Hvac.ifc", 0.05);
}

#[test]
fn test_cross_file_rule_unchanged_by_self_skip() {
    // A normal two-file rule must not lose clashes to the new skip logic:
    // every element pair is still unique per rule and still reported.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let json = format!(
        r#"[{{ "name": "HVACxSTR",
               "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
               "b": [{{ "file": {:?}, "selector": "*", "mode": "i" }}] }}]"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let result = clash_detect_with_config(&json, 0.1, 0.005, &None, &None).unwrap();
    assert!(!result.clashes.is_empty(), "fixture pair should still clash");
    // Same-GUID elements in *different* files are still reported — that
    // is a real cross-model finding, not a self pair.
    for c in &result.clashes {
        assert_ne!(c.file_a, c.file_b, "cross-file rule produced a same-file clash");
    }
}

// ─── Self-check exclude (spaces + openings) ──────────────────────────────────

/// The self-check default exclude (docs/HOW-IT-WORKS.md#self-check).
const SPACES_AND_OPENINGS: &str =
    "IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase";

fn self_check_config_with_exclude(file: &str, exclude: &str) -> String {
    let f = fixture(file);
    format!(
        r#"[{{ "name": "SELF",
               "a": [{{ "file": {f:?}, "selector": "*", "mode": "i", "exclude": {exclude:?} }}],
               "b": [{{ "file": {f:?}, "selector": "*", "mode": "i", "exclude": {exclude:?} }}] }}]"#,
        f = f.to_string_lossy(),
        exclude = exclude
    )
}

/// Does a clash description name a space, zone or opening on either side?
fn involves_space_or_opening(description: &str) -> bool {
    let d = description.to_uppercase();
    d.contains("IFCSPACE") || d.contains("IFCSPATIALZONE") || d.contains("IFCOPENING")
}

#[test]
fn test_self_check_default_exclude_drops_spatial_zones() {
    // Building-Architecture has an IfcSpatialZone that "clashes" with the
    // slabs and walls around it.
    let without = clash_detect_with_config(&self_check_config("Building-Architecture.ifc"), 0.0, 0.005, &None, &None)
        .unwrap();
    assert!(
        without.clashes.iter().any(|c| c.description.to_uppercase().contains("IFCSPATIALZONE")),
        "fixture should produce spatial-zone clashes without the exclude"
    );
    let with = clash_detect_with_config(
        &self_check_config_with_exclude("Building-Architecture.ifc", SPACES_AND_OPENINGS),
        0.0,
        0.005,
        &None,
        &None,
    )
    .unwrap();
    for c in &with.clashes {
        assert!(!involves_space_or_opening(&c.description), "excluded type still clashes: {}", c.description);
    }
    println!("Architecture self check: {} → {} clashes", without.clashes.len(), with.clashes.len());
}

#[test]
fn test_self_check_fzk_haus_has_space_and_opening_clashes_without_exclude() {
    let json = self_check_config("AC20-FZK-Haus.ifc");
    let result = clash_detect_with_config(&json, 0.0, 0.005, &None, &None).unwrap();
    let n = result
        .clashes
        .iter()
        .filter(|c| involves_space_or_opening(&c.description))
        .count();
    println!("FZK-Haus self check, no exclude: {} clashes, {} with spaces/openings", result.clashes.len(), n);
    assert!(n > 0, "fixture should produce space/opening clashes without the exclude");
}

#[test]
fn test_self_check_fzk_haus_default_exclude_drops_spaces_and_openings() {
    let json = self_check_config_with_exclude("AC20-FZK-Haus.ifc", SPACES_AND_OPENINGS);
    let result = clash_detect_with_config(&json, 0.0, 0.005, &None, &None).unwrap();
    println!("FZK-Haus self check, default exclude: {} clashes", result.clashes.len());
    for c in &result.clashes {
        assert!(
            !involves_space_or_opening(&c.description),
            "excluded type still clashes: {}",
            c.description
        );
    }
}

#[test]
fn test_exclude_field_is_optional() {
    // Configs without `exclude` (all existing projects) still parse and run.
    let json = self_check_config("Building-Structural.ifc");
    assert!(!json.contains("exclude"));
    clash_detect_with_config(&json, 0.0, 0.005, &None, &None).expect("config without exclude");
}

// ─── aabb_match ──────────────────────────────────────────────────────────────

fn bx(min: [f64; 3], max: [f64; 3]) -> Aabb {
    Aabb::new(
        Vector::new(min[0], min[1], min[2]),
        Vector::new(max[0], max[1], max[2]),
    )
}

#[test]
fn test_aabb_match_identical_is_one() {
    let a = bx([0.0, 0.0, 0.0], [4.0, 0.2, 3.0]);
    let m = aabb_match(&a, &a).unwrap();
    assert!((m - 1.0).abs() < 1e-12, "got {}", m);
}

#[test]
fn test_aabb_match_half_overlap_on_one_axis() {
    let a = bx([0.0, 0.0, 0.0], [4.0, 1.0, 1.0]);
    let b = bx([2.0, 0.0, 0.0], [6.0, 1.0, 1.0]);
    let m = aabb_match(&a, &b).unwrap();
    assert!((m - 0.5).abs() < 1e-12, "got {}", m);
}

#[test]
fn test_aabb_match_small_inside_big_is_low() {
    // A pipe passing through a wall: boxes overlap, but are not alike.
    let wall = bx([0.0, 0.0, 0.0], [10.0, 0.3, 3.0]);
    let pipe = bx([4.9, -1.0, 1.4], [5.1, 1.3, 1.6]);
    let m = aabb_match(&wall, &pipe).unwrap();
    assert!(m < 0.1, "got {}", m);
}

#[test]
fn test_aabb_match_disjoint_is_none() {
    let a = bx([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let b = bx([5.0, 5.0, 5.0], [6.0, 6.0, 6.0]);
    assert!(aabb_match(&a, &b).is_none());
}

#[test]
fn test_aabb_match_flat_elements_compare() {
    // Zero thickness on Z (e.g. a covering exported as a surface).
    let a = bx([0.0, 0.0, 1.0], [2.0, 2.0, 1.0]);
    let b = bx([0.0, 0.0, 1.0], [2.0, 2.0, 1.0]);
    let m = aabb_match(&a, &b).unwrap();
    assert!((m - 1.0).abs() < 1e-12, "got {}", m);
}

// ─── mesh_measure (volume + centre, for double-modelling detection) ─────────

/// Box mesh from min to max. `flip_some` reverses half the triangles so the
/// winding is inconsistent — the measure must not care.
fn box_mesh(min: [f64; 3], max: [f64; 3], flip_some: bool) -> TriMesh {
    let [x0, y0, z0] = min;
    let [x1, y1, z1] = max;
    let v = vec![
        Vector::new(x0, y0, z0),
        Vector::new(x1, y0, z0),
        Vector::new(x1, y1, z0),
        Vector::new(x0, y1, z0),
        Vector::new(x0, y0, z1),
        Vector::new(x1, y0, z1),
        Vector::new(x1, y1, z1),
        Vector::new(x0, y1, z1),
    ];
    let mut idx: Vec<[u32; 3]> = vec![
        [0, 2, 1], [0, 3, 2], // bottom
        [4, 5, 6], [4, 6, 7], // top
        [0, 1, 5], [0, 5, 4], // front
        [1, 2, 6], [1, 6, 5], // right
        [2, 3, 7], [2, 7, 6], // back
        [3, 0, 4], [3, 4, 7], // left
    ];
    if flip_some {
        for (i, t) in idx.iter_mut().enumerate() {
            if i % 2 == 0 {
                t.swap(1, 2);
            }
        }
    }
    TriMesh::new(v, idx).expect("box mesh")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9 * a.abs().max(b.abs()).max(1.0)
}

#[test]
fn test_mesh_measure_box_volume_and_centre() {
    let m = mesh_measure(&box_mesh([0.0, 0.0, 0.0], [4.0, 0.2, 3.0], false)).unwrap();
    assert!(close(m.volume, 2.4), "volume {}", m.volume);
    assert!(close(m.centroid[0], 2.0) && close(m.centroid[1], 0.1) && close(m.centroid[2], 1.5));
}

#[test]
fn test_mesh_measure_ignores_winding() {
    let a = mesh_measure(&box_mesh([0.0, 0.0, 0.0], [2.0, 3.0, 4.0], false)).unwrap();
    let b = mesh_measure(&box_mesh([0.0, 0.0, 0.0], [2.0, 3.0, 4.0], true)).unwrap();
    assert!(close(a.volume, 24.0) && close(b.volume, 24.0), "{} vs {}", a.volume, b.volume);
}

#[test]
fn test_mesh_measure_at_survey_coordinates() {
    // 1 m cube at ~6.7 million mm east — precision must hold.
    let o = [6_675_000_000.0, 25_000_000.0, 40_000.0];
    let m = mesh_measure(&box_mesh(o, [o[0] + 1000.0, o[1] + 1000.0, o[2] + 1000.0], false)).unwrap();
    assert!((m.volume - 1.0e9).abs() < 1.0, "volume {}", m.volume);
    assert!((m.centroid[0] - (o[0] + 500.0)).abs() < 1e-3);
}

#[test]
fn test_mesh_measure_flat_mesh_has_zero_volume() {
    let v = vec![
        Vector::new(0.0, 0.0, 1.0),
        Vector::new(2.0, 0.0, 1.0),
        Vector::new(2.0, 2.0, 1.0),
        Vector::new(0.0, 2.0, 1.0),
    ];
    let mesh = TriMesh::new(v, vec![[0, 1, 2], [0, 2, 3]]).unwrap();
    let m = mesh_measure(&mesh).unwrap();
    assert_eq!(m.volume, 0.0);
    assert!(close(m.centroid[0], 1.0) && close(m.centroid[2], 1.0));
}

#[test]
fn test_clashes_carry_volume_and_centroid_distance() {
    let json = self_check_config("Building-Structural.ifc");
    let result = clash_detect_with_config(&json, 0.0, 0.005, &None, &None).unwrap();
    for c in &result.clashes {
        let d = c.centroid_distance.expect("centroid distance should be set");
        assert!(d >= 0.0 && d.is_finite());
        for v in [c.volume_a, c.volume_b].into_iter().flatten() {
            assert!(v > 0.0 && v.is_finite(), "bad volume {}", v);
        }
    }
}
