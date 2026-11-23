//! Elements fully inside another (docs/HOW-IT-WORKS.md#elements-fully-inside),
//! and the point-in-mesh test it shares with the opening cuts.
//!
//! A pipe cast completely inside a slab has no surfaces that cross the
//! slab's, so the narrow phases never see it. For a pair they did not
//! report: if one element's box lies within the other's and a vertex of it
//! lies inside the other's closed mesh, it is inside. The approach follows
//! OpenCheck's `containment()` (MIT OR Apache-2.0).

use parry3d_f64::bounding_volume::Aabb;
use parry3d_f64::math::{Pose, Vector as Point};
use parry3d_f64::query::PointQuery;
use parry3d_f64::shape::{Shape, TriMesh};
use std::collections::HashMap;

/// How far a box may stick out of the other and still count as within
/// it (metres) — absorbs rounding where faces are flush.
const BOX_SLACK: f64 = 1e-6;
/// Vertices welded on this grid (metres) when checking that a mesh is
/// closed: IFC meshes often repeat a vertex per face.
const WELD_GRID: f64 = 1e-6;
/// A vertex this close to the outer surface (metres) can't decide inside
/// or outside: the next one is tried.
const ON_SURFACE: f64 = 1e-6;
/// At most this many vertices are tried; all of them on the outer
/// surface means touching, not inside.
const MAX_VERTICES_TRIED: usize = 16;

/// The containment test's answer for one pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Containment {
    /// `a` lies inside `b` (`a_inside_b`) or `b` inside `a`. `depth` is
    /// the inner element's smallest box side, an estimate.
    Inside { a_inside_b: bool, depth: f64 },
    /// The outer candidate's mesh is not closed: never guessed, counted.
    OpenMesh,
    /// Not inside.
    No,
}

/// Is one of the two meshes fully inside the other? Only meaningful for a
/// pair whose surfaces do not cross (the narrow phase said no).
pub fn containment(a: &TriMesh, b: &TriMesh) -> Containment {
    let identity = Pose::identity();
    let (box_a, box_b) = (a.compute_aabb(&identity), b.compute_aabb(&identity));
    let (inner, outer, a_inside_b, inner_box) = if box_within(&box_a, &box_b) {
        (a, b, true, box_a)
    } else if box_within(&box_b, &box_a) {
        (b, a, false, box_b)
    } else {
        return Containment::No;
    };
    if !is_closed(outer) {
        return Containment::OpenMesh;
    }
    if !vertex_inside(inner, outer) {
        return Containment::No;
    }
    let e = inner_box.extents();
    Containment::Inside {
        a_inside_b,
        depth: e.x.min(e.y).min(e.z),
    }
}

/// Does one mesh's box lie within the other's? The cheap first step.
pub(crate) fn one_box_within(a: &TriMesh, b: &TriMesh) -> bool {
    let identity = Pose::identity();
    let (box_a, box_b) = (a.compute_aabb(&identity), b.compute_aabb(&identity));
    box_within(&box_a, &box_b) || box_within(&box_b, &box_a)
}

fn box_within(inner: &Aabb, outer: &Aabb) -> bool {
    (0..3).all(|i| {
        inner.mins[i] >= outer.mins[i] - BOX_SLACK && inner.maxs[i] <= outer.maxs[i] + BOX_SLACK
    })
}

/// Closed = every edge (vertices welded) is shared by exactly two
/// triangles. Ray parity is only meaningful for a closed mesh.
pub fn is_closed(mesh: &TriMesh) -> bool {
    let welded: Vec<[i64; 3]> = mesh
        .vertices()
        .iter()
        .map(|p| [p.x, p.y, p.z].map(|c| (c / WELD_GRID).round() as i64))
        .collect();
    let mut edges: HashMap<([i64; 3], [i64; 3]), u32> = HashMap::new();
    for tri in mesh.indices() {
        for (i, j) in [(0, 1), (1, 2), (2, 0)] {
            let (p, q) = (welded[tri[i] as usize], welded[tri[j] as usize]);
            if p != q {
                *edges
                    .entry(if p < q { (p, q) } else { (q, p) })
                    .or_default() += 1;
            }
        }
    }
    !edges.is_empty() && edges.values().all(|&n| n == 2)
}

/// The first vertex of `inner` that is off `outer`'s surface decides. The
/// surfaces don't cross, so one vertex speaks for the whole element.
fn vertex_inside(inner: &TriMesh, outer: &TriMesh) -> bool {
    inner
        .vertices()
        .iter()
        .take(MAX_VERTICES_TRIED)
        .find(|p| outer.distance_to_local_point(**p, false) > ON_SURFACE)
        .is_some_and(|p| is_inside(outer, *p))
}

/// Point-in-mesh by ray parity, majority of three skew directions so a
/// ray grazing an edge can't decide alone.
pub(crate) fn is_inside(mesh: &TriMesh, p: Point) -> bool {
    const DIRS: [[f64; 3]; 3] = [
        [0.577, 0.578, 0.577],
        [0.267, 0.535, 0.802],
        [-0.707, 0.013, 0.707],
    ];
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
