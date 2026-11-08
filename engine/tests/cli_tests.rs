// Derived from Clashero (MIT). See NOTICE.
use assert_cmd::Command;
use predicates::prelude::*;
use std::path::PathBuf;

#[test]
fn test_cli_help() {
    let mut cmd = Command::cargo_bin("clash").unwrap();
    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Detect clashes between IFC files"));
}

#[test]
fn test_cli_missing_file() {
    let mut cmd = Command::cargo_bin("clash").unwrap();
    cmd.arg("detect")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "the following required arguments were not provided",
        ));
}

#[test]
fn test_cli_bcf_from_topics() {
    let dir = tempfile::tempdir().unwrap();
    let topics = dir.path().join("topics.json");
    let out = dir.path().join("report.bcf");
    std::fs::write(
        &topics,
        r#"[{ "title": "1 - Group", "position": [0, 0, 0], "guids": ["A", "B", "C"] },
            { "title": "2 - Group", "position": [1, 1, 1], "camera_eye": [0, 0, 5], "guids": ["D"] }]"#,
    )
    .unwrap();
    let mut cmd = Command::cargo_bin("clash").unwrap();
    cmd.arg("bcf")
        .arg("--topics")
        .arg(&topics)
        .arg("--output")
        .arg(&out)
        .assert()
        .success()
        .stdout(predicate::str::contains("2 topic(s)"));
    assert!(out.exists());
}

#[test]
fn test_cli_detect_basic() {
    let mut cmd = Command::cargo_bin("clash").unwrap();
    let ifc_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join("AC20-FZK-Haus.ifc");

    cmd.arg("detect")
        .arg("--file")
        .arg(ifc_path)
        .assert()
        .success()
        .stdout(predicate::str::contains("Clash Detection Summary"))
        .stdout(predicate::str::contains("Total Clashes:"));
}

#[test]
fn test_cli_detect_with_tolerance() {
    let mut cmd = Command::cargo_bin("clash").unwrap();
    let ifc_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join("AC20-FZK-Haus.ifc");

    cmd.arg("detect")
        .arg("--file")
        .arg(ifc_path)
        .arg("--tolerance")
        .arg("0.1")
        .assert()
        .success()
        // The engine prints the tolerance in mm with the active mode.
        // 0.1 m = 100 mm; "clearance" identifies the tolerance-based path.
        .stdout(predicate::str::contains("clearance (tolerance: 100 mm)"));
}

