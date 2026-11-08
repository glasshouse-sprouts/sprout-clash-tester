//! Openings cut out of their host elements before clash detection
//! (SPEC §13f, TASKS T12). Fixture `opening-cut.ifc`: a 4 × 0.2 × 3 m
//! wall with a 1 × 1 m opening, one duct passing through the opening and
//! one through the solid part of the wall.

use clash::ifc_adapter::{IfcMetadata, load_ifc_file_cutting};
use clash::opening_cuts::{OpeningCutStats, VoidMap, check_cuts};
use clash::{DetectOptions, DetectionResult, clash_detect_with_options};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

const WALL: &str = "0WAL000000000000000001";
const OPENING: &str = "0OPN000000000000000001";
const DUCT_THROUGH_OPENING: &str = "0DCT000000000000THROUGH";
const DUCT_THROUGH_WALL: &str = "0DCT00000000000000SOLID";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("models").join(name)
}

fn run(file: &Path, a: &str, b: &str, cut_openings: bool) -> DetectionResult {
    let config = format!(
        r#"[{{ "name": "RULE",
              "a": [{{ "file": {f:?}, "selector": {a:?}, "mode": "i" }}],
              "b": [{{ "file": {f:?}, "selector": {b:?}, "mode": "i" }}] }}]"#,
        f = file.to_string_lossy()
    );
    let options = DetectOptions { skip_related: true, cut_openings, ..Default::default() };
    clash_detect_with_options(&config, 0.0, 0.005, &None, &None, &options).unwrap()
}

/// GUIDs of the ducts that clash with something.
fn clashing_ducts(r: &DetectionResult) -> HashSet<String> {
    r.clashes
        .iter()
        .flat_map(|c| [c.guid_a.clone(), c.guid_b.clone()])
        .filter(|g| g.starts_with("0DCT"))
        .collect()
}

#[test]
fn test_duct_through_opening_is_clear_only_with_cuts() {
    let f = fixture("opening-cut.ifc");

    let cut = run(&f, "IfcDuctSegment", "IfcWall", true);
    assert_eq!(clashing_ducts(&cut), HashSet::from([DUCT_THROUGH_WALL.to_string()]));
    assert_eq!((cut.opening_cuts.hosts_cut, cut.opening_cuts.openings), (1, 1));
    assert!(cut.opening_cuts.failed.is_empty());
    assert!(cut.opening_cuts.not_cut.is_empty());

    // Same model uncut: the wall is a solid box, so both ducts hit it.
    let uncut = run(&f, "IfcDuctSegment", "IfcWall", false);
    assert_eq!(
        clashing_ducts(&uncut),
        HashSet::from([DUCT_THROUGH_WALL.to_string(), DUCT_THROUGH_OPENING.to_string()])
    );
    assert_eq!(uncut.opening_cuts.hosts_cut, 0);
}

#[test]
fn test_cut_host_has_more_triangles() {
    // FZK wall with windows: a plain box uncut, reveals added when cut.
    let f = fixture("AC20-FZK-Haus.ifc");
    let triangles = |cut: bool| {
        let loaded = load_ifc_file_cutting(&f, &|_| cut).unwrap();
        let wall = loaded.elements.iter().find(|e| e.metadata.guid == "1bzfVsJqn8De5PukCrqylz");
        wall.unwrap().mesh.indices().len()
    };
    let (uncut, cut) = (triangles(false), triangles(true));
    assert_eq!(uncut, 12);
    assert!(cut > uncut, "cut wall has {cut} triangles, uncut {uncut}");
}

#[test]
fn test_only_hosts_selected_by_a_rule_are_cut() {
    let f = fixture("AC20-FZK-Haus.ifc");
    // Doors have no openings of their own: nothing to cut.
    assert_eq!(run(&f, "IfcDoor", "IfcDoor", true).opening_cuts.hosts_cut, 0);
    assert!(run(&f, "IfcWall*", "IfcDoor", true).opening_cuts.hosts_cut > 0);
}

/// The fixture with text replacements applied, as a temporary `.ifc`.
fn patched_fixture(replacements: &[(&str, &str)]) -> tempfile::NamedTempFile {
    let source = std::fs::read_to_string(fixture("opening-cut.ifc")).unwrap();
    let mut patched = source.clone();
    for (from, to) in replacements {
        assert!(patched.contains(from), "fixture text changed — update {from}");
        patched = patched.replace(from, to);
    }
    let mut file = tempfile::Builder::new().suffix(".ifc").tempfile().unwrap();
    file.write_all(patched.as_bytes()).unwrap();
    file
}

#[test]
fn test_opening_without_geometry_is_reported_not_cut() {
    // Zero-depth opening: ifc-lite cuts the wall without error but removes
    // nothing. The post-check must name the opening.
    let file = patched_fixture(&[(
        "#25=IFCEXTRUDEDAREASOLID(#22,#24,#8,1.);",
        "#25=IFCEXTRUDEDAREASOLID(#22,#24,#8,0.);",
    )]);
    let r = run(file.path(), "IfcDuctSegment", "IfcWall", true);
    assert_eq!(r.opening_cuts.not_cut, vec![OPENING.to_string()]);
    assert_eq!((r.opening_cuts.hosts_cut, r.opening_cuts.openings), (1, 0));
    let warning = r.warnings.iter().find(|w| w.kind == "opening_not_cut").unwrap();
    assert!(warning.message.contains(OPENING));
    assert_eq!(clashing_ducts(&r).len(), 2, "the wall stays solid");
}

#[test]
fn test_post_check_sees_material_left_in_an_opening() {
    // Feed the check the UNCUT wall: the opening's volume is full of wall,
    // so it must be reported. (Express ids #16 wall, #28 opening.)
    let loaded = load_ifc_file_cutting(fixture("opening-cut.ifc"), &|_| false).unwrap();
    let index = |guid: &str| loaded.elements.iter().position(|e| e.metadata.guid == guid).unwrap();
    let index_by_id = HashMap::from([(16, index(WALL)), (28, index(OPENING))]);
    let voids: VoidMap = [(16, vec![28])].into_iter().collect();
    let metadata: HashMap<u64, IfcMetadata> =
        HashMap::from([(28, loaded.elements[index(OPENING)].metadata.clone())]);
    let mut stats = OpeningCutStats { hosts_cut: 1, openings: 1, ..Default::default() };
    check_cuts(&loaded.elements, &index_by_id, &voids, &metadata, 0.001, &mut stats);
    assert_eq!(stats.not_cut, vec![OPENING.to_string()]);
    assert_eq!(stats.openings, 0);
}

#[test]
fn test_failed_cut_keeps_uncut_mesh_and_is_reported() {
    // An opening far bigger than its wall swallows it; the cut leaves
    // nothing, so the engine must keep the uncut wall and say so.
    let file = patched_fixture(&[
        (
            "#22=IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,1.,0.4);",
            "#22=IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,10.,10.);",
        ),
        ("#25=IFCEXTRUDEDAREASOLID(#22,#24,#8,1.);", "#25=IFCEXTRUDEDAREASOLID(#22,#4,#8,10.);"),
    ]);

    let r = run(file.path(), "IfcDuctSegment", "IfcWall", true);
    assert_eq!(r.opening_cuts.failed, vec![WALL.to_string()]);
    assert_eq!(r.opening_cuts.hosts_cut, 0);
    let warning = r.warnings.iter().find(|w| w.kind == "opening_cut_failed").unwrap();
    assert!(warning.message.contains(WALL));
    // Uncut wall kept: both ducts hit it.
    assert_eq!(clashing_ducts(&r).len(), 2);
}
