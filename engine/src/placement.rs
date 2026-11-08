//! Where each file sits: per-file bounding boxes, clustering of file
//! positions, and the placement warnings built from them (SPEC §4).

use crate::EngineWarning;
use crate::ifc_adapter::IfcElement;
use parry3d_f64::bounding_volume::{Aabb, BoundingVolume};
use parry3d_f64::math::Pose;
use parry3d_f64::shape::Shape;
use std::collections::HashMap;
use std::path::PathBuf;

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
pub(crate) fn update_file_aabb(
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
