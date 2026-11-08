// Derived from Clashero (MIT). See NOTICE.
pub mod bcf_reporter;
pub mod clash_engine;
mod frame_warnings;
pub mod ifc_adapter;
pub mod ifclite_narrow;
pub mod opening_cuts;
pub mod selector;
pub mod type_objects;

use anyhow::Result;
use bcf_reporter::ClashInfo;
use clash_engine::CollisionEngine;
use ifc_adapter::{IfcElement, LoadedIfc, load_ifc_elements, load_ifc_file_cutting, ordered_pair};
use ifclite_narrow::{
    NarrowPhase, Outcome, Verdict, classify, kind_label, record_noun, status_label,
};
use opening_cuts::OpeningCutStats;
use parry3d_f64::bounding_volume::{Aabb, BoundingVolume};
use parry3d_f64::math::{Pose, Vector};
use parry3d_f64::shape::{Shape, TriMesh};
use selector::{select_elements, side_selects};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct ClashSet {
    pub name: String,
    pub a: Vec<SelectionGroup>,
    pub b: Vec<SelectionGroup>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SelectionGroup {
    pub file: PathBuf,
    pub selector: Option<String>,
    pub mode: Option<String>,
    /// Optional selector (same syntax as `selector`) applied AFTER the
    /// include step; matching elements are dropped. Used e.g. by self
    /// checks to skip IfcSpace / IfcOpeningElement. See SPEC §13b.
    #[serde(default)]
    pub exclude: Option<String>,
    /// Optional `[dx, dy, dz]` translation in metres applied to every
    /// element loaded from `file` before clash detection. Used for edge
    /// cases where the IFCs don't share a coordinate origin. Default =
    /// `None` (no translation). See SPEC.md §4.
    #[serde(default)]
    pub translation: Option<[f64; 3]>,
}

/// Structured warning surfaced by the engine. Currently the only kind is
/// `no_aabb_overlap`, fired when two source files have non-overlapping
/// bounding boxes (a strong hint that the models are misaligned).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineWarning {
    /// Stable machine-readable identifier. Today: `"no_aabb_overlap"`.
    pub kind: String,
    /// Human-readable text. Safe to print to stdout/stderr.
    pub message: String,
    /// File names involved in the warning, basenames only (no full paths).
    pub files: Vec<String>,
}

/// Full result of `clash_detect_with_config`: the clashes themselves plus
/// any structured warnings emitted along the way.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    pub clashes: Vec<ClashInfo>,
    pub warnings: Vec<EngineWarning>,
    /// One entry per rule, in config order (SPEC §13e).
    #[serde(default)]
    pub rule_stats: Vec<RuleStat>,
    /// Openings cut out of their hosts, summed over the run's files
    /// (SPEC §13f).
    #[serde(default)]
    pub opening_cuts: OpeningCutStats,
}

/// Per-rule figures besides the clashes themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleStat {
    pub name: String,
    /// Element pairs skipped because they belong together by IFC
    /// relations (opening in host, door in wall, parts of an assembly).
    pub skipped_by_relations: usize,
    /// ifc-lite narrow phase: touching pairs and unconfirmed box
    /// estimates, not counted as clashes (SPEC §13g). 0 with parry.
    #[serde(default)]
    pub touch_count: usize,
    #[serde(default)]
    pub unconfirmed_count: usize,
}

/// Options for `clash_detect_with_options`.
#[derive(Debug, Clone)]
pub struct DetectOptions {
    /// Skip element pairs that belong together by IFC relations
    /// (SPEC §13e). Default true.
    pub skip_related: bool,
    /// Cut `IfcRelVoidsElement` openings out of their hosts (SPEC §13f).
    /// Default true; off only for side-by-side diagnosis.
    pub cut_openings: bool,
    /// Narrow phase and touch reporting (SPEC §13g). Default parry.
    pub narrow: NarrowConfig,
}

impl Default for DetectOptions {
    fn default() -> Self {
        DetectOptions { skip_related: true, cut_openings: true, narrow: NarrowConfig::default() }
    }
}

/// GUID pairs that belong together, per source file basename. Pairs only
/// apply within one file — relations never link two models.
pub type RelatedPairs = HashMap<String, HashSet<(String, String)>>;

/// Translate every element's mesh by `[dx, dy, dz]` **metres** by
/// rebuilding the mesh with shifted vertices. Zero translation is
/// short-circuited. Meshes are in metres since load (SPEC §4), so the
/// translation applies as given, whatever the file's own unit.
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

/// Merge a single AABB into a running per-file union. Used to compute
/// the bounding box of every IFC referenced by the clash-set so we can
/// emit the "no overlap" sanity warning.
fn merge_aabb(running: &mut Option<Aabb>, next: Aabb) {
    match running {
        None => *running = Some(next),
        // parry3d 0.26: `merge` is in-place; the `BoundingVolume` trait
        // must be in scope (imported at top of this file).
        Some(curr) => curr.merge(&next),
    }
}

