// Derived from Clashero (MIT). See NOTICE.
//! Clash detection between the two sides of one rule: broad phase,
//! self / mirror / relation skips, narrow phase (parry or ifc-lite) and
//! the clash records.

use crate::bcf_reporter::ClashInfo;
use crate::clash_engine::CollisionEngine;
use crate::ifc_adapter::{IfcElement, ordered_pair};
use crate::ifclite_narrow::{
    self, NarrowPhase, Outcome, Verdict, classify, kind_label, record_noun, status_label,
};
use crate::measure::{aabb_match, duplicate_measures};
use crate::{NarrowConfig, RelatedPairs, RuleCounts};
use anyhow::Result;
use parry3d_f64::bounding_volume::BoundingVolume;
use parry3d_f64::math::Pose;
use parry3d_f64::shape::Shape;
use std::collections::HashSet;

/// Whether a hard overlap is deep enough to report: **at least**
/// `min_penetration` metres ("at least 5 mm"). One rule for both narrow
/// phases (parry used `>`, ifc-lite `>=` before).
pub fn deep_enough(depth: f64, min_penetration: f64) -> bool {
    depth >= min_penetration
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
    // loop below only looks verdicts up (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase).
    let ifclite = (narrow.phase == NarrowPhase::Ifclite)
        .then(|| ifclite_narrow::verdicts(group_a, group_b, tolerance));
    let mut clash_count = 0;
    let mut clash_infos = Vec::new();
    let identity = Pose::identity();

    // NOTE: ifc_lite_geometry applies the full IFC placement chain
    // (element → storey → building → site) when generating meshes, and
    // the loader converts them to metres (docs/HOW-IT-WORKS.md#coordinates-and-units). Mesh
    // coordinates are therefore world metres: thresholds, depths, gaps and positions all
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
            // ifc-lite also calls pairs up to its touch band apart touching,
            // so its boxes are widened by that band.
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

            // Pairs that belong together by IFC relations (docs/HOW-IT-WORKS.md#related-elements):
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
