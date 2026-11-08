//! Skipping pairs that belong together by IFC relations, and loading each
//! file once per run (SPEC §13e, TASKS T9).

use clash::ifc_adapter::{load_ifc_elements, load_ifc_file, ordered_pair};
use clash::{
    DetectOptions, clash_detect_between_groups, clash_detect_with_config, clash_detect_with_options,
};
use std::io::Write;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("models").join(name)
}

fn rule(name: &str, file: &PathBuf, a: &str, b: &str) -> String {
    format!(
        r#"{{ "name": {name:?},
             "a": [{{ "file": {f:?}, "selector": {a:?}, "mode": "i" }}],
             "b": [{{ "file": {f:?}, "selector": {b:?}, "mode": "i" }}] }}"#,
        f = file.to_string_lossy()
    )
}

fn run(rules: &[String], skip_related: bool) -> clash::DetectionResult {
    clash_detect_with_options(
        &format!("[{}]", rules.join(",")),
        0.0,
        0.005,
        &None,
        &None,
        &DetectOptions { skip_related, ..DetectOptions::default() },
    )
    .unwrap()
}

#[test]
fn test_relations_parsed_into_guid_pairs() {
    // Wall with an opening filled by a door; an assembly of two beams.
    // No geometry — only the relation pass is exercised.
    let mut f = tempfile::NamedTempFile::new().unwrap();
    for line in [
        "ISO-10303-21;",
        "HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;",
        "DATA;",
        "#1=IFCWALL('WALL',$,$,$,$,$,$,$,$);",
        "#2=IFCOPENINGELEMENT('OPEN',$,$,$,$,$,$,$,$);",
        "#3=IFCDOOR('DOOR',$,$,$,$,$,$,$,$,$,$,$,$);",
        "#4=IFCELEMENTASSEMBLY('ASM',$,$,$,$,$,$,$,$,$);",
        "#5=IFCBEAM('BEAM1',$,$,$,$,$,$,$,$);",
        "#6=IFCBEAM('BEAM2',$,$,$,$,$,$,$,$);",
        "#7=IFCBEAM('LONE',$,$,$,$,$,$,$,$);",
        "#10=IFCRELVOIDSELEMENT('RV',$,$,$,#1,#2);",
        "#11=IFCRELFILLSELEMENT('RF',$,$,$,#2,#3);",
        "#12=IFCRELAGGREGATES('RA',$,$,$,#4,(#5,#6));",
        "ENDSEC;",
        "END-ISO-10303-21;",
    ] {
        writeln!(f, "{line}").unwrap();
    }
    let loaded = load_ifc_file(f.path()).unwrap();
    let mut pairs: Vec<_> = loaded.related_pairs.into_iter().collect();
    pairs.sort();
    let mut expected = vec![
        ordered_pair("WALL", "OPEN"),  // host × opening
        ordered_pair("OPEN", "DOOR"),  // opening × filling
        ordered_pair("WALL", "DOOR"),  // host × filling via the opening
        ordered_pair("ASM", "BEAM1"),  // whole × part
        ordered_pair("ASM", "BEAM2"),
        ordered_pair("BEAM1", "BEAM2"), // part × part
    ];
    expected.sort();
    assert_eq!(pairs, expected);
}

#[test]
fn test_fzk_doors_in_walls_are_skipped() {
    let f = fixture("AC20-FZK-Haus.ifc");
    let r = vec![rule("DOORxWALL", &f, "IfcDoor", "IfcWall*")];
    let on = run(&r, true);
    assert_eq!(on.clashes.len(), 0, "every FZK door sits in its own wall");
    assert_eq!(on.rule_stats[0].name, "DOORxWALL");
    assert_eq!(on.rule_stats[0].skipped_by_relations, 5);
    let off = run(&r, false);
    assert_eq!(off.clashes.len(), 5, "setting off reproduces the old count");
    assert_eq!(off.rule_stats[0].skipped_by_relations, 0);
}

