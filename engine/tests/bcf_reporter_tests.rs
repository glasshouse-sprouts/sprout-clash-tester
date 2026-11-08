// Derived from Clashero (MIT). See NOTICE.
use clash::bcf_reporter::{BcfTopic, ClashInfo, generate_bcf, generate_bcf_topics};
use std::fs::File;
use std::io::Read;
use tempfile::tempdir;
use zip::ZipArchive;

#[test]
fn test_generate_bcf_valid_zip() {
    let dir = tempdir().unwrap();
    let bcf_path = dir.path().join("test.bcfzip");

    let clashes = vec![
        ClashInfo {
            guid_a: "GUID-A".to_string(),
            guid_b: "GUID-B".to_string(),
            description: "Clash description 1".to_string(),
            position: [1.0, 2.0, 3.0],
            camera_eye: Some([0.0, 0.0, 0.0]),
            file_a: String::new(),
            file_b: String::new(),
            mode: String::new(),
            depth_metres: None,
            gap_metres: None,
            aabb_overlap_extents: None,
            aabb_overlap_volume: None,
            aabb_match: None,
            volume_a: None,
            volume_b: None,
            centroid_distance: None,
            status: None,
            distance_kind: None,
            type_class_a: None,
            type_class_b: None,
            predefined_type_a: None,
            predefined_type_b: None,
        },
        ClashInfo {
            guid_a: "GUID-C".to_string(),
            guid_b: "GUID-D".to_string(),
            description: "Clash description 2".to_string(),
            position: [10.0, 20.0, 30.0],
            camera_eye: None,
            file_a: String::new(),
            file_b: String::new(),
            mode: String::new(),
            depth_metres: None,
            gap_metres: None,
            aabb_overlap_extents: None,
            aabb_overlap_volume: None,
            aabb_match: None,
            volume_a: None,
            volume_b: None,
            centroid_distance: None,
            status: None,
            distance_kind: None,
            type_class_a: None,
            type_class_b: None,
            predefined_type_a: None,
            predefined_type_b: None,
        },
    ];

    generate_bcf(&bcf_path, &clashes).expect("Failed to generate BCF");

    assert!(bcf_path.exists());

    let file = File::open(&bcf_path).unwrap();
    let mut archive = ZipArchive::new(file).expect("Failed to open ZIP archive");

    // Check for bcf.version. The engine emits a full XML document; we just
    // assert the BCF 2.1 version attribute is present.
    {
        let mut version_file = archive.by_name("bcf.version").expect("bcf.version missing");
        let mut version_content = String::new();
        version_file.read_to_string(&mut version_content).unwrap();
        assert!(
            version_content.contains("VersionId=\"2.1\""),
            "bcf.version missing VersionId=\"2.1\": {}",
            version_content
        );
    }

    // Check for project.bcfp. The engine emits the project name inside a
    // <Project> element (with a ProjectId attribute), not in a separate
    // <Name> element. We just assert the project name text is there.
    {
        let mut project_file = archive
            .by_name("project.bcfp")
            .expect("project.bcfp missing");
        let mut project_content = String::new();
        project_file.read_to_string(&mut project_content).unwrap();
        assert!(
            project_content.contains("Clash Detection Project"),
            "project.bcfp missing project name: {}",
            project_content
        );
        assert!(!project_content.contains("<Unit>"));
    }

    // Check for topic folders and their files
    let file_names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();

    // There should be 2 topic folders, each containing markup.bcf and a .bcfv file
    let markup_files: Vec<_> = file_names
        .iter()
        .filter(|n| n.ends_with("markup.bcf"))
        .collect();
    assert_eq!(markup_files.len(), 2);

    let viewpoint_files: Vec<_> = file_names.iter().filter(|n| n.ends_with(".bcfv")).collect();
    assert_eq!(viewpoint_files.len(), 2);

    // Verify content of one markup file
    {
        let mut markup_file = archive.by_name(markup_files[0]).unwrap();
        let mut markup_content = String::new();
        markup_file.read_to_string(&mut markup_content).unwrap();
        assert!(markup_content.contains("TopicStatus=\"Open\""));
        assert!(markup_content.contains("<Title>1 - Clash between "));
    }

    // Topic titles carry the clash's 1-based number, in list order (T2).
    // Topics are written to the zip in list order, so archive order works.
    let titles: Vec<String> = markup_files
        .iter()
        .map(|name| {
            let mut content = String::new();
            archive
                .by_name(name)
                .unwrap()
                .read_to_string(&mut content)
                .unwrap();
            let start = content.find("<Title>").unwrap() + "<Title>".len();
            let end = content.find("</Title>").unwrap();
            content[start..end].to_string()
        })
        .collect();
    assert_eq!(
        titles,
        vec![
            "1 - Clash between GUID-A and GUID-B".to_string(),
            "2 - Clash between GUID-C and GUID-D".to_string(),
        ]
    );
}