/// Update the per-file AABB map by folding in every element in `elements`.
/// World metres, like every mesh since load (SPEC §4), so files in
/// different units compare on equal footing.
fn update_file_aabb(
    file_aabbs: &mut HashMap<PathBuf, Option<Aabb>>,
    file: &PathBuf,
    elements: &[IfcElement],
) {
    let identity = Pose::identity();
    let entry = file_aabbs.entry(file.clone()).or_insert(None);
    for el in elements {
        merge_aabb(entry, el.mesh.compute_aabb(&identity));
    }
}

/// Default tolerance for the post-detection placement-mismatch check.
/// Operates on real AABB centres (i.e. derived from actual geometry),
/// so we can afford tight clustering — 0.5 m matches the algorithm
/// Model Viewer uses (see `docs/coord-frames-and-federation.md`).
/// Tight enough to flag real export-origin mismatches, loose enough to
/// ignore sub-cm float noise from the geometry parser.
const CLUSTER_TOLERANCE_METRES: f64 = 0.5;

/// Looser tolerance for the **pre-detection** quick check (driven by
/// IFCSITE origin alone, not geometry AABBs). IFCSITE origin is not
/// always a reliable proxy for "where the model sits": some Revit
/// exports place IfcSite at the project origin (with geometry placed
/// elsewhere); others put IfcSite at a building corner. Both can sit
/// in the same world space even though their IFCSITE points differ
/// by a few metres.
///
/// 10 m is the empirical threshold that:
///   - Catches the Revit export-origin mismatch case (typically 50+ m
///     apart, often km when Shared Coordinates is involved).
///   - Avoids false positives on small intra-project variation
///     (verified against the test fixtures where IFCSITE origins
///     differ by ~6 m but geometry overlaps fine).
const QUICK_CLUSTER_TOLERANCE_METRES: f64 = 10.0;

/// Returns the centre of an AABB as a 3-component array. The AABB is
/// expected to already be in metres (see `update_file_aabb`).
fn aabb_centre(a: &Aabb) -> [f64; 3] {
    let c = a.center();
    [c.x, c.y, c.z]
}

/// Cluster `(path, position_metres)` pairs by proximity. Two entries
/// belong to the same cluster when all three axes differ by less than
/// `CLUSTER_TOLERANCE_METRES`. Returns one entry per cluster: the file
/// paths in it (insertion order), plus the cluster's running-mean centre.
///
/// Generic over the position source — used both for AABB centres (post-
/// detection check) and for IFCSITE origins (pre-detection quick check).
///
/// Mirrors Model Viewer's federation-detection algorithm. See SPEC.md
/// §4 for the user-facing description and the Model Viewer
/// `docs/coord-frames-and-federation.md` for the longer rationale.
pub fn cluster_origins(
    origins: Vec<(PathBuf, [f64; 3])>,
) -> Vec<(Vec<PathBuf>, [f64; 3])> {
    cluster_origins_with_tolerance(origins, CLUSTER_TOLERANCE_METRES)
}

/// Same as `cluster_origins` but the per-axis tolerance is parameterised.
/// The pre-detection IFCSITE-based check uses a looser value — see
/// `QUICK_CLUSTER_TOLERANCE_METRES` for the rationale.
pub fn cluster_origins_with_tolerance(
    mut origins: Vec<(PathBuf, [f64; 3])>,
    tolerance: f64,
) -> Vec<(Vec<PathBuf>, [f64; 3])> {
    // Deterministic order — same input always produces same cluster IDs.
    origins.sort_by(|(a, _), (b, _)| a.cmp(b));

    let mut clusters: Vec<(Vec<PathBuf>, [f64; 3])> = Vec::new();
    for (path, centre) in origins {
        let mut placed = false;
        for cluster in clusters.iter_mut() {
            let dx = (cluster.1[0] - centre[0]).abs();
            let dy = (cluster.1[1] - centre[1]).abs();
            let dz = (cluster.1[2] - centre[2]).abs();
            if dx < tolerance && dy < tolerance && dz < tolerance {
                cluster.0.push(path.clone());
                // Running-mean centre keeps the cluster's "anchor" stable
                // as more files are absorbed.
                let n = cluster.0.len() as f64;
                cluster.1 = [
                    (cluster.1[0] * (n - 1.0) + centre[0]) / n,
                    (cluster.1[1] * (n - 1.0) + centre[1]) / n,
                    (cluster.1[2] * (n - 1.0) + centre[2]) / n,
                ];
                placed = true;
                break;
            }
        }
        if !placed {
            clusters.push((vec![path], centre));
        }
    }
    clusters
}

