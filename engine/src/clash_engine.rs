// Derived from Clashero (MIT). See NOTICE.
use parry3d_f64::bounding_volume::Aabb;
use parry3d_f64::math::Pose;
use parry3d_f64::partitioning::{Bvh, BvhBuildStrategy};
use parry3d_f64::query::{distance, intersection_test};
use parry3d_f64::shape::{Shape, TriMesh};

/// A simple stateless collision engine.
pub struct CollisionEngine;

impl CollisionEngine {
    /// Tests if two meshes intersect.
    pub fn intersect(
        mesh1: &TriMesh,
        iso1: &Pose,
        mesh2: &TriMesh,
        iso2: &Pose,
    ) -> anyhow::Result<bool> {
        Ok(intersection_test(iso1, mesh1, iso2, mesh2)?)
    }

    /// Calculates the minimum distance between two meshes.
    pub fn distance(
        mesh1: &TriMesh,
        iso1: &Pose,
        mesh2: &TriMesh,
        iso2: &Pose,
    ) -> anyhow::Result<f64> {
        Ok(distance(iso1, mesh1, iso2, mesh2)?)
    }

    /// Approximate penetration depth between two meshes (in metres).
    /// Returns 0.0 if the meshes are separated or merely touching;
    /// returns a positive number when the meshes volumetrically overlap.
    ///
    /// ## Why this is an approximation, not the true penetration depth
    ///
    /// parry3d 0.26 does **not** compute true penetration depth for
    /// `TriMesh`-vs-`TriMesh`. Its `contact()` API returns a `Contact`
    /// struct with `dist` set to `0.0` for **any** overlap — deep or
    /// shallow — and the contact point pair is identical (both on the
    /// surface intersection). We verified this empirically: two cubes
    /// translated 0.8 m apart (0.2 m overlap) return `dist = 0.0`
    /// regardless of the `prediction` value.
    ///
    /// To return a meaningful "how deep is the overlap" number we fall
    /// back to a two-step approximation:
    ///
    /// 1. `intersection_test()` confirms genuine volumetric overlap. This
    ///    rules out the case where bounding boxes overlap but the meshes
    ///    themselves do not (e.g. two L-shapes that nest around each
    ///    other without their geometry touching).
    /// 2. The minimum dimension of the AABB-overlap box is used as a
    ///    coarse depth proxy. It correlates monotonically with real
    ///    penetration depth (more overlap → larger AABB overlap), but
    ///    it is **not** the true geometric depth.
    ///
    /// For the downstream use in `clash_detect` — comparing
    /// `depth >= min_penetration` (`deep_enough`) — this is sufficient: we just need
    /// "is the overlap above a threshold, yes or no". For external
    /// callers that need the precise depth, this approximation is
    /// not what they want. Documented as a known limitation.
    pub fn penetration_depth(
        mesh1: &TriMesh,
        iso1: &Pose,
        mesh2: &TriMesh,
        iso2: &Pose,
    ) -> anyhow::Result<f64> {
        if !intersection_test(iso1, mesh1, iso2, mesh2)? {
            return Ok(0.0);
        }
        let aabb1 = mesh1.compute_aabb(iso1);
        let aabb2 = mesh2.compute_aabb(iso2);
        let Some(overlap) = aabb1.intersection(&aabb2) else {
            return Ok(0.0);
        };
        let e = overlap.extents();
        // Smallest axis is a conservative upper-ish bound on the overlap
        // through which one mesh penetrates the other.
        Ok(e.x.min(e.y).min(e.z))
    }

    /// Checks if two meshes are "touching" (distance < threshold, but not interpenetrating).
    pub fn is_touching(
        mesh1: &TriMesh,
        iso1: &Pose,
        mesh2: &TriMesh,
        iso2: &Pose,
        threshold: f64,
    ) -> anyhow::Result<bool> {
        let is_intersecting = Self::intersect(mesh1, iso1, mesh2, iso2)?;
        if is_intersecting {
            return Ok(false);
        }

        let dist = Self::distance(mesh1, iso1, mesh2, iso2)?;
        Ok(dist < threshold)
    }

    /// Builds a Qbvh from a collection of AABBs.
    /// Each AABB is associated with a unique index.
    pub fn build_broad_phase(aabbs: &[(u32, Aabb)]) -> Bvh {
        Bvh::from_iter(
            BvhBuildStrategy::Binned,
            aabbs.iter().map(|(id, aabb)| (*id as usize, *aabb)),
        )
    }

    /// Finds potential clashing pairs using broad-phase filtering.
    /// Returns a list of index pairs that might be clashing.
    pub fn broad_phase_query(bvh: &Bvh, aabbs: &[(u32, Aabb)]) -> Vec<(u32, u32)> {
        let mut potential_clashes = Vec::new();

        for (id1, aabb1) in aabbs {
            for id2 in bvh.intersect_aabb(aabb1) {
                let id2 = id2 as u32;
                if *id1 < id2 {
                    potential_clashes.push((*id1, id2));
                }
            }
        }
        potential_clashes
    }
}
