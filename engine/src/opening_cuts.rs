//! Cutting `IfcRelVoidsElement` openings out of their host elements before
//! clash detection (SPEC §13f). Without the cut a wall with a door hole is
//! meshed as a solid box, and anything standing in the hole is inside it.

use crate::ifc_adapter::{IfcElement, IfcMetadata};
use anyhow::Result;
use ifc_lite_core::DecodedEntity;
use ifc_lite_core::decoder::EntityDecoder;
use ifc_lite_geometry::{BoolFailure, BoolFailureReason, GeometryRouter, Mesh};
use parry3d_f64::math::{Pose, Vector as Point};
use parry3d_f64::bounding_volume::BoundingVolume;
use parry3d_f64::query::intersection_test;
use parry3d_f64::shape::TriMesh;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Host express id → the express ids of its openings.
pub type VoidMap = FxHashMap<u32, Vec<u32>>;

/// What the opening cuts did in one load (or one run, summed).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OpeningCutStats {
    /// Hosts whose openings were cut.
    pub hosts_cut: usize,
    /// Openings subtracted from those hosts.
    pub openings: usize,
    /// GUIDs of hosts whose cut failed; they keep their uncut mesh.
    pub failed: Vec<String>,
    /// GUIDs of openings that removed nothing although their host was cut
    /// without a reported failure (see `check_cuts`). Not in `openings`.
    #[serde(default)]
    pub not_cut: Vec<String>,
    /// GUIDs of hosts that WERE cut, but whose cut mesh is not closed:
    /// ifc-lite's informational "open topology" note (TASKS T17). They
    /// count in `hosts_cut` and keep the cut mesh; `check_cuts` still
    /// verifies each opening.
    #[serde(default)]
    pub open_mesh: Vec<String>,
}

impl OpeningCutStats {
    pub fn add(&mut self, other: &OpeningCutStats) {
        self.hosts_cut += other.hosts_cut;
        self.openings += other.openings;
        self.failed.extend(other.failed.iter().cloned());
        self.not_cut.extend(other.not_cut.iter().cloned());
        self.open_mesh.extend(other.open_mesh.iter().cloned());
    }

    /// The log line every run prints, e.g.
    /// `opening cuts: 12 hosts cut, 30 openings, 0 failed, 0 not cut`,
    /// plus `, 3 with open mesh` when some cut hosts aren't closed.
    pub fn summary_line(&self) -> String {
        let open = match self.open_mesh.len() {
            0 => String::new(),
            n => format!(", {n} with open mesh"),
        };
        format!(
            "opening cuts: {} hosts cut, {} openings, {} failed, {} not cut{open}",
            self.hosts_cut,
            self.openings,
            self.failed.len(),
            self.not_cut.len()
        )
    }
}

/// The hosts to cut: every `(host, opening)` relation whose host has
/// metadata (a product we mesh) and passes `should_cut`.
pub fn void_map(
    voids: &[(u64, u64)],
    metadata: &HashMap<u64, IfcMetadata>,
    should_cut: &dyn Fn(&IfcMetadata) -> bool,
) -> VoidMap {
    let mut map = VoidMap::default();
    for (host, opening) in voids {
        if metadata.get(host).is_some_and(should_cut) {
            map.entry(*host as u32).or_default().push(*opening as u32);
        }
    }
    map
}

