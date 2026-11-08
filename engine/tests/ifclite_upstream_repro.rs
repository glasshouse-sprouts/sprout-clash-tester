//! Minimal repros of ifc-lite-clash findings to report upstream. They call
//! `ifc_lite_clash::ClashSession` directly, so the code can go into an
//! upstream issue as is. Each test asserts TODAY's (wrong) verdict: it
//! fails once upstream fixes it — then flip the assertion.

use clash::clash_engine::CollisionEngine;
use ifc_lite_clash::{ClashSession, ClashStatus};
use parry3d_f64::math::{Pose, Vector};
use parry3d_f64::shape::TriMesh;

/// A triangle mesh: vertices in metres, triangles as vertex indices.
struct Mesh {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
}

/// Box with `half` extents around `centre`, turned `deg` degrees about Z.
fn turned_box(centre: [f64; 3], half: [f64; 3], deg: f64) -> Mesh {
    let (s, c) = deg.to_radians().sin_cos();
    let vertices = (0..8)
        .map(|i| {
            let l = [
                if i & 1 == 0 { -half[0] } else { half[0] },
                if i & 2 == 0 { -half[1] } else { half[1] },
                if i & 4 == 0 { -half[2] } else { half[2] },
            ];
            [centre[0] + c * l[0] - s * l[1], centre[1] + s * l[0] + c * l[1], centre[2] + l[2]]
        })
        .collect();
    let triangles = vec![
        [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], // z faces
        [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], // y faces
        [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5], // x faces
    ];
    Mesh { vertices, triangles }
}

/// Round duct: an `n`-sided prism of radius `r` along +Y from `y0` to
/// `y1`, axis at height `z`; vertex 0 of each end ring is at x = +r.
fn round_duct(n: u32, r: f64, y0: f64, y1: f64, z: f64) -> Mesh {
    let ring = |y: f64| {
        (0..n).map(move |k| {
            let phi = std::f64::consts::TAU * k as f64 / n as f64;
            [r * phi.cos(), y, z + r * phi.sin()]
        })
    };
    let vertices = ring(y0).chain(ring(y1)).collect();
    let mut triangles = Vec::new();
    for k in 0..n {
        let k1 = (k + 1) % n;
        triangles.extend([[k, k1, n + k], [k1, n + k1, n + k]]);
    }
    for k in 1..n - 1 {
        triangles.extend([[0, k + 1, k], [n, n + k, n + k + 1]]); // end caps
    }
    Mesh { vertices, triangles }
}

/// ifc-lite's verdict on mesh `a` × mesh `b`: hard mode, touch tolerance
/// 0, touches reported.
fn ifclite_status(a: &Mesh, b: &Mesh) -> Option<ClashStatus> {
    let (mut pos, mut pos_ranges, mut idx, mut idx_ranges, mut aabbs) =
        (vec![], vec![], vec![], vec![], vec![]);
    for m in [a, b] {
        let (start, istart) = (pos.len() as u32, idx.len() as u32);
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for v in &m.vertices {
            for k in 0..3 {
                let x = v[k] as f32;
                pos.push(x);
                (lo[k], hi[k]) = (lo[k].min(x), hi[k].max(x));
            }
        }
        idx.extend(m.triangles.iter().flatten());
        pos_ranges.extend([start, pos.len() as u32 - start]);
        idx_ranges.extend([istart, idx.len() as u32 - istart]);
        aabbs.extend(lo.into_iter().chain(hi));
    }
    let mut session = ClashSession::new();
    session.ingest(&pos, &pos_ranges, &idx, &idx_ranges, &aabbs);
    let result = session.run_rule(&[0], Some(&[1]), 0, 0.0, 0.0, true);
    result.records.first().map(|r| r.status)
}

fn parry_crosses(a: &Mesh, b: &Mesh) -> bool {
    let tri = |m: &Mesh| {
        let v = m.vertices.iter().map(|p| Vector::new(p[0], p[1], p[2])).collect();
        TriMesh::new(v, m.triangles.clone()).unwrap()
    };
    let id = Pose::identity();
    CollisionEngine::intersect(&tri(a), &id, &tri(b), &id).unwrap()
}

/// Wall 6 × 0.2 × 3 m turned 30° in plan, and an octagonal duct (Ø 0.2 m)
/// along +Y whose far end reaches `beyond` metres past the wall's back
/// face at its nearest corner (negative = that corner is inside the wall).
fn wall_and_duct(beyond: f64) -> (Mesh, Mesh) {
    let (sin, cos) = 30.0_f64.to_radians().sin_cos();
    let r = 0.1;
    // Back face: n·p = 0.1, n = (-sin 30°, cos 30°). The far-end corner at
    // x = +r is the end's point nearest the wall.
    let y1 = (0.1 + sin * r + beyond) / cos;
    let wall = turned_box([0.0, 0.0, 1.5], [3.0, 0.1, 1.5], 30.0);
    (wall, round_duct(8, r, -0.6, y1, 1.1))
}

/// Finding 1 (seen on 4 pairs in a real Revit housing model). The duct
/// passes clean through the full 0.2 m wall, except that ONE corner of
/// its far end lies 0.3 µm inside the back face (the real Revit cases
/// measured 6e-7 / 3e-7 m). The wall's AABB contains the duct's
/// ("contained" pair); triangles cross (parry agrees). The only duct
/// vertex inside the wall is that corner, below `depth_floor`, so
/// `depth_clash_result`'s mesh-evidence term vetoes the AABB estimate.
/// The duct is not a box on purpose: two boxes take the exact box-MTD
/// path, which ignores the mesh evidence.
/// Expected: Hard. Today: Touch.
#[test]
fn test_floor_gate_vetoes_a_real_piercing_today() {
    let (wall, duct) = wall_and_duct(-3e-7);
    assert!(parry_crosses(&duct, &wall), "the duct really passes through the wall");
    // UPSTREAM BUG: should be Some(ClashStatus::Hard).
    assert_eq!(ifclite_status(&duct, &wall), Some(ClashStatus::Touch), "fixed upstream?");
}

/// Control: the same duct ending 1 mm past the back face (no vertex in
/// the wall) is Hard — the one noise-level vertex is what flips it.
#[test]
fn test_same_piercing_without_the_face_vertex_is_hard() {
    let (wall, duct) = wall_and_duct(0.001);
    assert_eq!(ifclite_status(&duct, &wall), Some(ClashStatus::Hard));
}
