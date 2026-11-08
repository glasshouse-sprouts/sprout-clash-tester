//! Survey coordinates (docs/HOW-IT-WORKS.md#coordinates-and-units): a model moved to UTM gives the
//! same clashes, opening cuts and (shifted) positions as at the origin. The
//! shifted copies are written here, from the repo fixtures.

use clash::ifclite_narrow::NarrowPhase;
use clash::{DetectOptions, DetectionResult, NarrowConfig, clash_detect_with_options};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::PathBuf;

/// E 725 000 / N 6 175 000 m — a Danish UTM 32N position.
const UTM: [f64; 3] = [725_000.0, 6_175_000.0, 0.0];
const SELF_EXCLUDE: &str = "IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("models")
        .join(name)
}

/// `name` with one placement line replaced, as a temporary `.ifc`.
fn moved(name: &str, from: &str, to: &str) -> tempfile::NamedTempFile {
    let source = std::fs::read_to_string(fixture(name)).unwrap();
    assert!(
        source.contains(from),
        "fixture text changed — update {from}"
    );
    let mut file = tempfile::Builder::new().suffix(".ifc").tempfile().unwrap();
    file.write_all(source.replace(from, to).as_bytes()).unwrap();
    file
}

fn run(file: &str, a: &str, b: &str, exclude: &str, phase: NarrowPhase) -> DetectionResult {
    let side = |sel: &str| {
        format!(
            r#"[{{ "file": {file:?}, "selector": {sel:?}, "mode": "i", "exclude": {exclude:?} }}]"#
        )
    };
    let config = format!(r#"[{{ "name": "R", "a": {}, "b": {} }}]"#, side(a), side(b));
    let narrow = NarrowConfig {
        phase,
        report_touch: true,
    };
    let options = DetectOptions {
        narrow,
        ..Default::default()
    };
    clash_detect_with_options(&config, 0.0, 0.005, &None, &None, &options).unwrap()
}

type Pair = (String, String);

/// Pair → (status, position), touches included (report_touch).
fn by_pair(r: &DetectionResult) -> BTreeMap<Pair, (String, [f64; 3])> {
    r.clashes
        .iter()
        .map(|c| {
            let mut k = [c.guid_a.clone(), c.guid_b.clone()];
            k.sort();
            let [x, y] = k;
            (
                (x, y),
                (
                    c.status.clone().unwrap_or_else(|| "hard".into()),
                    c.position,
                ),
            )
        })
        .collect()
}

fn hard(m: &BTreeMap<Pair, (String, [f64; 3])>) -> BTreeSet<Pair> {
    m.iter()
        .filter(|(_, (s, _))| s == "hard")
        .map(|(k, _)| k.clone())
        .collect()
}

/// Same pairs and positions within 1 mm after removing `shift`.
fn assert_same_positions(
    near: &BTreeMap<Pair, (String, [f64; 3])>,
    far: &BTreeMap<Pair, (String, [f64; 3])>,
    shift: [f64; 3],
) {
    for (k, (_, p)) in near {
        let Some((_, q)) = far.get(k) else { continue };
        for i in 0..3 {
            assert!(
                (q[i] - shift[i] - p[i]).abs() < 1e-3,
                "{k:?} axis {i}: {} vs {}",
                q[i] - shift[i],
                p[i]
            );
        }
    }
}

#[test]
fn test_fzk_at_utm_matches_the_origin() {
    // FZK-Haus with only its IfcSite placement moved to UTM.
    let far = moved(
        "AC20-FZK-Haus.ifc",
        "#114= IFCAXIS2PLACEMENT3D(#112,#110,#108);",
        concat!(
            "#114= IFCAXIS2PLACEMENT3D(#999112,#110,#108);\n",
            "#999112= IFCCARTESIANPOINT((725000.,6175000.,0.));",
        ),
    );
    let (near_path, far_path) = (
        fixture("AC20-FZK-Haus.ifc").to_string_lossy().into_owned(),
        far.path().to_string_lossy().into_owned(),
    );

    // ifc-lite: the hard clashes are identical. (Its contact point averages
    // the triangles that count as crossing, so on pairs with flush parts it
    // moves by centimetres with float noise anywhere — measured up to 45 mm
    // — and is not compared here.)
    let near_il = by_pair(&run(
        &near_path,
        "*",
        "*",
        SELF_EXCLUDE,
        NarrowPhase::Ifclite,
    ));
    let far_il = by_pair(&run(
        &far_path,
        "*",
        "*",
        SELF_EXCLUDE,
        NarrowPhase::Ifclite,
    ));
    assert_eq!(hard(&near_il), hard(&far_il));
    assert!(hard(&near_il).len() > 100);

    // parry: same opening cuts and positions; its verdicts may differ only on
    // pairs whose faces are flush (ifc-lite: touch), where float noise of any
    // size decides whether surfaces "cross".
    let near = run(&near_path, "*", "*", SELF_EXCLUDE, NarrowPhase::Parry);
    let far = run(&far_path, "*", "*", SELF_EXCLUDE, NarrowPhase::Parry);
    assert_eq!(near.opening_cuts, far.opening_cuts);
    assert!(near.opening_cuts.not_cut.is_empty() && near.opening_cuts.failed.is_empty());
    let (np, fp) = (by_pair(&near), by_pair(&far));
    assert_same_positions(&np, &fp, UTM);
    let differ: BTreeSet<Pair> = np
        .keys()
        .filter(|k| !fp.contains_key(*k))
        .chain(fp.keys().filter(|k| !np.contains_key(*k)))
        .cloned()
        .collect();
    for k in &differ {
        let status = near_il
            .get(k)
            .or_else(|| far_il.get(k))
            .map(|(s, _)| s.as_str());
        assert_eq!(
            status,
            Some("touch"),
            "{k:?} differs between origin and UTM but is not flush"
        );
    }
    assert!(
        differ.len() <= 4,
        "only a few flush pairs may flip: {differ:?}"
    );
}

#[test]
fn test_mm_model_at_utm_matches_the_origin() {
    // units-mm.ifc (millimetres) with its one placement moved to UTM (×1000).
    let far = moved(
        "units-mm.ifc",
        "#7=IFCLOCALPLACEMENT($,#4);",
        concat!(
            "#7=IFCLOCALPLACEMENT($,#9004);\n",
            "#9003=IFCCARTESIANPOINT((725000000.,6175000000.,0.));\n",
            "#9004=IFCAXIS2PLACEMENT3D(#9003,$,$);",
        ),
    );
    let near_path = fixture("units-mm.ifc").to_string_lossy().into_owned();
    let far_path = far.path().to_string_lossy().into_owned();
    // Box × box only here, so ifc-lite's contact points are exact too.
    for phase in [NarrowPhase::Parry, NarrowPhase::Ifclite] {
        let near = run(&near_path, "IfcDuctSegment", "IfcSlab", "", phase);
        let far = run(&far_path, "IfcDuctSegment", "IfcSlab", "", phase);
        let (np, fp) = (by_pair(&near), by_pair(&far));
        assert_eq!(
            np.keys().collect::<Vec<_>>(),
            fp.keys().collect::<Vec<_>>(),
            "{phase:?}"
        );
        assert_eq!(hard(&np).len(), 1, "{phase:?}: only the 20 mm duct");
        assert_same_positions(&np, &fp, UTM);
        let depth = |r: &DetectionResult| {
            r.clashes
                .iter()
                .filter_map(|c| c.depth_metres)
                .fold(0.0, f64::max)
        };
        assert!((depth(&near) - depth(&far)).abs() < 1e-3, "{phase:?}");
    }
}