/// Adapter: cluster files by AABB centre, used by the post-detection
/// `placement_mismatch` warning.
fn cluster_files_by_centre(
    file_aabbs: &HashMap<PathBuf, Option<Aabb>>,
) -> Vec<(Vec<PathBuf>, [f64; 3])> {
    let origins: Vec<(PathBuf, [f64; 3])> = file_aabbs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|a| (k.clone(), aabb_centre(a))))
        .collect();
    cluster_origins(origins)
}

/// Build a `placement_mismatch_quick` warning describing how the given
/// origins cluster. Returns an empty vec when there's only one cluster.
///
/// Used by `clash check-alignment` to surface the most likely
/// misalignment cause (different Revit "Export Origin" settings)
/// **before** the full detection pass — i.e. the user gets the warning
/// after milliseconds of STEP-text parsing, not after minutes of
/// geometry generation. The post-detection `placement_mismatch` warning
/// still fires as a more thorough confirmation.
pub fn build_quick_placement_warning(
    clusters: &[(Vec<PathBuf>, [f64; 3])],
) -> Vec<EngineWarning> {
    if clusters.len() < 2 {
        return Vec::new();
    }
    let group_descriptions: Vec<String> = clusters
        .iter()
        .enumerate()
        .map(|(i, (paths, centre))| {
            let label: String = if i < 26 {
                ((b'A' + i as u8) as char).to_string()
            } else {
                format!("#{}", i + 1)
            };
            let names: Vec<String> = paths
                .iter()
                .map(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect();
            format!(
                "  group {}: {} (centre ~({:.1}, {:.1}, {:.1}))",
                label,
                names.join(", "),
                centre[0],
                centre[1],
                centre[2]
            )
        })
        .collect();
    let all_files: Vec<String> = clusters
        .iter()
        .flat_map(|(paths, _)| {
            paths.iter().map(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string()
            })
        })
        .collect();
    let message = format!(
        "Files split into {} placement groups by IFCSITE origin (>{:.0} m apart). They likely have different IFC export origins — align them in Model Viewer before clash detection.\n{}",
        clusters.len(),
        QUICK_CLUSTER_TOLERANCE_METRES,
        group_descriptions.join("\n")
    );
    vec![EngineWarning {
        kind: "placement_mismatch_quick".to_string(),
        message,
        files: all_files,
    }]
}

/// Emit a `placement_mismatch` warning when files split into >1 cluster
/// by AABB centre. This catches the common "Revit Export Origin
/// mismatch" case where, for example, ARK files exported in Shared
/// Coordinates land far from MEP/STR files exported in Project Base
/// Point — bounding boxes may still overlap (if the files are large
/// enough), but the geometry doesn't, and clash detection silently
/// returns 0.
pub(crate) fn placement_mismatch_warnings(
    file_aabbs: &HashMap<PathBuf, Option<Aabb>>,
) -> Vec<EngineWarning> {
    let clusters = cluster_files_by_centre(file_aabbs);
    if clusters.len() < 2 {
        return Vec::new();
    }
    let group_descriptions: Vec<String> = clusters
        .iter()
        .enumerate()
        .map(|(i, (paths, centre))| {
            // Group letters A, B, C, ... up to 'Z'. Past 26 groups we
            // fall back to numeric ids — extremely unlikely in practice.
            let label: String = if i < 26 {
                ((b'A' + i as u8) as char).to_string()
            } else {
                format!("#{}", i + 1)
            };
            let names: Vec<String> = paths
                .iter()
                .map(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect();
            format!(
                "  group {}: {} (centre ~({:.1}, {:.1}, {:.1}))",
                label,
                names.join(", "),
                centre[0],
                centre[1],
                centre[2]
            )
        })
        .collect();
    let all_files: Vec<String> = clusters
        .iter()
        .flat_map(|(paths, _)| {
            paths.iter().map(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string()
            })
        })
        .collect();
    let message = format!(
        "Files split into {} placement groups (>{:.1} m apart by AABB centre). They likely have different IFC export origins — align them in Model Viewer before clash detection.\n{}",
        clusters.len(),
        CLUSTER_TOLERANCE_METRES,
        group_descriptions.join("\n")
    );
    vec![EngineWarning {
        kind: "placement_mismatch".to_string(),
        message,
        files: all_files,
    }]
}

