//! Coordinate-frame warnings and BCF authorship (docs/HOW-IT-WORKS.md#coordinates-and-units).

use clash::bcf_reporter::{BcfTopic, generate_bcf_topics};
use clash::{DetectionResult, clash_detect_with_config};
use std::io::Read;
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join(name);
    p.to_string_lossy().into_owned()
}

/// One rule per `(name, a file, a translation, b file, b translation)`.
fn run(rules: &[(&str, &str, &str, &str, &str)]) -> DetectionResult {
    let side = |file: &str, t: &str| {
        format!(
            r#"[{{ "file": {:?}, "selector": "*", "mode": "i", "translation": {t} }}]"#,
            fixture(file)
        )
    };
    let json: Vec<String> = rules
        .iter()
        .map(|(name, fa, ta, fb, tb)| {
            format!(
                r#"{{ "name": {name:?}, "a": {}, "b": {} }}"#,
                side(fa, ta),
                side(fb, tb)
            )
        })
        .collect();
    clash_detect_with_config(&format!("[{}]", json.join(",")), 0.0, 0.005, &None, &None).unwrap()
}

fn kinds(r: &DetectionResult) -> Vec<&str> {
    r.warnings.iter().map(|w| w.kind.as_str()).collect()
}

const ORIGIN: &str = "[0, 0, 0]";

#[test]
fn test_files_in_separate_rules_are_not_compared() {
    // FZK and HVAC / STR sit apart, but never meet in a rule.
    let r = run(&[
        (
            "FZK",
            "AC20-FZK-Haus.ifc",
            ORIGIN,
            "AC20-FZK-Haus.ifc",
            ORIGIN,
        ),
        (
            "HVACxSTR",
            "Building-Hvac.ifc",
            ORIGIN,
            "Building-Structural.ifc",
            ORIGIN,
        ),
    ]);
    assert!(kinds(&r).is_empty(), "{:?}", r.warnings);
}

#[test]
fn test_files_that_meet_are_still_compared() {
    // Same two models in one rule: far apart, so both warnings fire once.
    let r = run(&[
        (
            "FZKxHVAC",
            "AC20-FZK-Haus.ifc",
            ORIGIN,
            "Building-Hvac.ifc",
            "[500, 0, 0]",
        ),
        (
            "FZK",
            "AC20-FZK-Haus.ifc",
            ORIGIN,
            "AC20-FZK-Haus.ifc",
            ORIGIN,
        ),
    ]);
    assert_eq!(kinds(&r), vec!["placement_mismatch", "no_aabb_overlap"]);
}

#[test]
fn test_bcf_frame_warning_when_every_file_of_a_rule_is_translated() {
    let all = run(&[(
        "MOVED",
        "Building-Hvac.ifc",
        "[1, 0, 0]",
        "Building-Structural.ifc",
        "[1, 0, 0]",
    )]);
    let w = all
        .warnings
        .iter()
        .find(|w| w.kind == "bcf_frame_translated")
        .expect("warning");
    assert!(w.message.contains("MOVED"));

    let one = run(&[(
        "ONE",
        "Building-Hvac.ifc",
        ORIGIN,
        "Building-Structural.ifc",
        "[1, 0, 0]",
    )]);
    assert!(!kinds(&one).contains(&"bcf_frame_translated"));
}

#[test]
fn test_bcf_author_is_clash_tester() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.bcf");
    let topic = BcfTopic {
        title: "1 - Clash between A and B".into(),
        description: String::new(),
        position: [0.0; 3],
        camera_eye: None,
        guids: vec!["A".into(), "B".into()],
    };
    generate_bcf_topics(&path, &[topic]).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut markup = String::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        if f.name().ends_with("markup.bcf") {
            f.read_to_string(&mut markup).unwrap();
        }
    }
    assert!(
        markup.contains("<CreationAuthor>Clash Tester</CreationAuthor>"),
        "{markup}"
    );
    assert!(!markup.contains("Clashero"));
}