#[test]
fn test_cli_detect_with_bcf_output() {
    let mut cmd = Command::cargo_bin("clash").unwrap();
    let ifc_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join("AC20-FZK-Haus.ifc");

    let temp_dir = tempfile::tempdir().unwrap();
    let bcf_path = temp_dir.path().join("report.bcfzip");

    cmd.arg("detect")
        .arg("--file")
        .arg(ifc_path)
        .arg("--output")
        .arg(&bcf_path)
        .assert()
        .success()
        .stdout(predicate::str::contains("Generating BCF report"))
        .stdout(predicate::str::contains(
            "BCF report generated successfully.",
        ));

    assert!(bcf_path.exists());

    // Verify it's a valid zip and contains required files
    let file = std::fs::File::open(&bcf_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    assert!(archive.by_name("bcf.version").is_ok());
    assert!(archive.by_name("project.bcfp").is_ok());
}

#[test]
fn test_cli_detect_with_discipline_filtering() {
    let mut cmd = Command::cargo_bin("clash").unwrap();
    let architecture_ifc = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join("Building-Architecture.ifc");
    let hvac_ifc = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join("Building-Hvac.ifc");

    // Without filtering
    cmd.arg("detect")
        .arg("--file")
        .arg(&architecture_ifc)
        .arg("--file")
        .arg(&hvac_ifc)
        .assert()
        .success()
        .stdout(predicate::str::contains("Total Clashes:"));

    // With filtering
    let mut cmd = Command::cargo_bin("clash").unwrap();
    cmd.arg("detect")
        .arg("--file")
        .arg(&architecture_ifc)
        .arg("--file")
        .arg(&hvac_ifc)
        .arg("--discipline-a")
        .arg("Architectural")
        .arg("--discipline-b")
        .arg("MEP")
        .assert()
        .success()
        .stdout(predicate::str::contains("Total Clashes:"));
}

#[test]
fn test_cli_opening_cuts_in_summary_and_flag() {
    // docs/HOW-IT-WORKS.md#opening-cuts: the summary JSON carries the run's opening cuts, and
    // `--no-opening-cuts` turns them off (diagnosis only).
    let ifc = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/models/opening-cut.ifc");
    let dir = tempfile::tempdir().unwrap();
    let rules = dir.path().join("rules.json");
    std::fs::write(
        &rules,
        format!(
            r#"[{{ "name": "DUCTxWALL",
                  "a": [{{ "file": {f:?}, "selector": "IfcDuctSegment", "mode": "i" }}],
                  "b": [{{ "file": {f:?}, "selector": "IfcWall", "mode": "i" }}] }}]"#,
            f = ifc.to_string_lossy()
        ),
    )
    .unwrap();
    let summary = |extra: &[&str]| {
        let path = dir.path().join("summary.json");
        Command::cargo_bin("clash")
            .unwrap()
            .args(["detect", "--clash-set"])
            .arg(&rules)
            .arg("--summary")
            .arg(&path)
            .args(extra)
            .assert()
            .success()
            .stdout(predicate::str::contains("opening cuts:"));
        let raw = std::fs::read_to_string(&path).unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()
    };

    let cut = summary(&[]);
    assert_eq!(cut["opening_cuts"]["hosts_cut"], 1);
    assert_eq!(cut["opening_cuts"]["openings"], 1);
    assert_eq!(cut["opening_cuts"]["failed"].as_array().unwrap().len(), 0);
    assert_eq!(cut["total_clashes"], 1);

    let uncut = summary(&["--no-opening-cuts"]);
    assert_eq!(uncut["opening_cuts"]["hosts_cut"], 0);
    assert_eq!(uncut["total_clashes"], 2);
}

#[test]
fn test_cli_narrow_phase_ifclite_summary_fields() {
    // docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase: `--narrow-phase ifclite` fills status /
    // distance_kind per clash and touch / unconfirmed counts per rule; a bad value is refused.
    let ifc = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/models/opening-cut.ifc");
    let dir = tempfile::tempdir().unwrap();
    let rules = dir.path().join("rules.json");
    std::fs::write(
        &rules,
        format!(
            r#"[{{ "name": "DUCTxWALL",
                  "a": [{{ "file": {f:?}, "selector": "IfcDuctSegment", "mode": "i" }}],
                  "b": [{{ "file": {f:?}, "selector": "IfcWall", "mode": "i" }}] }}]"#,
            f = ifc.to_string_lossy()
        ),
    )
    .unwrap();
    let path = dir.path().join("summary.json");
    Command::cargo_bin("clash")
        .unwrap()
        .args(["detect", "--narrow-phase", "ifclite", "--clash-set"])
        .arg(&rules)
        .arg("--summary")
        .arg(&path)
        .assert()
        .success()
        .stdout(predicate::str::contains("ifc-lite narrow phase:"));
    let s: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(s["total_clashes"], 1);
    assert_eq!(s["clashes"][0]["status"], "hard");
    // The cut wall is no longer a box, so ifc-lite estimates the depth;
    // it still counts because parry confirms the surfaces cross.
    assert_eq!(s["clashes"][0]["distance_kind"], "estimate");
    assert_eq!(s["clashes"][0]["ifc_type_a"], "IFCDUCTSEGMENT");
    assert_eq!(s["per_rule"][0]["touch_count"], 0);
    assert_eq!(s["per_rule"][0]["unconfirmed_count"], 0);

    Command::cargo_bin("clash")
        .unwrap()
        .args(["detect", "--narrow-phase", "fast", "--clash-set"])
        .arg(&rules)
        .assert()
        .failure()
        .stderr(predicate::str::contains("parry or ifclite"));
}
