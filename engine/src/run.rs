// Derived from Clashero (MIT). See NOTICE.
//! A whole run: parse the rule config, load each file once, select the
//! sides of every rule, detect, and collect the run warnings.

use crate::opening_cuts::OpeningCutStats;
use crate::placement::update_file_aabb;
use crate::rule_detect::clash_detect_rule;
use crate::selector::{select_elements, side_selects};
use crate::{
    ClashSet, DetectOptions, DetectionResult, EngineWarning, RelatedPairs, RuleStat,
    SelectionGroup, frame_warnings, ifc_adapter,
};
use anyhow::Result;
use ifc_adapter::{IfcElement, LoadedIfc, load_ifc_file_cutting};
use parry3d_f64::bounding_volume::Aabb;
use parry3d_f64::math::Vector;
use parry3d_f64::shape::TriMesh;
use std::collections::HashMap;
use std::path::PathBuf;

/// Translate every element's mesh by `[dx, dy, dz]` **metres** by
/// rebuilding the mesh with shifted vertices. Zero translation is
/// short-circuited. Meshes are in metres since load (docs/HOW-IT-WORKS.md#coordinates-and-units),
/// so the translation applies as given, whatever the file's own unit.
///
/// We rebuild the mesh rather than threading a `Pose` through the engine
/// because the broad-phase / narrow-phase code currently assumes identity
/// poses everywhere. Rebuilding keeps the change localised to file
/// loading and avoids touching the collision loop.
fn translate_elements(elements: Vec<IfcElement>, t_metres: [f64; 3]) -> Result<Vec<IfcElement>> {
    if t_metres == [0.0, 0.0, 0.0] {
        return Ok(elements);
    }
    elements
        .into_iter()
        .map(|mut e| {
            let [dx, dy, dz] = t_metres;
            let new_vertices: Vec<Vector> = e
                .mesh
                .vertices()
                .iter()
                .map(|v| Vector::new(v.x + dx, v.y + dy, v.z + dz))
                .collect();
            let new_indices: Vec<[u32; 3]> = e.mesh.indices().to_vec();
            e.mesh = TriMesh::new(new_vertices, new_indices)?;
            Ok(e)
        })
        .collect()
}

/// `clash_detect_with_options` with the default options (relation skip on).
pub fn clash_detect_with_config(
    config_json: &str,
    tolerance: f64,
    min_penetration: f64,
    discipline_a_override: &Option<String>,
    discipline_b_override: &Option<String>,
) -> Result<DetectionResult> {
    clash_detect_with_options(
        config_json,
        tolerance,
        min_penetration,
        discipline_a_override,
        discipline_b_override,
        &DetectOptions::default(),
    )
}

/// The rule sides that read each file. A host's openings are cut only
/// when some side of the run selects that host.
type SidesByFile<'s> = HashMap<&'s PathBuf, Vec<&'s SelectionGroup>>;

fn sides_by_file(sets: &[ClashSet]) -> SidesByFile<'_> {
    let mut map: SidesByFile = HashMap::new();
    for group in sets.iter().flat_map(|s| s.a.iter().chain(&s.b)) {
        map.entry(&group.file).or_default().push(group);
    }
    map
}

/// Load `path` once per run; later sides of any rule reuse it.
fn cached_load<'c>(
    cache: &'c mut HashMap<PathBuf, LoadedIfc>,
    path: &PathBuf,
    sides: &SidesByFile,
    cut_openings: bool,
) -> Result<&'c LoadedIfc> {
    if !cache.contains_key(path) {
        let groups = sides.get(path).map(Vec::as_slice).unwrap_or_default();
        let selected = |m: &ifc_adapter::IfcMetadata| {
            cut_openings
                && groups.iter().any(|g| {
                    side_selects(m, g.selector.as_deref(), g.mode.as_deref(), g.exclude.as_deref())
                })
        };
        let loaded = load_ifc_file_cutting(path, &selected)?;
        cache.insert(path.clone(), loaded);
    }
    Ok(&cache[path])
}

/// Warnings for hosts that kept their uncut mesh and for openings that
/// cut nothing, naming them — clashes against those may be false.
fn opening_cut_warnings(stats: &OpeningCutStats) -> Vec<EngineWarning> {
    let warn = |kind: &str, what: &str, guids: &[String]| EngineWarning {
        kind: kind.to_string(),
        message: format!(
            "{} {what}; clashes against them may be false: {}",
            guids.len(),
            guids.join(", ")
        ),
        files: Vec::new(),
    };
    let mut warnings = Vec::new();
    if !stats.failed.is_empty() {
        let what = "host(s) kept their uncut geometry because cutting their openings failed";
        warnings.push(warn("opening_cut_failed", what, &stats.failed));
    }
    if !stats.not_cut.is_empty() {
        let what = "opening(s) removed nothing from their host";
        warnings.push(warn("opening_not_cut", what, &stats.not_cut));
    }
    if !stats.open_mesh.is_empty() {
        let what =
            "host(s) were cut, but their cut mesh is not closed (ifc-lite open-topology note)";
        warnings.push(EngineWarning {
            kind: "opening_cut_open_mesh".to_string(),
            message: format!("{} {what}: {}", stats.open_mesh.len(), stats.open_mesh.join(", ")),
            files: Vec::new(),
        });
    }
    warnings
}

