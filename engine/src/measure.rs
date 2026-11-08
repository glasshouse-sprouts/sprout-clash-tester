// Derived from Clashero (MIT). See NOTICE.
//! Geometry measurements per clash: bounding-box similarity and mesh
//! volume / centre, used to spot double modelling (docs/HOW-IT-WORKS.md#double-modelling).

use crate::ifc_adapter::IfcElement;
use parry3d_f64::bounding_volume::Aabb;
use parry3d_f64::shape::TriMesh;

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
pub(crate) fn duplicate_measures(el1: &IfcElement, el2: &IfcElement) -> (Option<f64>, Option<f64>, Option<f64>) {
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
