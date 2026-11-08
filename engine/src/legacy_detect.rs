//! Older parry-only entry points: the legacy `--file` path (every element
//! of the given files against every other, no rules) and
//! `clash_detect_between_groups`.

use crate::bcf_reporter::ClashInfo;
use crate::clash_engine::CollisionEngine;
use crate::ifc_adapter::{IfcElement, load_ifc_elements};
use crate::measure::{aabb_match, duplicate_measures};
use crate::rule_detect::{clash_detect_rule, deep_enough};
use crate::{NarrowConfig, RelatedPairs};
use anyhow::Result;
use parry3d_f64::math::Pose;
use parry3d_f64::shape::Shape;
use std::path::PathBuf;

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