/// Mesh one element. A host in `voids` gets its openings cut; when the cut
/// errors, reports a boolean failure or leaves nothing, the host keeps its
/// uncut mesh and its GUID goes into `stats.failed` — never silently. The
/// one exception is ifc-lite's informational open-topology note: the cut
/// was made and returned, only the result isn't closed, so the host keeps
/// its cut mesh and goes into `stats.open_mesh` (TASKS T17).
pub fn mesh_element(
    router: &GeometryRouter,
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
    voids: &VoidMap,
    guid: &str,
    stats: &mut OpeningCutStats,
) -> Result<Mesh> {
    let Some(openings) = voids.get(&element.id) else {
        return Ok(router.process_element(element, decoder)?);
    };
    // Failures recorded by earlier elements must not count against this host.
    router.take_csg_failures();
    let cut = router.process_element_with_voids(element, decoder, voids);
    let failures: Vec<BoolFailure> = router.take_csg_failures().into_values().flatten().collect();
    let failed = failures.iter().any(|f| !is_open_topology_note(f));
    match cut {
        Ok(mesh) if !failed && !mesh.positions.is_empty() => {
            stats.hosts_cut += 1;
            stats.openings += openings.len();
            if !failures.is_empty() {
                stats.open_mesh.push(guid.to_string());
            }
            Ok(mesh)
        }
        _ => {
            stats.failed.push(guid.to_string());
            Ok(router.process_element(element, decoder)?)
        }
    }
}

/// ifc-lite 27's "open topology" record: the boolean result passed its
/// validity check and WAS returned, but failed the closure audit
/// ("informational, non-gating", ifc-lite #3440 step 1). It is a
/// `KernelError` told apart only by its message — the crate's own
/// `OPEN_TOPOLOGY_MESSAGE`, which is crate-private, so we match its
/// prefix. Other `KernelError`s (e.g. a refused polygonal boundary) leave
/// the host uncut and stay failures.
fn is_open_topology_note(f: &BoolFailure) -> bool {
    matches!(&f.reason, BoolFailureReason::KernelError(m) if m.starts_with("open topology:"))
}

/// ifc-lite can skip an opening without reporting a failure. After the
/// cut, an opening is "not cut" when its volume still holds host material
/// (a host triangle centred inside it, more than `tolerance` mesh units
/// from its surface) or when it has no geometry at all. Such openings move
/// from `stats.openings` to `stats.not_cut`; the host keeps its cut mesh,
/// since its other openings are fine. Hosts in `stats.failed` are skipped.
pub fn check_cuts(
    elements: &[IfcElement],
    index_by_id: &HashMap<u32, usize>,
    voids: &VoidMap,
    metadata: &HashMap<u64, IfcMetadata>,
    tolerance: f64,
    stats: &mut OpeningCutStats,
) {
    for (host_id, openings) in voids {
        let Some(host) = index_by_id.get(host_id).map(|&i| &elements[i]) else {
            continue;
        };
        if stats.failed.contains(&host.metadata.guid) {
            continue;
        }
        // Test near the host, not at survey coordinates (millions of
        // metres), where parry's tolerances are too coarse (TASKS T14).
        let centre = host.mesh.local_aabb().center();
        let host_mesh = shifted(&host.mesh, centre);
        for opening_id in openings {
            let cut = match index_by_id.get(opening_id) {
                Some(&i) => {
                    !holds_material(&host_mesh, &shifted(&elements[i].mesh, centre), tolerance)
                }
                None => false,
            };
            if !cut {
                stats.openings = stats.openings.saturating_sub(1);
                let guid = metadata.get(&(*opening_id as u64)).map(|m| m.guid.clone());
                stats.not_cut.push(guid.unwrap_or_else(|| format!("#{opening_id}")));
            }
        }
    }
    stats.not_cut.sort();
}

/// Whether host material is left inside `opening`. The opening is shrunk
/// by `tolerance` first, so reveal faces lying on its surface don't count;
/// then a host face either crosses the shrunk opening or lies inside it.
fn holds_material(host: &TriMesh, opening: &TriMesh, tolerance: f64) -> bool {
    let Some(inner) = shrink(opening, tolerance) else {
        return false; // thinner than the tolerance: nothing to verify
    };
    let bounds = inner.local_aabb();
    if !host.local_aabb().intersects(&bounds) {
        return false;
    }
    let id = Pose::identity();
    if intersection_test(&id, host, &id, &inner).unwrap_or(false) {
        return true;
    }
    let v = host.vertices();
    host.indices().iter().any(|t| {
        let c = (v[t[0] as usize] + v[t[1] as usize] + v[t[2] as usize]) / 3.0;
        bounds.contains_local_point(c) && is_inside(&inner, c)
    })
}