#[test]
fn test_fzk_windows_stay_clean() {
    // Since T12 the walls have holes, and each window frame sits a little
    // into its reveal (75–90 mm): 11 hits with the skip off, all of them
    // window × own wall, so the skip removes every one.
    let f = fixture("AC20-FZK-Haus.ifc");
    let r = vec![rule("WINxWALL", &f, "IfcWindow", "IfcWall*")];
    let on = run(&r, true);
    assert_eq!(on.clashes.len(), 0);
    assert_eq!(on.rule_stats[0].skipped_by_relations, 11);
    assert_eq!(run(&r, false).clashes.len(), 11);
}

#[test]
fn test_fzk_self_check_rebaselined() {
    // Local-frame + RTC meshes (T14): 257 without relation skip, 208 with
    // it. Versus T12's 272 / 223 every changed pair is flush (parry distance
    // exactly 0 — rafters on sloped space tops, roof on gable walls), where
    // float noise decides "crossing"; see SPEC §4. With opening cuts (T12)
    // window frames sit in their own wall's reveal, which the skip removes.
    // (Uncut, ifc-lite 27 / T10: 261 / 223; ifc-lite 2.1: 253 / 215.)
    let f = fixture("AC20-FZK-Haus.ifc");
    let r = vec![rule("SELF", &f, "*", "*")];
    assert_eq!(run(&r, false).clashes.len(), 257);
    let on = run(&r, true);
    assert_eq!(on.clashes.len(), 208);
    assert!(on.rule_stats[0].skipped_by_relations >= 257 - 208);
}

#[test]
fn test_relations_never_link_two_files() {
    // Two different files: same-file pairs only, so nothing is skipped.
    let hvac = fixture("Building-Hvac.ifc");
    let stru = fixture("Building-Structural.ifc");
    let r = format!(
        r#"{{ "name": "HVACxSTR",
             "a": [{{ "file": {:?}, "selector": "*", "mode": "i" }}],
             "b": [{{ "file": {:?}, "selector": "*", "mode": "i" }}] }}"#,
        hvac.to_string_lossy(),
        stru.to_string_lossy()
    );
    let on = run(&[r.clone()], true);
    let off = run(&[r], false);
    assert_eq!(on.rule_stats[0].skipped_by_relations, 0);
    assert_eq!(on.clashes.len(), off.clashes.len());
}

#[test]
fn test_default_entry_point_skips_related() {
    let f = fixture("AC20-FZK-Haus.ifc");
    let json = format!("[{}]", rule("DOORxWALL", &f, "IfcDoor", "IfcWall*"));
    let r = clash_detect_with_config(&json, 0.0, 0.005, &None, &None).unwrap();
    assert_eq!(r.clashes.len(), 0);
}

#[test]
fn test_load_once_gives_identical_clash_lists() {
    // Cached run (one load, file on both sides of two rules) against the
    // same rules computed from fresh loads per side.
    let f = fixture("AC20-FZK-Haus.ifc");
    let rules = vec![rule("SELF", &f, "*", "*"), rule("DOORxWALL", &f, "IfcDoor", "IfcWall*")];
    let cached = run(&rules, false);

    let mut fresh = Vec::new();
    for (name, a, b) in [("SELF", "*", "*"), ("DOORxWALL", "IfcDoor", "IfcWall*")] {
        let (ga, _) = clash::selector::select_elements(load_ifc_elements(&f).unwrap(), Some(a), None, None);
        let (gb, _) = clash::selector::select_elements(load_ifc_elements(&f).unwrap(), Some(b), None, None);
        let (_, infos, _) = clash_detect_between_groups(&ga, &gb, 0.0, 0.005, &None, &None, name, None).unwrap();
        fresh.extend(infos);
    }
    let key = |c: &clash::bcf_reporter::ClashInfo| {
        (c.guid_a.clone(), c.guid_b.clone(), c.description.clone(), format!("{:?}", c.position))
    };
    assert_eq!(
        cached.clashes.iter().map(key).collect::<Vec<_>>(),
        fresh.iter().map(key).collect::<Vec<_>>()
    );
}