/// After all files are loaded, do a pairwise AABB-overlap check between
/// every pair of files. If a pair doesn't overlap **and** both files
/// contributed at least one element, emit a `no_aabb_overlap` warning.
/// Disjoint AABBs almost always mean the models aren't aligned.
///
/// This complements `placement_mismatch_warnings`: that one fires when
/// clusters are >0.5 m apart by centre (may still have overlapping
/// AABBs for large files); this one fires when the AABBs are truly
/// disjoint (the more extreme symptom).
pub(crate) fn aabb_overlap_warnings(file_aabbs: &HashMap<PathBuf, Option<Aabb>>) -> Vec<EngineWarning> {
    // Stable order so warnings are deterministic.
    let mut entries: Vec<(&PathBuf, &Aabb)> = file_aabbs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|a| (k, a)))
        .collect();
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));

    let mut warnings = Vec::new();
    for i in 0..entries.len() {
        for j in (i + 1)..entries.len() {
            let (path_i, aabb_i) = entries[i];
            let (path_j, aabb_j) = entries[j];
            if aabb_i.intersection(aabb_j).is_none() {
                let name_i = path_i
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();
                let name_j = path_j
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();
                warnings.push(EngineWarning {
                    kind: "no_aabb_overlap".to_string(),
                    message: format!(
                        "files {} and {} don't overlap in space — possibly misaligned, clash count may be unreliable",
                        name_i, name_j
                    ),
                    files: vec![name_i, name_j],
                });
            }
        }
    }
    warnings
}

/// `clash_detect_with_options` with the default options (relation skip on).
/// Whether a hard overlap is deep enough to report: **at least**
/// `min_penetration` metres ("at least 5 mm"). One rule for both narrow
/// phases (TASKS T16; parry used `>`, ifc-lite `>=` before).
pub fn deep_enough(depth: f64, min_penetration: f64) -> bool {
    depth >= min_penetration
}

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
/// there (SPEC §6).
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
                    "{}: {} generic MEP element(s) without a type object — \
                     presets can't classify them",
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
    // files that meet in a rule (T14). When files are truly disjoint, both
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

/// How alike two AABBs are, 0..1. Per axis: overlap length divided by the
/// longer of the two lengths (1.0 when both lengths are ~0, so flat
/// elements still compare). The result is the smallest of the three
/// axes — every axis must match for a high score. 1.0 = identical boxes.
/// Unit-free. `None` when the boxes don't overlap.
///
/// Used to flag likely double modelling: two elements whose boxes match
/// at ~1.0 almost certainly occupy the same space.
pub fn aabb_match(a: &Aabb, b: &Aabb) -> Option<f64> {
    let o = a.intersection(b)?;
    let ea = a.extents();
    let eb = b.extents();
    let eo = o.extents();
    let axes = [(ea.x, eb.x, eo.x), (ea.y, eb.y, eo.y), (ea.z, eb.z, eo.z)];
    let mut m: f64 = 1.0;
    for (la, lb, lo) in axes {
        let longer = la.max(lb);
        let ratio = if longer <= 1e-9 { 1.0 } else { (lo / longer).clamp(0.0, 1.0) };
        m = m.min(ratio);
    }
    Some(m)
}

/// Volume and centre of a triangle mesh, in the mesh's own units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeshMeasure {
    /// Volume (mesh units³). 0.0 for flat / degenerate meshes.
    pub volume: f64,
    /// Volume-weighted centre; the plain vertex average when volume is 0.
    pub centroid: [f64; 3],
}

/// Measure a mesh's volume and centre.
///
/// Method: split the mesh into tetrahedra from a reference point (the
/// vertex average) to every triangle and sum their **absolute** volumes.
/// Using absolute values makes the result independent of triangle
/// winding (IFC meshes aren't guaranteed to be consistently wound). It is
/// exact for convex closed meshes; for concave shapes it slightly
/// over-estimates — but always the same way, so two copies of the same
/// element measure identically, which is what duplicate detection needs.
/// Working relative to the vertex average also keeps precision at survey
/// coordinates. `None` for a mesh without vertices.
pub fn mesh_measure(mesh: &TriMesh) -> Option<MeshMeasure> {
    let verts = mesh.vertices();
    if verts.is_empty() {
        return None;
    }
    let n = verts.len() as f64;
    let (mut rx, mut ry, mut rz) = (0.0f64, 0.0f64, 0.0f64);
    for v in verts {
        rx += v.x;
        ry += v.y;
        rz += v.z;
    }
    let r = [rx / n, ry / n, rz / n];
    let rel = |i: u32| -> [f64; 3] {
        let v = &verts[i as usize];
        [v.x - r[0], v.y - r[1], v.z - r[2]]
    };

    let mut volume = 0.0f64;
    let (mut cx, mut cy, mut cz) = (0.0f64, 0.0f64, 0.0f64);
    for tri in mesh.indices() {
        let a = rel(tri[0]);
        let b = rel(tri[1]);
        let c = rel(tri[2]);
        // det = a · (b × c); tetrahedron (r, a, b, c) has volume |det| / 6.
        let det = a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
        let tv = det.abs() / 6.0;
        volume += tv;
        // Tetrahedron centre relative to r = (0 + a + b + c) / 4.
        cx += tv * (a[0] + b[0] + c[0]) / 4.0;
        cy += tv * (a[1] + b[1] + c[1]) / 4.0;
        cz += tv * (a[2] + b[2] + c[2]) / 4.0;
    }
    if volume <= f64::EPSILON {
        return Some(MeshMeasure { volume: 0.0, centroid: r });
    }
    Some(MeshMeasure {
        volume,
        centroid: [r[0] + cx / volume, r[1] + cy / volume, r[2] + cz / volume],
    })
}

