// Derived from Clashero (MIT). See NOTICE.
//! Clash detection between the two sides of one rule: broad phase,
//! self / mirror / relation skips, narrow phase (parry or ifc-lite) and
//! elements fully inside; the records are built in `clash_record`.

use crate::bcf_reporter::ClashInfo;
use crate::clash_engine::CollisionEngine;
use crate::clash_record::{Hit, clash_info};
use crate::containment::{Containment, containment, one_box_within};
use crate::ifc_adapter::{IfcElement, ordered_pair};
use crate::ifclite_narrow::{self, NarrowPhase, Outcome, classify, status_label};
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

/// A pair the narrow phase did not report, as an `inside` clash when one
/// element lies fully inside the other (docs/HOW-IT-WORKS.md#elements-fully-inside). The
/// depth is the inner element's smallest box side; in hard mode it must
/// reach `min_penetration` like any other clash.
fn inside_hit(
    el1: &IfcElement,
    el2: &IfcElement,
    clearance: bool,
    min_penetration: f64,
    counts: &mut RuleCounts,
) -> Option<Hit> {
    match containment(&el1.mesh, &el2.mesh) {
        Containment::Inside { a_inside_b, depth }
            if clearance || deep_enough(depth, min_penetration) =>
        {
            Some(Hit {
                metres: depth,
                status: None,
                kind: None,
                point: None,
                a_inside_b: Some(a_inside_b),
            })
        }
        Containment::OpenMesh => {
            counts.inside_open_mesh += 1;
            None
        }
        _ => None,
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
            let clearance = tolerance > 0.0;
            let inside = |counts: &mut RuleCounts| {
                if narrow.report_inside {
                    inside_hit(el1, el2, clearance, min_penetration, counts)
                } else {
                    None
                }
            };

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
                    if is_clash {
                        Some(Hit {
                            metres: depth_or_gap,
                            status: None,
                            kind: None,
                            point: None,
                            a_inside_b: None,
                        })
                    } else {
                        inside(&mut counts)
                    }
                }
                Some(verdicts) => {
                    let surfaces_cross =
                        || CollisionEngine::intersect(&el1.mesh, &identity, &el2.mesh, &identity);
                    let verdict = verdicts.get(&(ia, ib));
                    let outcome =
                        classify(verdict, tolerance > 0.0, min_penetration, surfaces_cross)?;
                    match outcome {
                        Outcome::Nothing => inside(&mut counts),
                        // ifc-lite calls a closed element inside another a
                        // hard clash; with the option on it is reported as
                        // `inside`, as with parry.
                        Outcome::Clash(v)
                            if narrow.report_inside
                                && one_box_within(&el1.mesh, &el2.mesh)
                                && !CollisionEngine::intersect(
                                    &el1.mesh, &identity, &el2.mesh, &identity,
                                )? =>
                        {
                            inside(&mut counts)
                                .or_else(|| Some(Hit::from_ifclite(&v, status_label(v.status))))
                        }
                        Outcome::Clash(v) => Some(Hit::from_ifclite(&v, status_label(v.status))),
                        Outcome::Touch(v) => {
                            counts.touch += 1;
                            narrow.report_touch.then(|| Hit::from_ifclite(&v, "touch"))
                        }
                        // A box estimate without crossing surfaces is often
                        // an element inside the other.
                        Outcome::Unconfirmed(v) => inside(&mut counts).or_else(|| {
                            counts.unconfirmed += 1;
                            narrow.report_touch.then(|| Hit::from_ifclite(&v, "unconfirmed"))
                        }),
                    }
                }
            };

            if let Some(hit) = hit {
                clash_count += 1;
                clash_infos.push(clash_info(clash_set_name, &hit, el1, el2, clearance));
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