/// One warning per file with generic MEP elements (`IfcFlowSegment`, …)
/// that have no type object, so no preset can tell a duct from a pipe
/// there (docs/PROJECT-FILE.md#ifc2x3-type-objects).
fn untyped_generic_warnings(cache: &HashMap<PathBuf, LoadedIfc>) -> Vec<EngineWarning> {
    let mut files: Vec<_> = cache.iter().filter(|(_, l)| l.untyped_generic > 0).collect();
    files.sort_by_key(|(path, _)| *path);
    files
        .into_iter()
        .map(|(path, loaded)| {
            let name = path.file_name().map_or(String::new(), |n| n.to_string_lossy().into());
            EngineWarning {
                kind: "untyped_generic_mep".to_string(),
                message: format!(
                    "{}: {} generic MEP element(s) without a type object that says what they \
                     are — presets can't classify them",
                    name, loaded.untyped_generic
                ),
                files: vec![name],
            }
        })
        .collect()
}

pub fn clash_detect_with_options(
    config_json: &str,
    tolerance: f64,
    min_penetration: f64,
    discipline_a_override: &Option<String>,
    discipline_b_override: &Option<String>,
    options: &DetectOptions,
) -> Result<DetectionResult> {
    let clash_sets: Vec<ClashSet> = serde_json::from_str(config_json)?;
    let sides = sides_by_file(&clash_sets);
    let mut all_clash_infos = Vec::new();
    let mut file_aabbs: HashMap<PathBuf, Option<Aabb>> = HashMap::new();
    let mut rule_stats = Vec::new();
    // Each IFC is parsed once per run, however many rule sides use it.
    let mut cache: HashMap<PathBuf, LoadedIfc> = HashMap::new();
    let mut related: RelatedPairs = HashMap::new();

    for set in &clash_sets {
        println!("\n── Rule: {} ─────────────────────────────", set.name);

        let mut group_a_elements = Vec::new();
        for group in &set.a {
            let loaded = cached_load(&mut cache, &group.file, &sides, options.cut_openings)?;
            let elements = loaded.elements.clone();
            if let Some(name) = elements.first().map(|e| e.metadata.source_file.clone()) {
                related.entry(name).or_insert_with(|| loaded.related_pairs.clone());
            }
            let total = elements.len();
            let translation = group.translation.unwrap_or([0.0, 0.0, 0.0]);
            let elements = translate_elements(elements, translation)?;
            let selector_str = group.selector.as_deref().unwrap_or("*");
            let file_name = group.file.file_name()
                .and_then(|n| n.to_str()).unwrap_or("?");

            let (filtered, excluded) = select_elements(
                elements,
                group.selector.as_deref(),
                group.mode.as_deref(),
                group.exclude.as_deref(),
            );
            println!("  Side A  {}  total={} selector='{}' matched={} excluded={}", file_name, total, selector_str, filtered.len(), excluded);
            // Record the file's AABB from the (possibly translated) matched elements.
            update_file_aabb(&mut file_aabbs, &group.file, &filtered);
            group_a_elements.extend(filtered);
        }

        let mut group_b_elements = Vec::new();
        for group in &set.b {
            let loaded = cached_load(&mut cache, &group.file, &sides, options.cut_openings)?;
            let elements = loaded.elements.clone();
            if let Some(name) = elements.first().map(|e| e.metadata.source_file.clone()) {
                related.entry(name).or_insert_with(|| loaded.related_pairs.clone());
            }
            let total = elements.len();
            let translation = group.translation.unwrap_or([0.0, 0.0, 0.0]);
            let elements = translate_elements(elements, translation)?;
            let selector_str = group.selector.as_deref().unwrap_or("*");
            let file_name = group.file.file_name()
                .and_then(|n| n.to_str()).unwrap_or("?");

            let (filtered, excluded) = select_elements(
                elements,
                group.selector.as_deref(),
                group.mode.as_deref(),
                group.exclude.as_deref(),
            );
            println!("  Side B  {}  total={} selector='{}' matched={} excluded={}", file_name, total, selector_str, filtered.len(), excluded);
            update_file_aabb(&mut file_aabbs, &group.file, &filtered);
            group_b_elements.extend(filtered);
        }

        println!("  Checking {} × {} element pairs…", group_a_elements.len(), group_b_elements.len());

        let (_count, infos, counts) = clash_detect_rule(
            &group_a_elements,
            &group_b_elements,
            tolerance,
            min_penetration,
            discipline_a_override,
            discipline_b_override,
            &set.name,
            if options.skip_related { Some(&related) } else { None },
            options.narrow,
        )?;
        println!("  → {} clash(es) found", infos.len());
        all_clash_infos.extend(infos);
        rule_stats.push(RuleStat {
            name: set.name.clone(),
            skipped_by_relations: counts.skipped_by_relations,
            touch_count: counts.touch,
            unconfirmed_count: counts.unconfirmed,
        });
    }

    // Order matters: placement_mismatch first (the broader diagnostic),
    // then no_aabb_overlap (the more extreme symptom), both only between
    // files that meet in a rule. When files are truly disjoint, both
    // fire — and the user sees the bigger picture before the specific
    // symptom.
    let mut opening_cuts = OpeningCutStats::default();
    for loaded in cache.values() {
        opening_cuts.add(&loaded.opening_cuts);
    }
    println!("\n{}", opening_cuts.summary_line());

    let mut warnings = frame_warnings::rule_placement_warnings(&clash_sets, &file_aabbs);
    warnings.extend(frame_warnings::bcf_frame_warnings(&clash_sets));
    warnings.extend(opening_cut_warnings(&opening_cuts));
    warnings.extend(untyped_generic_warnings(&cache));
    // Print warnings to stderr so the CLI surfaces them prominently and
    // the Node runner can capture them by line. Format is stable:
    //     WARNING: <kind>: <message>
    for w in &warnings {
        eprintln!("WARNING: {}: {}", w.kind, w.message);
    }

    Ok(DetectionResult {
        clashes: all_clash_infos,
        warnings,
        rule_stats,
        opening_cuts,
    })
}
