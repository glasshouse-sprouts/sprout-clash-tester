//! Diagnostic probe used during development to inspect what parry3d's
//! `contact()` returns for two overlapping `TriMesh` cubes. The
//! investigation showed that parry3d 0.26 returns `dist = 0.0` for any
//! overlap, which led to the AABB-based approximation now used in
//! `CollisionEngine::penetration_depth` (see `src/clash_engine.rs`).
//!
//! Kept as an empty stub because the host filesystem prevented deleting
//! it. Safe to remove if you re-clone the repo on a normal filesystem.

fn main() {}