/// Per-clash measurements used to spot double modelling, in metres:
/// `(volume_a m³, volume_b m³, centroid_distance m)` (meshes are in metres
/// since load). Volumes are `None` for flat/degenerate meshes.
fn duplicate_measures(el1: &IfcElement, el2: &IfcElement) -> (Option<f64>, Option<f64>, Option<f64>) {
    let m1 = mesh_measure(&el1.mesh);
    let m2 = mesh_measure(&el2.mesh);
    let vol_m3 = |m: Option<MeshMeasure>| m.map(|m| m.volume).filter(|&v| v > 0.0);
    let dist = match (m1, m2) {
        (Some(a), Some(b)) => {
            let dx = a.centroid[0] - b.centroid[0];
            let dy = a.centroid[1] - b.centroid[1];
            let dz = a.centroid[2] - b.centroid[2];
            Some((dx * dx + dy * dy + dz * dz).sqrt())
        }
        _ => None,
    };
    (vol_m3(m1), vol_m3(m2), dist)
}

/// Stable identity of an element across separate loads of the same file:
/// `<file basename>#<GUID>`. `None` when the element has no GUID — such
/// elements are never treated as "the same element".
fn element_identity(el: &IfcElement) -> Option<String> {
    if el.metadata.guid.is_empty() {
        None
    } else {
        Some(format!("{}#{}", el.metadata.source_file, el.metadata.guid))
    }
}

/// `clash_detect_rule` with the parry narrow phase; returns the clash
/// count, the clashes and the pairs skipped by IFC relations.
pub fn clash_detect_between_groups(
    group_a: &[IfcElement],
    group_b: &[IfcElement],
    tolerance: f64,
    min_penetration: f64,
    discipline_a: &Option<String>,
    discipline_b: &Option<String>,
    clash_set_name: &str,
    related: Option<&RelatedPairs>,
) -> Result<(i32, Vec<ClashInfo>, usize)> {
    let (count, infos, counts) = clash_detect_rule(
        group_a,
        group_b,
        tolerance,
        min_penetration,
        discipline_a,
        discipline_b,
        clash_set_name,
        related,
        NarrowConfig::default(),
    )?;
    Ok((count, infos, counts.skipped_by_relations))
}

/// Narrow-phase choice for a run (SPEC §13g).
#[derive(Debug, Clone, Copy, Default)]
pub struct NarrowConfig {
    pub phase: NarrowPhase,
    /// List touching pairs and unconfirmed box estimates as records
    /// (status `"touch"` / `"unconfirmed"`). ifc-lite phase only.
    pub report_touch: bool,
}

/// Per-rule counts besides the clashes themselves.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RuleCounts {
    pub skipped_by_relations: usize,
    /// ifc-lite: pairs whose faces only touch (not clashes).
    pub touch: usize,
    /// ifc-lite: hard by box estimate, no surface crossing (not clashes).
    pub unconfirmed: usize,
}

/// A clash the narrow phase found: depth (hard) or gap (clearance) in
/// metres, plus what ifc-lite adds (status, distance kind, contact point).
struct Hit {
    metres: f64,
    status: Option<&'static str>,
    kind: Option<&'static str>,
    point: Option<[f64; 3]>,
}

