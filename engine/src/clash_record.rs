// Derived from Clashero (MIT). See NOTICE.
//! The clash record for a pair the narrow phase reported: position,
//! viewpoint, mode, depth or gap, box measures and description.

use crate::bcf_reporter::ClashInfo;
use crate::ifc_adapter::IfcElement;
use crate::ifclite_narrow::{Verdict, kind_label, record_noun};
use crate::measure::{aabb_match, duplicate_measures};
use parry3d_f64::math::Pose;
use parry3d_f64::shape::Shape;

/// A clash the narrow phase found: depth (hard) or gap (clearance) in
/// metres, plus what ifc-lite adds (status, distance kind, contact point).
pub(crate) struct Hit {
    pub metres: f64,
    pub status: Option<&'static str>,
    pub kind: Option<&'static str>,
    pub point: Option<[f64; 3]>,
    /// Set for an element fully inside the other: is A the inner one?
    pub a_inside_b: Option<bool>,
}

impl Hit {
    pub fn from_ifclite(v: &Verdict, status: &'static str) -> Hit {
        Hit {
            metres: v.distance,
            status: Some(status),
            kind: Some(kind_label(v.kind)),
            point: Some(v.point),
            a_inside_b: None,
        }
    }
}

/// The record for one reported pair of rule `rule`. `clearance`: the run
/// is in clearance mode (tolerance > 0).
pub(crate) fn clash_info(
    rule: &str,
    hit: &Hit,
    el1: &IfcElement,
    el2: &IfcElement,
    clearance: bool,
) -> ClashInfo {
    let identity = Pose::identity();
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
    let camera_eye = [world_pos[0] - 5.0, world_pos[1] - 5.0, world_pos[2] + 5.0];

    // AABB-overlap extents + volume, in metres / m³.
    // `intersection_opt` is None when the AABBs don't
    // overlap — only reachable in clearance mode (in
    // intersection mode we'd already have `continue`d).
    let (aabb_extents, aabb_volume) = if let Some(o) = intersection_opt {
        let e = o.extents();
        (Some([e.x, e.y, e.z]), Some(e.x * e.y * e.z))
    } else {
        (None, None)
    };

    let is_inside = hit.a_inside_b.is_some();
    let mode_str = if is_inside {
        "inside"
    } else if clearance {
        "clearance"
    } else {
        "intersection"
    };
    let depth_m = (is_inside || !clearance).then_some(hit.metres);
    let gap_m = (clearance && !is_inside).then_some(hit.metres);

    ClashInfo {
        guid_a: el1.metadata.guid.clone(),
        guid_b: el2.metadata.guid.clone(),
        description: describe(rule, hit, el1, el2),
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
    }
}

/// `[rule] Clash between TYPE (GUID) and TYPE (GUID)`, A before B — the
/// CLI summary reads the types back from this shape. An element inside the
/// other: `[rule] Fully inside between … and …: GUID is inside GUID`.
fn describe(rule: &str, hit: &Hit, el1: &IfcElement, el2: &IfcElement) -> String {
    let name = |e: &IfcElement| format!("{} ({})", e.metadata.ifc_type, e.metadata.guid);
    let pair = format!("between {} and {}", name(el1), name(el2));
    let (g1, g2) = (&el1.metadata.guid, &el2.metadata.guid);
    match hit.a_inside_b {
        Some(true) => format!("[{rule}] Fully inside {pair}: {g1} is inside {g2}"),
        Some(false) => format!("[{rule}] Fully inside {pair}: {g2} is inside {g1}"),
        None => format!("[{rule}] {} {pair}", record_noun(hit.status)),
    }
}