/// `mesh` moved so that `origin` becomes (0, 0, 0).
fn shifted(mesh: &TriMesh, origin: Point) -> TriMesh {
    let vertices = mesh.vertices().iter().map(|v| *v - origin).collect();
    TriMesh::new(vertices, mesh.indices().to_vec()).expect("same triangles as a valid mesh")
}

/// `mesh` scaled about its box centre so its thinnest half-extent loses
/// `by` (every face of a convex opening moves inward at least that much).
/// `None` when the mesh is too thin to shrink.
fn shrink(mesh: &TriMesh, by: f64) -> Option<TriMesh> {
    let bounds = mesh.local_aabb();
    let half = bounds.half_extents();
    let thinnest = half.x.min(half.y).min(half.z);
    if thinnest <= 2.0 * by {
        return None;
    }
    let (c, s) = (bounds.center(), 1.0 - by / thinnest);
    let vertices = mesh.vertices().iter().map(|v| c + (*v - c) * s).collect();
    TriMesh::new(vertices, mesh.indices().to_vec()).ok()
}

/// Point-in-mesh by ray parity, majority of three skew directions so a
/// ray grazing an edge can't decide alone.
fn is_inside(mesh: &TriMesh, p: Point) -> bool {
    const DIRS: [[f64; 3]; 3] =
        [[0.577, 0.578, 0.577], [0.267, 0.535, 0.802], [-0.707, 0.013, 0.707]];
    let odd = DIRS
        .iter()
        .filter(|d| ray_crossings(mesh, p, Point::new(d[0], d[1], d[2])) % 2 == 1)
        .count();
    odd >= 2
}

/// Möller–Trumbore: how many triangles the ray `p + t·d` (t > 0) crosses.
fn ray_crossings(mesh: &TriMesh, p: Point, d: Point) -> usize {
    let v = mesh.vertices();
    mesh.indices()
        .iter()
        .filter(|t| {
            let (p0, p1, p2) = (v[t[0] as usize], v[t[1] as usize], v[t[2] as usize]);
            let (e1, e2) = (p1 - p0, p2 - p0);
            let h = d.cross(e2);
            let a = e1.dot(h);
            if a.abs() < 1e-12 {
                return false;
            }
            let s = p - p0;
            let u = s.dot(h) / a;
            let q = s.cross(e1);
            let w = d.dot(q) / a;
            (0.0..=1.0).contains(&u) && w >= 0.0 && u + w <= 1.0 && e2.dot(q) / a > 1e-9
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_geometry::BoolOp;

    #[test]
    fn only_the_open_topology_note_is_not_a_failure() {
        let kernel = |m: &str| {
            BoolFailure::new(BoolOp::Difference, BoolFailureReason::KernelError(m.into()))
        };
        let note = kernel("open topology: accepted result passed validate_mesh but failed …");
        assert!(is_open_topology_note(&note));
        assert!(!is_open_topology_note(&kernel("IfcPolygonalBoundedHalfSpace refused")));
        let empty = BoolFailure::new(BoolOp::Difference, BoolFailureReason::DifferenceEmptiedHost);
        assert!(!is_open_topology_note(&empty));
    }

    #[test]
    fn summary_line_mentions_open_meshes_only_when_there_are_some() {
        let mut s = OpeningCutStats { hosts_cut: 2, openings: 3, ..Default::default() };
        assert_eq!(s.summary_line(), "opening cuts: 2 hosts cut, 3 openings, 0 failed, 0 not cut");
        s.open_mesh.push("G".into());
        assert!(s.summary_line().ends_with(", 0 not cut, 1 with open mesh"));
    }
}