impl Hit {
    fn from_ifclite(v: &Verdict, status: &'static str) -> Hit {
        Hit {
            metres: v.distance,
            status: Some(status),
            kind: Some(kind_label(v.kind)),
            point: Some(v.point),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn clash_detect_rule(
    group_a: &[IfcElement],
    group_b: &[IfcElement],
    tolerance: f64,
    min_penetration: f64,
    discipline_a: &Option<String>,
    discipline_b: &Option<String>,
    clash_set_name: &str,
    related: Option<&RelatedPairs>,
    narrow: NarrowConfig,
) -> Result<(i32, Vec<ClashInfo>, RuleCounts)> {
    let mut counts = RuleCounts::default();
    let touch_band = match narrow.phase {
        NarrowPhase::Ifclite => ifclite_narrow::TOUCH_TOLERANCE_METRES,
        NarrowPhase::Parry => 0.0,
    };
    // ifc-lite classifies every candidate pair of the rule in one go; the
    // loop below only looks verdicts up (SPEC §13g).
    let ifclite = (narrow.phase == NarrowPhase::Ifclite)
        .then(|| ifclite_narrow::verdicts(group_a, group_b, tolerance));
    let mut clash_count = 0;
    let mut clash_infos = Vec::new();
    let identity = Pose::identity();

    // NOTE: ifc_lite_geometry applies the full IFC placement chain
    // (element → storey → building → site) when generating meshes, and
    // the loader converts them to metres (SPEC §4). Mesh coordinates are
    // therefore world metres: thresholds, depths, gaps and positions all
    // compare directly. Do NOT add site_origin again — that would
    // double-count it.

    let total_pairs = group_a.len() * group_b.len();
    let mut aabb_candidates = 0usize;

    // Progress prints — give the UI something to display during long
    // runs. We emit at most ~20 lines per rule, never more often than
    // every 1000 pairs. Format is parser-stable: `  progress: N/M pairs`.
    let progress_step: usize = (total_pairs / 20).max(1000);
    let mut pairs_visited: usize = 0;

    // Self-check support. When the same file is on both sides of a rule
    // (a model checked against itself), every element would otherwise be
    // tested against itself and every pair twice (X×Y and Y×X). So:
    //   - skip an element paired with itself (same file + same GUID);
    //   - test each unordered element pair only once per rule.
    // Cross-file rules are unaffected: identities include the file name.
    let mut seen_pairs: HashSet<(String, String)> = HashSet::new();
    let mut skipped_self = 0usize;
    let mut skipped_mirror = 0usize;

    for (ia, el1) in group_a.iter().enumerate() {
        let aabb1 = el1.mesh.compute_aabb(&identity);
        for (ib, el2) in group_b.iter().enumerate() {
            pairs_visited += 1;
            if pairs_visited % progress_step == 0 {
                println!("  progress: {}/{} pairs", pairs_visited, total_pairs);
            }
            // Optional discipline filtering
            if let (Some(da), Some(db)) = (&discipline_a, &discipline_b) {
                let d1 = &el1.metadata.discipline;
                let d2 = &el2.metadata.discipline;
                if !((d1 == da && d2 == db) || (d1 == db && d2 == da)) {
                    continue;
                }
            }

            // ── AABB broad-phase filter ──────────────────────────────────────
            // Skip narrow-phase test when bounding boxes don't overlap.
            // For tolerance > 0 we skip this optimisation (would need AABB expansion).
            // ifc-lite also calls pairs up to its touch band apart touching
            // (TASKS T16), so its boxes are widened by that band.
            let aabb2 = el2.mesh.compute_aabb(&identity);
            if tolerance == 0.0 && aabb1.loosened(touch_band).intersection(&aabb2).is_none() {
                continue;
            }

            // Self / mirror-pair skip (see `seen_pairs` above). Done after
            // the broad phase so the string work only happens for the few
            // pairs whose boxes overlap (in intersection mode).
            if let (Some(id1), Some(id2)) = (element_identity(el1), element_identity(el2)) {
                if id1 == id2 {
                    skipped_self += 1;
                    continue;
                }
                let key = if id1 < id2 { (id1, id2) } else { (id2, id1) };
                if !seen_pairs.insert(key) {
                    skipped_mirror += 1;
                    continue;
                }
            }

            // Pairs that belong together by IFC relations (SPEC §13e):
            // same file only, looked up by GUID pair.
            if let Some(rel) = related {
                let f = &el1.metadata.source_file;
                if *f == el2.metadata.source_file
                    && rel.get(f).is_some_and(|pairs| {
                        pairs.contains(&ordered_pair(&el1.metadata.guid, &el2.metadata.guid))
                    })
                {
                    counts.skipped_by_relations += 1;
                    continue;
                }
            }
            aabb_candidates += 1;

            let hit = match &ifclite {
                // Compute the depth-or-gap once so we can both decide
                // `is_clash` and surface the value in the report.
                None => {
                    let (is_clash, depth_or_gap) = if tolerance > 0.0 {
                        // Clearance mode: flag elements within `tolerance`
                        // metres of each other. `distance` is real-world
                        // accurate (parry returns the true min mesh distance).
                        let dist = CollisionEngine::distance(
                            &el1.mesh, &identity, &el2.mesh, &identity,
                        )?;
                        (dist < tolerance, dist)
                    } else {
                        // Hard intersection mode: only flag genuine volume
                        // overlap. `penetration_depth` returns the AABB-min-
                        // dim proxy (see docstring on that function for why).
                        let depth = CollisionEngine::penetration_depth(
                            &el1.mesh, &identity, &el2.mesh, &identity,
                        )?;
                        (deep_enough(depth, min_penetration), depth)
                    };
                    is_clash.then_some(Hit {
                        metres: depth_or_gap,
                        status: None,
                        kind: None,
                        point: None,
                    })
                }
                Some(verdicts) => {
                    let surfaces_cross =
                        || CollisionEngine::intersect(&el1.mesh, &identity, &el2.mesh, &identity);
                    let verdict = verdicts.get(&(ia, ib));
                    let outcome =
                        classify(verdict, tolerance > 0.0, min_penetration, surfaces_cross)?;
                    match outcome {
                        Outcome::Nothing => None,
                        Outcome::Clash(v) => Some(Hit::from_ifclite(&v, status_label(v.status))),
                        Outcome::Touch(v) => {
                            counts.touch += 1;
                            narrow.report_touch.then(|| Hit::from_ifclite(&v, "touch"))
                        }
                        Outcome::Unconfirmed(v) => {
                            counts.unconfirmed += 1;
                            narrow.report_touch.then(|| Hit::from_ifclite(&v, "unconfirmed"))
                        }
                    }
                }
            };

            if let Some(hit) = hit {
                clash_count += 1;
                let (vol_a, vol_b, centroid_dist) = duplicate_measures(el1, el2);
                let aabb1 = el1.mesh.compute_aabb(&identity);
                let aabb2 = el2.mesh.compute_aabb(&identity);
                let intersection_opt = aabb1.intersection(&aabb2);
                let intersection = intersection_opt.unwrap_or(aabb1);
                let center = intersection.center();
                let pos = [center.x, center.y, center.z];

                // World metres. ifc-lite gives a real contact point — aim there.
                let world_pos = hit.point.unwrap_or(pos);

                // Camera pulled back 5 m diagonally (X-5, Y-5, Z+5) from clash midpoint.
                // Z-up: camera is above and to the side, looking down toward the clash.
                let camera_eye = [
                    world_pos[0] - 5.0,
                    world_pos[1] - 5.0,
                    world_pos[2] + 5.0,
                ];

                // AABB-overlap extents + volume, in metres / m³.
                // `intersection_opt` is None when the AABBs don't
                // overlap — only reachable in clearance mode (in
                // intersection mode we'd already have `continue`d).
                let (aabb_extents, aabb_volume) =
                    if let Some(o) = intersection_opt {
                        let e = o.extents();
                        (Some([e.x, e.y, e.z]), Some(e.x * e.y * e.z))
                    } else {
                        (None, None)
                    };

                let mode_str = if tolerance > 0.0 { "clearance" } else { "intersection" };
                let depth_m = if tolerance > 0.0 { None } else { Some(hit.metres) };
                let gap_m = if tolerance > 0.0 { Some(hit.metres) } else { None };

                clash_infos.push(ClashInfo {
                    guid_a: el1.metadata.guid.clone(),
                    guid_b: el2.metadata.guid.clone(),
                    description: format!(
                        "[{}] {} between {} ({}) and {} ({})",
                        clash_set_name,
                        record_noun(hit.status),
                        el1.metadata.ifc_type,
                        el1.metadata.guid,
                        el2.metadata.ifc_type,
                        el2.metadata.guid
                    ),
                    position: world_pos,
                    camera_eye: Some(camera_eye),
                    file_a: el1.metadata.source_file.clone(),
                    file_b: el2.metadata.source_file.clone(),
                    mode: mode_str.to_string(),
                    depth_metres: depth_m,
                    gap_metres: gap_m,
                    aabb_overlap_extents: aabb_extents,
                    aabb_overlap_volume: aabb_volume,
                    aabb_match: aabb_match(&aabb1, &aabb2),
                    volume_a: vol_a,
                    volume_b: vol_b,
                    centroid_distance: centroid_dist,
                    status: hit.status.map(str::to_string),
                    distance_kind: hit.kind.map(str::to_string),
                    type_class_a: el1.metadata.type_class.clone(),
                    type_class_b: el2.metadata.type_class.clone(),
                    predefined_type_a: el1.metadata.predefined_type.clone(),
                    predefined_type_b: el2.metadata.predefined_type.clone(),
                });
            }
        }
    }

    if skipped_self > 0 || skipped_mirror > 0 {
        println!(
            "  Self check: skipped {} element-vs-itself and {} mirrored pair(s)",
            skipped_self, skipped_mirror
        );
    }
    if related.is_some() {
        println!("  IFC relations: skipped {} pair(s)", counts.skipped_by_relations);
    }

    // ── Broad-phase summary ──────────────────────────────────────────────────
    if tolerance == 0.0 {
        println!(
            "  AABB broad phase: {}/{} pairs passed → {} confirmed clash(es) (min penetration: {}mm)",
            aabb_candidates, total_pairs, clash_count, min_penetration * 1000.0
        );
    } else {
        println!(
            "  Narrow phase ({} pairs, clearance tolerance: {}mm) → {} confirmed clash(es)",
            total_pairs, tolerance * 1000.0, clash_count
        );
    }

    if ifclite.is_some() {
        println!(
            "  ifc-lite narrow phase: {} touching, {} unconfirmed box estimate(s) (not clashes)",
            counts.touch, counts.unconfirmed
        );
    }

    Ok((clash_count, clash_infos, counts))
}

pub fn clash_detect(
    file: &Vec<PathBuf>,
    tolerance: f64,
    min_penetration: f64,
    discipline_a: &Option<String>,
    discipline_b: &Option<String>,
    _selector_a: &Option<String>,
    _selector_b: &Option<String>,
) -> Result<(i32, Vec<ClashInfo>)> {
    let mut all_elements: Vec<IfcElement> = Vec::new();
    for path in file {
        println!("Loading elements from: {:?}", path);
        let elements = load_ifc_elements(path)?;
        println!("Loaded {} elements.", elements.len());
        all_elements.extend(elements);
    }

    // For compatibility with old --file argument, we clash all against all
    // using the broad phase.
    let mut clash_count = 0;
    let mut clash_infos = Vec::new();

    // Broad phase integration
    let mut aabbs = Vec::new();
    let identity = Pose::identity();
    for (idx, el) in all_elements.iter().enumerate() {
        aabbs.push((idx as u32, el.mesh.compute_aabb(&identity)));
    }
    let bvh = CollisionEngine::build_broad_phase(&aabbs);
    let potential_clashes = CollisionEngine::broad_phase_query(&bvh, &aabbs);

    for (i_u32, j_u32) in potential_clashes {
        let i = i_u32 as usize;
        let j = j_u32 as usize;
        let el1 = &all_elements[i];
        let el2 = &all_elements[j];

        // Optional discipline filtering
        if let (Some(da), Some(db)) = (&discipline_a, &discipline_b) {
            let d1 = &el1.metadata.discipline;
            let d2 = &el2.metadata.discipline;
            if !((d1 == da && d2 == db) || (d1 == db && d2 == da)) {
                continue;
            }
        }

        let (is_clash, depth_or_gap) = if tolerance > 0.0 {
            let dist =
                CollisionEngine::distance(&el1.mesh, &identity, &el2.mesh, &identity)?;
            (dist < tolerance, dist)
        } else {
            let depth = CollisionEngine::penetration_depth(
                &el1.mesh, &identity, &el2.mesh, &identity,
            )?;
            (deep_enough(depth, min_penetration), depth)
        };

        if is_clash {
            clash_count += 1;
            let (vol_a, vol_b, centroid_dist) = duplicate_measures(el1, el2);
            let aabb1 = el1.mesh.compute_aabb(&identity);
            let aabb2 = el2.mesh.compute_aabb(&identity);
            let intersection_opt = aabb1.intersection(&aabb2);
            let intersection = intersection_opt.unwrap_or(aabb1);
            let center = intersection.center();
            let pos = [center.x, center.y, center.z];

            // World metres (the loader converts every mesh, SPEC §4).
            let world_pos = pos;
            let camera_eye = [
                world_pos[0] - 5.0,
                world_pos[1] - 5.0,
                world_pos[2] + 5.0,
            ];

            let (aabb_extents, aabb_volume) = if let Some(o) = intersection_opt {
                let e = o.extents();
                (Some([e.x, e.y, e.z]), Some(e.x * e.y * e.z))
            } else {
                (None, None)
            };
            let mode_str = if tolerance > 0.0 { "clearance" } else { "intersection" };
            let depth_m = if tolerance > 0.0 { None } else { Some(depth_or_gap) };
            let gap_m = if tolerance > 0.0 { Some(depth_or_gap) } else { None };

            clash_infos.push(ClashInfo {
                guid_a: el1.metadata.guid.clone(),
                guid_b: el2.metadata.guid.clone(),
                description: format!(
                    "Clash between {} ({}) and {} ({})",
                    el1.metadata.ifc_type,
                    el1.metadata.guid,
                    el2.metadata.ifc_type,
                    el2.metadata.guid
                ),
                position: world_pos,
                camera_eye: Some(camera_eye),
                file_a: el1.metadata.source_file.clone(),
                file_b: el2.metadata.source_file.clone(),
                mode: mode_str.to_string(),
                depth_metres: depth_m,
                gap_metres: gap_m,
                aabb_overlap_extents: aabb_extents,
                aabb_overlap_volume: aabb_volume,
                aabb_match: aabb_match(&aabb1, &aabb2),
                volume_a: vol_a,
                volume_b: vol_b,
                centroid_distance: centroid_dist,
                status: None,
                distance_kind: None,
                type_class_a: el1.metadata.type_class.clone(),
                type_class_b: el2.metadata.type_class.clone(),
                predefined_type_a: el1.metadata.predefined_type.clone(),
                predefined_type_b: el2.metadata.predefined_type.clone(),
            });
        }
    }
    Ok((clash_count, clash_infos))
}