/// Read every (markup, viewpoint) pair from a BCF zip, in archive order.
fn read_topics(path: &std::path::Path) -> Vec<(String, String)> {
    let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    names
        .iter()
        .filter(|n| n.ends_with("markup.bcf"))
        .map(|markup| {
            let dir = markup.trim_end_matches("markup.bcf");
            let mut m = String::new();
            archive.by_name(markup).unwrap().read_to_string(&mut m).unwrap();
            let mut v = String::new();
            archive
                .by_name(&format!("{}viewpoint.bcfv", dir))
                .unwrap()
                .read_to_string(&mut v)
                .unwrap();
            (m, v)
        })
        .collect()
}

#[test]
fn test_generate_bcf_topics_many_guids_per_topic() {
    // Per-group export (SPEC §13c): one topic, several elements, a camera
    // chosen by the caller.
    let dir = tempdir().unwrap();
    let bcf_path = dir.path().join("groups.bcf");
    let topics = vec![
        BcfTopic {
            title: "1 - IfcWall 2O2F… clashes with 3 elements".to_string(),
            description: "element\n#1 R: IfcWall × IfcDuct".to_string(),
            position: [10.0, 20.0, 3.0],
            camera_eye: Some([0.0, 10.0, 13.0]),
            guids: vec!["G1".into(), "G2".into(), "G3".into(), "G4".into()],
        },
        BcfTopic {
            title: "2 - Pair".to_string(),
            description: String::new(),
            position: [0.0, 0.0, 0.0],
            camera_eye: None,
            guids: vec!["G5".into(), "G6".into()],
        },
    ];
    generate_bcf_topics(&bcf_path, &topics).unwrap();

    let read = read_topics(&bcf_path);
    assert_eq!(read.len(), 2);

    let (markup, viewpoint) = &read[0];
    assert!(markup.contains("<Title>1 - IfcWall 2O2F… clashes with 3 elements</Title>"));
    // Every GUID is both selected and made visible.
    for g in ["G1", "G2", "G3", "G4"] {
        let needle = format!("<Component IfcGuid=\"{}\"/>", g);
        assert_eq!(viewpoint.matches(&needle).count(), 2, "{} not selected + visible", g);
    }
    assert!(viewpoint.contains("DefaultVisibility=\"false\""));
    // Caller's camera eye is used as-is.
    assert!(viewpoint.contains("<CameraViewPoint><X>0</X><Y>10</Y><Z>13</Z></CameraViewPoint>"));

    // No camera ⇒ the usual 5 m diagonal default.
    let (markup2, viewpoint2) = &read[1];
    assert!(markup2.contains("<Title>2 - Pair</Title>"));
    assert!(viewpoint2.contains("<CameraViewPoint><X>-5</X><Y>-5</Y><Z>5</Z></CameraViewPoint>"));
}

#[test]
fn test_topics_json_round_trip_with_optional_fields() {
    // The `clash bcf --topics` input: description and camera_eye optional.
    let json = r#"[{ "title": "1 - T", "position": [1, 2, 3], "guids": ["A", "B", "C"] }]"#;
    let topics: Vec<BcfTopic> = serde_json::from_str(json).unwrap();
    assert_eq!(topics[0].guids.len(), 3);
    assert!(topics[0].camera_eye.is_none());
    assert_eq!(topics[0].description, "");
}
